"""Runs a task's shell scripts (test.sh, solve.sh, the candidate-tests command) the way Harbor does.

Scripts only see four folders, always through these variables (defaults are Harbor's paths):

    APP_DIR=/app   TESTS_DIR=/tests   SOLUTION_DIR=/solution   LOGS_DIR=/logs/verifier

- DockerRunner builds the task's environment/Dockerfile and runs the script in a fresh,
  network-less container, copying the folders in and out. Same result on every machine and for
  every language; this is what Harbor does.
- LocalRunner runs the script with bash on this machine, pointing the variables at temp folders.
  Fast and needs no Docker, but the task's toolchain (e.g. Python + pytest) must be installed.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
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
    """Host folders for one script run. `app` and `logs` are copied back out after the run."""

    app: Path
    logs: Path
    tests: Path | None = None
    solution: Path | None = None

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


def find_bash() -> str | None:
    """bash, avoiding Windows' System32 bash.exe (WSL), which can't see Windows paths."""
    override = os.environ.get("IB_BASH")
    if override:
        return override
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
        if not self.bash:
            raise RunnerError(
                "The local runner needs bash (on Windows, install Git for Windows or set IB_BASH). "
                "Or use --runner docker."
            )

    def run(self, task: Task, command: str, sandbox: Sandbox, timeout: int) -> Completed:
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        env.update({_ENV_NAMES[k]: p.resolve().as_posix() for k, p in sandbox.folders().items()})
        # Convenience for Python tasks: use the interpreter running ib (it has pytest installed).
        env.setdefault("PYTHON", Path(sys.executable).as_posix())
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        sandbox.logs.mkdir(parents=True, exist_ok=True)
        try:
            proc = subprocess.run(
                [self.bash, "-c", command], cwd=sandbox.app, env=env,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            return Completed(-1, _text(exc.stdout) + _text(exc.stderr), timed_out=True)
        return Completed(proc.returncode, proc.stdout + proc.stderr)


# --- Docker ---------------------------------------------------------------------------------


def docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "info"], capture_output=True, timeout=15).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _docker(*args: str, timeout: int | None = None, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["docker", *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout,
    )
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
                proc = _docker("start", "-a", name, timeout=timeout, check=False)
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
