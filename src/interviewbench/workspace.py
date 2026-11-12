"""A candidate's workspace: where it lives, TASK.md, the editor, git checkpoints and editor tasks.

`ib start` makes the workspace feel like a real AI-enabled round: the starter code in its own folder
outside the repo (so an AI assistant there can't read the hidden tests), the brief in TASK.md, the
editor opened on it, a git repo with one commit per stage, and buttons for the ib commands.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

from .tasks import BRIEF, MARKER, WORKSPACE_FILES, Task

# Editors tried in order when $IB_EDITOR is unset. Each opens a folder as `<editor> <folder>`.
EDITORS = ("code", "cursor", "windsurf")
EDITOR_TASKS = Path(".vscode") / "tasks.json"
# ib's commits use their own identity, so they work even if the candidate never configured git,
# and skip the candidate's global hooks and signing setup.
_GIT_IDENTITY = (
    "-c", "user.name=interviewbench", "-c", "user.email=interviewbench@users.noreply.github.com",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
)


def workspaces_root() -> Path:
    """$IB_WORKSPACES, else ~/ib-workspaces: away from the repo's hidden tests."""
    base = os.environ.get("IB_WORKSPACES")
    return Path(base).expanduser() if base else Path.home() / "ib-workspaces"


def default_workspace(task_id: str) -> Path:
    return workspaces_root() / task_id


def data_root() -> Path:
    """$IB_DATA_DIR, else the per-user app data folder: files ib keeps out of every workspace."""
    base = os.environ.get("IB_DATA_DIR")
    if base:
        return Path(base).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "interviewbench"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "interviewbench"
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "interviewbench"


def private_dir(workspace: Path) -> Path:
    """Where ib keeps a workspace's files the candidate's AI assistant mustn't read, e.g. the judge prompt.

    One folder per workspace, named after it plus a hash of its full path, outside the workspace.
    """
    resolved = workspace.resolve()
    digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:10]
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", resolved.name).strip(".-") or "workspace"
    return data_root() / "judge" / f"{name}-{digest}"


def is_inside(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def remove_tree(path: Path) -> None:
    """shutil.rmtree that clears read-only bits first: git's objects have them, and Windows won't delete those."""
    for dirpath, dirnames, filenames in os.walk(path):
        for name in dirnames + filenames:
            target = Path(dirpath) / name
            if not target.is_symlink():
                target.chmod(target.stat().st_mode | stat.S_IWRITE)
    shutil.rmtree(path)


def read_marker(workspace: Path) -> dict | None:
    marker = workspace / MARKER
    return json.loads(marker.read_text(encoding="utf-8")) if marker.is_file() else None


def write_marker(workspace: Path, marker: dict) -> None:
    (workspace / MARKER).write_text(json.dumps(marker, indent=2), encoding="utf-8")


# --- TASK.md --------------------------------------------------------------------------------


def stage_section(task: Task, number: int) -> str:
    stage = task.stage(number)
    body = stage.prompt.partition("\n")[2].strip()
    return f"## Stage {number}/{len(task.stages)}: {stage.title}\n\n{body}\n"


def brief(task: Task, started: datetime, git: bool) -> str:
    """TASK.md: what the candidate reads in their editor, like the instructions panel of a real round."""
    local = started.astimezone()
    ends = local + timedelta(minutes=task.time_limit_minutes)
    history = (
        "- Your work is a git repo. `ib next` commits it and tags the stage (`stage-1`, ...); "
        "branch and commit as you like.\n" if git else ""
    )
    return (
        f"# {task.title}\n\n"
        f"**Time limit:** {task.time_limit_minutes} min. Started at {local:%H:%M}, time is up at {ends:%H:%M}.\n\n"
        f"{len(task.stages)} stages, revealed one at a time. Any AI assistant is allowed. In this folder:\n\n"
        "- `ib test` runs your own tests.\n"
        "- `ib next` reveals the next stage (it is added to this file).\n"
        "- `ib grade` runs the hidden tests and scores your work; `ib grade --judge` adds the AI review.\n"
        "- Write what you found and why in `NOTES.md`; it is graded too.\n"
        f"{history}"
        "- In VS Code, Cursor, Windsurf or Qoder the same commands are under *Terminal > Run Task*.\n\n"
        "---\n\n"
        + stage_section(task, 1)
    )


def append_stage(workspace: Path, task: Task, number: int) -> None:
    path = workspace / BRIEF
    existing = path.read_text(encoding="utf-8") if path.is_file() else f"# {task.title}\n"
    path.write_text(f"{existing.rstrip()}\n\n---\n\n{stage_section(task, number)}", encoding="utf-8")


# --- Editor ---------------------------------------------------------------------------------


def editor_command() -> list[str] | None:
    """$IB_EDITOR (set it to an empty string to never open an editor), else the first of EDITORS found."""
    custom = os.environ.get("IB_EDITOR")
    if custom is not None:
        return [part.strip('"') for part in shlex.split(custom, posix=os.name != "nt")] or None
    for name in EDITORS:
        found = shutil.which(name)  # on Windows this resolves e.g. code -> ...\bin\code.cmd
        if found:
            return [found]
    return None


def editor_name() -> str | None:
    command = editor_command()
    return Path(command[0]).stem if command else None


def open_in_editor(folder: Path) -> str | None:
    """Open `folder` in the candidate's editor without waiting. Returns the editor's name, or None."""
    command = editor_command()
    if not command:
        return None
    try:
        _launch([*command, str(folder)])
    except OSError:
        return None
    return editor_name()


def _launch(command: list[str]) -> None:
    """Start a GUI program and don't wait for it."""
    subprocess.Popen(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def write_editor_tasks(workspace: Path) -> bool:
    """Add the ib commands as VS Code-style tasks (Terminal > Run Task). Never overwrites a starter's own.

    They call this Python with `-m interviewbench`, so they work even when `ib` isn't on PATH and
    no virtualenv is activated in the editor's terminal.
    """
    path = workspace / EDITOR_TASKS
    if path.exists():
        return False

    def task(label: str, *args: str, group: dict | None = None) -> dict:
        entry = {
            "label": f"ib: {label}",
            "type": "process",
            "command": sys.executable,
            "args": ["-m", "interviewbench", *args],
            "options": {"cwd": "${workspaceFolder}"},
            "problemMatcher": [],
        }
        if group:
            entry["group"] = group
        return entry

    tasks = [
        task("run my tests", "test", group={"kind": "test", "isDefault": True}),
        task("next stage", "next"),
        task("grade", "grade"),
        task("grade with the AI judge", "grade", "--judge"),
        task("export the judge prompt (saved outside this folder; paste into any chatbot)", "grade", "--judge-export"),
    ]
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps({"version": "2.0.0", "tasks": tasks}, indent=2) + "\n", encoding="utf-8")
    return True


# --- Git ------------------------------------------------------------------------------------


def _git(workspace: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(workspace), *args], check=True, capture_output=True, text=True,
        stdin=subprocess.DEVNULL,
    )


def git_init(workspace: Path, ignored: list[str]) -> bool:
    """Make the workspace a git repo with the starter as its first commit. False if git isn't usable."""
    if not shutil.which("git"):
        return False
    try:
        _git(workspace, "init", "-q")
        _git(workspace, "symbolic-ref", "HEAD", "refs/heads/main")  # works on every git version
        exclude = workspace / ".git" / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        lines = ["# Written by interviewbench: its own files, never part of your work"]
        lines += [f"/{name}" for name in (*WORKSPACE_FILES, *ignored)]
        with exclude.open("a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return checkpoint(workspace, "starter")
    except (OSError, subprocess.CalledProcessError):
        return False


def checkpoint(workspace: Path, message: str, tag: str | None = None) -> bool:
    """Commit everything in the workspace (even if nothing changed) and optionally tag it."""
    if not (workspace / ".git").exists() or not shutil.which("git"):
        return False
    try:
        _git(workspace, "add", "-A")
        _git(workspace, *_GIT_IDENTITY, "commit", "-q", "--allow-empty", "--no-verify", "-m", message)
        if tag:
            _git(workspace, *_GIT_IDENTITY, "tag", "-f", tag)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False
