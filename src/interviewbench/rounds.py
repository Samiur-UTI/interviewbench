"""The workflows behind `ib` and `ib ui`: start a round, next stage, grade, judge, break, validate, new.

Both front ends only translate input and output. Nothing here prints; a failure is an exception whose
message is written for the candidate.
"""

from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import workspace as ws
from .breaker import BAD_TEST, REAL_BREAK, SURVIVED, Attack, attack_prompt, run_break
from .grader import GradeResult, Progress, build_reference, grade, no_progress
from .judge import JudgeError, JudgeRequest, apply_judgment, parse_reply, prepare_judge, run_judge
from .report import to_markdown
from .runner import Runner, RunnerError
from .tasks import (
    ATTACK_PROMPT, BRIEF, REPORT, Task, bench_root, categories, tasks_root, templates_root,
)


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


@dataclass
class JudgeSettings:
    backend: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = field(default=None, repr=False)


@dataclass
class GradeOutcome:
    result: GradeResult
    request: JudgeRequest | None = None  # the prompt, when the judge is a chatbot
    judge_error: str | None = None


@dataclass
class BreakOutcome:
    attacks: list[Attack]

    @property
    def counts(self) -> dict[str, int]:
        verdicts = [a.verdict for a in self.attacks]
        return {
            "real_break": verdicts.count(REAL_BREAK),
            "survived": verdicts.count(SURVIVED),
            "bad_test": verdicts.count(BAD_TEST),
        }


@dataclass
class NewTask:
    path: Path
    template: str


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


def grade_round(
    task: Task,
    workspace: Path,
    runner: Runner,
    *,
    judge: str = "none",
    settings: JudgeSettings | None = None,
    reply: str | None = None,
    reply_label: str = "pasted reply",
    timeout: int | None = None,
    report_path: Path | None = None,
    progress: Progress = no_progress,
) -> GradeOutcome:
    """Run the hidden tests, optionally the judge, and write the report. Raises RunnerError.

    judge: "none", "api" (a model, through `settings`), "prepare" (only build the prompt) or "reply"
    (score a chatbot's `reply`). A judge failure keeps the hidden-test scores and sets `judge_error`.
    """
    settings = settings or JudgeSettings()
    result = grade(task, workspace, runner, timeout=timeout, progress=progress)
    request, judge_error = None, None
    try:
        if judge == "api":
            run_judge(
                result, workspace, runner=runner, model=settings.model, timeout=timeout,
                backend=settings.backend, api_key=settings.api_key, base_url=settings.base_url,
                progress=progress,
            )
        elif judge != "none":
            request = prepare_judge(result, workspace, runner=runner, timeout=timeout, progress=progress)
            if judge == "reply":
                apply_judgment(result, request, parse_reply(reply or ""), reply_label)
    except (JudgeError, RunnerError) as exc:
        judge_error = str(exc)
        if settings.api_key:  # a provider's error can quote the key it was given
            judge_error = judge_error.replace(settings.api_key, "[API key]")
    (report_path or workspace / REPORT).write_text(to_markdown(result), encoding="utf-8")
    return GradeOutcome(result, request, judge_error)


def time_used_minutes(marker: dict | None) -> int | None:
    if not marker or "started_at" not in marker:
        return None
    used = datetime.now(timezone.utc) - datetime.fromisoformat(marker["started_at"])
    return int(used.total_seconds() // 60)


def tokens_estimate(text: str) -> int:
    return len(text) // 4


def write_attack_prompt(task: Task, workspace: Path, marker: dict) -> Path:
    revealed = min(int(marker.get("stage", len(task.stages))), len(task.stages))
    path = workspace / ATTACK_PROMPT
    path.write_text(attack_prompt(task, workspace, revealed), encoding="utf-8")
    return path


def break_round(
    task: Task,
    workspace: Path,
    attack: Path,
    runner: Runner,
    timeout: int | None = None,
    progress: Progress = no_progress,
) -> BreakOutcome:
    """Run an attack test file. Raises RunnerError."""
    return BreakOutcome(run_break(task, workspace, attack, runner, timeout, progress))


def check_task(task: Task, runner: Runner, progress: Progress = no_progress) -> list[str]:
    """The starter fails stage 1, and after applying solutions 1..N, stage N's tests all pass."""
    errors = []
    try:
        progress(f"Checking that the {task.id} starter fails stage 1")
        first = grade(task, task.starter_dir, runner).stages[0]
        if first.error:
            errors.append(f"stage 1 tests could not run on the starter: {first.error}")
        elif first.ratio >= 1:
            errors.append("the starter code already passes stage 1")
        with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
            for stage in task.stages:
                progress(f"Checking {task.id} stage {stage.number} of {len(task.stages)} against its solution")
                ref = build_reference(task, Path(tmp) / f"ref-{stage.number}", runner, upto=stage.number)
                result = grade(task, ref, runner).stages[stage.number - 1]
                if result.error or result.total == 0 or result.passed != result.total:
                    detail = result.error or ", ".join(f.name for f in result.failures) or "no tests ran"
                    errors.append(f"after solutions 1..{stage.number}, stage {stage.number} fails: {detail}")
    except RunnerError as exc:
        errors.append(str(exc))
    return errors


def templates() -> list[str]:
    root = templates_root()
    return sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []


def new_task(task_id: str, category: str, template: str | None = None) -> NewTask:
    """Create a task skeleton from a template."""
    known = categories()
    if category not in known:
        raise RoundError(f"Unknown category '{category}'. Known: {', '.join(known)}. Add rubrics/{category}.yaml to create one.")
    available = templates()
    template = template or next((t for t in available if t.startswith(f"{category}-")), None)
    if template not in available:
        raise RoundError(f"No template for '{category}'. Available: {', '.join(available) or 'none'}. Pass --template.")
    if any(d.name == task_id for d in tasks_root().glob("*/*")):
        raise RoundError(f"A task named '{task_id}' already exists")
    dest = tasks_root() / category / task_id
    shutil.copytree(templates_root() / template, dest)
    for path in dest.rglob("*"):
        if path.is_file() and path.suffix in (".toml", ".md", ".yaml"):
            text = path.read_text(encoding="utf-8")
            text = text.replace("{{task_id}}", task_id).replace("{{category}}", category)
            path.write_text(text, encoding="utf-8", newline="\n")
    return NewTask(dest, template)
