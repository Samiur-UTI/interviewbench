"""Runs a task's shell scripts (test.sh, solve.sh, the candidate-tests command) the way Harbor does.

Scripts only see four folders, always through these variables (defaults are Harbor's paths):

    APP_DIR=/app   TESTS_DIR=/tests   SOLUTION_DIR=/solution   LOGS_DIR=/logs/verifier

- DockerRunner builds the task's environment/Dockerfile and runs the script in a fresh,
  network-less container, copying the folders in and out. Same result on every machine and for
  every language; this is what Harbor does.
- LocalRunner runs the script with bash on this machine, pointing the variables at temp folders.
  Fast and needs no Docker, but the task's toolchain (e.g. Python + pytest) must be installed.
  TEMP/TMP/TMPDIR point at a folder of the run's own, deleted afterwards, so temp files the
  tests forget to remove don't pile up in the user's temp folder. Secret-looking variables
  (see is_secret_name) are left out of the scripts' environment.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .tasks import Task

RUNNERS = ("auto", "docker", "local")
CONTAINER_PATHS = {
    "app": "/app",
    "tests": "/tests",
    "solution": "/solution",
    "logs": "/logs/verifier",
}
_ENV_NAMES = {"app": "APP_DIR", "tests": "TESTS_DIR", "solution": "SOLUTION_DIR", "logs": "LOGS_DIR"}


class RunnerError(Exception):
    pass


@dataclass
class Sandbox:
    """Host folders for one script run. `app` and `logs` are copied back out after the run.

    `temp` is where LocalRunner points TEMP/TMP/TMPDIR; it is emptied and removed after each run.
    Put it inside the sandbox's own temp folder; without one, the run makes and removes its own.
    """

    app: Path
    logs: Path
    tests: Path | None = None
    solution: Path | None = None
    temp: Path | None = None

    def folders(self) -> dict[str, Path]:
        found = {"app": self.app, "logs": self.logs, "tests": self.tests, "solution": self.solution}
        return {k: v for k, v in found.items() if v is not None}


@dataclass
class Completed:
    returncode: int
    output: str
    timed_out: bool = False


@dataclass
class Runner:
    name: str = field(init=False, default="")

    def run(self, task: Task, command: str, sandbox: Sandbox, timeout: int) -> Completed:
        raise NotImplementedError


# --- Local ----------------------------------------------------------------------------------

_SECRET_NAME = re.compile(
    r"API_?KEY|TOKEN|SECRET|PASSW(OR)?D|_PWD$|CREDENTIAL|PRIVATE_KEY|_AUTH$|ASKPASS|CONNECTION_STRING|_DSN$"
    r"|(DATABASE|DB|POSTGRES(QL)?|PG|MYSQL|MONGO|REDIS|AMQP|BROKER)_UR[IL]$"
    r"|^(AWS|AZURE|ANTHROPIC|OPENAI|IB_JUDGE|GH|GITHUB|VSCODE_GIT)_|^SSH_AUTH_SOCK$",
    re.IGNORECASE,
)


def is_secret_name(name: str) -> bool:
    """Whether LocalRunner keeps this environment variable from task scripts, and so from the
    candidate's code: API keys, tokens, passwords, cloud credentials, connection strings, credential
    helpers. A denylist by name, because toolchains (Windows ones especially) need much of the rest."""
    return bool(_SECRET_NAME.search(name))


def find_bash() -> str | None:
    """bash, avoiding Windows' System32 bash.exe (WSL), which can't see Windows paths."""
    override = os.environ.get("IB_BASH")
    if override:
        return override if shutil.which(override) else None  # LocalRunner says what's wrong
    if sys.platform != "win32":
        return shutil.which("bash")
    git = shutil.which("git")
    if git:
        for candidate in (Path(git).parents[1] / "bin" / "bash.exe", Path(git).parent / "bash.exe"):
            if candidate.is_file():
                return str(candidate)
    found = shutil.which("bash")
    if found and "system32" not in found.lower():
        return found
    return None


@dataclass
class LocalRunner(Runner):
    bash: str = ""

    def __post_init__(self) -> None:
        self.name = "local"
        self.bash = self.bash or find_bash() or ""
        override = os.environ.get("IB_BASH")
        if not self.bash and override:
            raise RunnerError(f"IB_BASH is set to {override}, but that path doesn't exist. Point it at bash or unset it.")
        if not self.bash:
            raise RunnerError(
                "The local runner needs bash (on Windows, install Git for Windows or set IB_BASH). "
                "Or use --runner docker."
            )

    def run(self, task: Task, command: str, sandbox: Sandbox, timeout: int) -> Completed:
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH" and not is_secret_name(k)}
        env.update({_ENV_NAMES[k]: p.resolve().as_posix() for k, p in sandbox.folders().items()})
        # Convenience for Python tasks: use the interpreter running ib (it has pytest installed).
        env.setdefault("PYTHON", Path(sys.executable).as_posix())
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        sandbox.logs.mkdir(parents=True, exist_ok=True)
        if sandbox.temp is not None:
            temp = sandbox.temp
            temp.mkdir(parents=True, exist_ok=True)
        else:
            temp = Path(tempfile.mkdtemp(prefix="ib-tmp-"))
        # The native path form: Git Bash converts TEMP/TMP/TMPDIR to /c/... for itself and back
        # for the programs it starts, so bash's mktemp, Node's os.tmpdir() and Python's tempfile
        # all land here.
        native = str(temp.resolve())
        env.update(TEMP=native, TMP=native, TMPDIR=native)
        try:
            return _run_tree([self.bash, "-c", command], sandbox.app, env, timeout)
        finally:
            remove_tree(temp)


def _run_tree(args: list[str], cwd: Path, env: dict[str, str], timeout: int) -> Completed:
    """subprocess.run, but a timeout (or Ctrl-C) kills the script's whole process tree.

    Killing only bash leaves its children (pytest, node) running, holding files in the sandbox
    open so it can't be deleted, and on Windows the output pipes stay open, so waiting for the
    output blocks until they exit on their own.
    """
    group = {} if os.name == "nt" else {"start_new_session": True}
    with subprocess.Popen(
        args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", **group,
    ) as proc:
        job = _WindowsJob(proc.pid) if os.name == "nt" else None
        try:
            try:
                out, err = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                _kill_tree(proc, job)
                try:
                    out, err = proc.communicate(timeout=10)
                except subprocess.TimeoutExpired:  # something outside the tree still holds the pipes
                    out, err = _text(exc.stdout), _text(exc.stderr)
                return Completed(-1, (out or "") + (err or ""), timed_out=True)
            except BaseException:
                _kill_tree(proc, job)
                raise
            return Completed(proc.returncode, out + err)
        finally:
            if job is not None:
                job.close()  # also ends anything the script left running in the background


def _kill_tree(proc: subprocess.Popen, job: _WindowsJob | None) -> None:
    if job is not None:
        job.terminate()
    elif os.name != "nt":
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
    proc.kill()


class _WindowsJob:
    """A Windows job object holding a process and everything it starts.

    Windows has no process groups, and `taskkill /T` follows parent ids, which Git Bash's
    emulated fork() breaks: node started from a bash script isn't a "child" of that bash. Every
    process a job member creates joins the job, though, so terminating the job kills them all.
    Closing it does too (KILL_ON_JOB_CLOSE), even if ib itself is killed. bash joins just after
    it starts, well before its startup gets to running the script. If anything fails, the job
    is skipped and only bash is killed, as before.
    """

    def __init__(self, pid: int) -> None:
        import ctypes
        from ctypes import wintypes

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                "reads", "writes", "others", "read_bytes", "write_bytes", "other_bytes")]

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        kernel32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        self._kernel32 = kernel32
        self._handle = None
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        process = kernel32.OpenProcess(0x0100 | 0x0001, False, pid)  # PROCESS_SET_QUOTA | TERMINATE
        ok = bool(process) and kernel32.SetInformationJobObject(
            job, 9, ctypes.byref(limits), ctypes.sizeof(limits)  # JobObjectExtendedLimitInformation
        ) and kernel32.AssignProcessToJobObject(job, process)
        if process:
            kernel32.CloseHandle(process)
        if ok:
            self._handle = job
        else:
            kernel32.CloseHandle(job)

    def terminate(self) -> None:
        if self._handle:
            self._kernel32.TerminateJobObject(self._handle, 1)

    def close(self) -> None:
        if self._handle:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


def remove_tree(path: Path, attempts: int = 5) -> bool:
    """Delete a folder, clearing read-only bits and retrying files Windows briefly keeps locked
    (a process that just exited, an antivirus scan). Never raises; False if something is left."""

    def clear_and_retry(func, target, _exc) -> None:
        try:
            os.chmod(target, stat.S_IWRITE)
            func(target)
        except OSError:
            pass

    handler = {"onexc": clear_and_retry} if sys.version_info >= (3, 12) else {"onerror": clear_and_retry}
    for attempt in range(attempts):
        shutil.rmtree(path, **handler)
        if not os.path.lexists(path):
            return True
        time.sleep(0.1 * 2**attempt)
    return False


# --- Docker ---------------------------------------------------------------------------------


def docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=15).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


DOCKER_TIMEOUT = 300  # seconds, for docker calls other than the build and the script run


def _docker(
    *args: str, timeout: int = DOCKER_TIMEOUT, check: bool = True, timeout_error: bool = True
) -> subprocess.CompletedProcess:
    """Run docker. Taking longer than `timeout` is a RunnerError, unless `timeout_error` is False."""
    try:
        proc = subprocess.run(
            ["docker", *args], stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        if not timeout_error:
            raise
        raise RunnerError(
            f"docker {args[0]} didn't finish within {timeout} seconds. Check that Docker is responding, then try again."
        ) from None
    if check and proc.returncode != 0:
        raise RunnerError(f"docker {args[0]} failed:\n{_tail(proc.stdout + proc.stderr)}")
    return proc


def environment_hash(environment_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(p for p in environment_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(environment_dir).as_posix()
        if "__pycache__" in rel or rel.endswith(".pyc"):
            continue
        digest.update(rel.encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()[:12]


@dataclass
class DockerRunner(Runner):
    build_timeout: int = 900
    _images: dict[str, str] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self.name = "docker"
        if not docker_available():
            raise RunnerError("Docker is not available. Start Docker, or use --runner local.")

    def image(self, task: Task) -> str:
        """Build (or reuse) the task image. The tag changes whenever environment/ changes."""
        if task.id not in self._images:
            tag = f"interviewbench/{task.id}:{environment_hash(task.environment_dir)}"
            if _docker("image", "inspect", tag, check=False).returncode != 0:
                _docker("build", "-t", tag, str(task.environment_dir), timeout=self.build_timeout)
            self._images[task.id] = tag
        return self._images[task.id]

    def run(self, task: Task, command: str, sandbox: Sandbox, timeout: int) -> Completed:
        name = f"ib-{task.id}-{uuid.uuid4().hex[:8]}"
        limits = []
        if task.cpus:
            limits += ["--cpus", str(task.cpus)]
        if task.memory_mb:
            limits += ["--memory", f"{task.memory_mb}m"]
        folders = sandbox.folders()
        env = [f"--env={_ENV_NAMES[k]}={CONTAINER_PATHS[k]}" for k in folders]
        # `docker cp` rather than bind mounts: no host-path quirks, and files installed in the
        # image (dependencies, build output) stay unless the sandbox replaces them.
        _docker(
            "create", "--name", name, "--network", "none", "-w", CONTAINER_PATHS["app"], *env, *limits,
            self.image(task), "bash", "-c",
            f"mkdir -p {' '.join(CONTAINER_PATHS[k] for k in folders)} && {command}",
        )
        try:
            for key, host in folders.items():
                if key != "logs":
                    _docker("cp", f"{host}/.", f"{name}:{CONTAINER_PATHS[key]}")
            try:
                proc = _docker("start", "-a", name, timeout=timeout, check=False, timeout_error=False)
                result = Completed(proc.returncode, proc.stdout + proc.stderr)
            except subprocess.TimeoutExpired as exc:
                _docker("kill", name, check=False)
                result = Completed(-1, _text(exc.stdout) + _text(exc.stderr), timed_out=True)
            for key in ("app", "logs"):
                _copy_out(name, CONTAINER_PATHS[key], folders[key])
            return result
        finally:
            _docker("rm", "-f", name, check=False)


def _copy_out(container: str, source: str, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Fails only if the folder doesn't exist in the container (e.g. the script never wrote logs).
    if _docker("cp", f"{container}:{source}", str(dest), check=False).returncode != 0:
        dest.mkdir(parents=True, exist_ok=True)


# --- Selection ------------------------------------------------------------------------------


def get_runner(kind: str = "auto") -> Runner:
    if kind not in RUNNERS:
        raise RunnerError(f"Unknown runner '{kind}'; expected one of {RUNNERS}")
    if kind == "docker" or (kind == "auto" and docker_available()):
        return DockerRunner()
    return LocalRunner()


def _text(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value or ""


def _tail(text: str, lines: int = 15) -> str:
    return "\n".join(text.strip().splitlines()[-lines:]) or "(no output)"
