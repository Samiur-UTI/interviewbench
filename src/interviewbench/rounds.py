"""The workflows behind `ib` and `ib ui`: start a round, reveal stages, and the rest.

Both front ends only translate input and output. Nothing here prints; a failure is an exception whose
message is written for the candidate.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import workspace as ws
from .tasks import BRIEF, Task, bench_root


class RoundError(Exception):
    pass


class AllRevealed(RoundError):
    pass


@dataclass
class StartedRound:
    task: Task
    path: Path
    started: datetime
    git: bool
    editor: str | None

    @property
    def ends(self) -> datetime:
        return self.started.astimezone() + timedelta(minutes=self.task.time_limit_minutes)


@dataclass
class RevealedStage:
    number: int
    tagged: str | None


def start_round(
    task: Task, dest: Path, *, force: bool = False, git: bool = True, open_editor: bool = True
) -> StartedRound:
    """Set up a workspace: starter code, editor tasks, git, the marker and TASK.md. Starts the clock."""
    if ws.is_inside(dest, bench_root()):
        raise RoundError(
            f"{dest} is inside {bench_root()}, which holds the hidden tests and reference solutions, "
            f"so an AI assistant working there could read them. Pick a folder outside it, or leave out "
            f"--dir to use {ws.default_workspace(task.id)}."
        )
    if dest.exists():
        if not force:
            raise RoundError(f"{dest} already exists. Use --force to overwrite it (your changes there will be lost).")
        ws.remove_tree(dest)
    shutil.copytree(task.starter_dir, dest)
    wrote_tasks = ws.write_editor_tasks(dest)
    git_ok = git and ws.git_init(dest, ignored=[ws.EDITOR_TASKS.as_posix()] if wrote_tasks else [])
    started = datetime.now(timezone.utc)
    ws.write_marker(dest, {"task": task.id, "started_at": started.isoformat(), "stage": 1, "git": git_ok})
    (dest / BRIEF).write_text(ws.brief(task, started, git_ok), encoding="utf-8")
    editor = ws.open_in_editor(dest) if open_editor else None
    return StartedRound(task, dest, started, git_ok, editor)


def next_stage(task: Task, workspace: Path, marker: dict) -> RevealedStage:
    """Commit and tag the work so far, then add the next stage to the marker and TASK.md."""
    current = int(marker.get("stage", 1))
    if current >= len(task.stages):
        raise AllRevealed(f"All {len(task.stages)} stages are already revealed. Run `ib grade` when you're done.")
    tagged = None
    if marker.get("git") and ws.checkpoint(workspace, f"Stage {current} done", tag=f"stage-{current}"):
        tagged = f"stage-{current}"
    number = current + 1
    marker["stage"] = number
    ws.write_marker(workspace, marker)
    ws.append_stage(workspace, task, number)
    return RevealedStage(number, tagged)
