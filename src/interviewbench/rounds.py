"""The workflows behind `ib` and `ib ui`: start a round, next stage, grade, judge, break, validate, new.

Both front ends only translate input and output. Nothing here prints; a failure is an exception whose
message is written for the candidate.
"""

from __future__ import annotations

import hashlib
import itertools
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import workspace as ws
from .breaker import BAD_TEST, REAL_BREAK, SURVIVED, Attack, attack_prompt, run_break
from .grader import GradeResult, Progress, build_reference, grade, graded_files, no_progress, run_stage_tests
from .judge import (
    JudgeError, JudgeRequest, _diff, _read_tree, apply_judgment, parse_reply, prepare_judge, run_judge,
)
from .report import to_markdown
from .runner import Runner, RunnerError
from .tasks import (
    ATTACK_PROMPT, BRIEF, FULL_REPORT, JUDGE_PROMPT, REPORT, UI_STATE, Task, TaskError, _task_dirs, bench_is_bundled,
    bench_root, categories, get_task, load_task, tasks_root, templates_root,
)

SAFE_NAME = re.compile(r"[A-Za-z0-9._-]+")  # a round id or attack file name: one plain path segment
MAX_DIFF_CHARS = 1_000_000


class RoundError(Exception):
    pass


class AllRevealed(RoundError):
    pass


class UnknownRound(RoundError):
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
    revealed: int | None = None  # the stages the report shows in full; None for all of them
    full_report: Path | None = None  # every stage's details, outside the workspace, when the report hides some


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


@dataclass
class TaskCheck:
    id: str
    category: str
    errors: list[str]


@dataclass
class RoundInfo:
    """A round found under the workspaces folder. The id is its folder name."""

    id: str
    path: Path
    task: Task
    marker: dict
    stage: int  # how many stages are revealed
    started: datetime | None

    @property
    def ends(self) -> datetime | None:
        return self.started + timedelta(minutes=self.task.time_limit_minutes) if self.started else None


@dataclass
class FileChange:
    path: str
    status: str  # "added", "modified" or "deleted"
    additions: int
    deletions: int


@dataclass
class Changes:
    files: list[FileChange]
    diff: str
    truncated: bool


def _holds_a_round(folder: Path) -> bool:
    """Whether `folder` is a workspace `ib start` made: it has a readable marker naming a task."""
    try:
        marker = ws.read_marker(folder)
    except (OSError, ValueError):
        return False
    return isinstance(marker, dict) and isinstance(marker.get("task"), str)


def _protected_roots() -> list[Path]:
    """Folders a round may never go inside, nor replace: the tasks (hidden tests) and ib's own code."""
    return [bench_root(), Path(__file__).resolve().parent]


def _elsewhere(task: Task) -> str:
    default = ws.default_workspace(task.id)
    if any(ws.is_inside(default, root) or ws.is_inside(root, default) for root in _protected_roots()):
        return f"Set IB_WORKSPACES to a folder of its own, away from {bench_root()}."
    return f"Pick a new or empty folder, or leave out --dir to use {default}."


def _check_destination(task: Task, dest: Path, force: bool) -> bool:
    """Refuse a destination that would expose the hidden tests or delete someone's files.

    Returns whether `dest` is an earlier round that `force` allows replacing. Only such a round is
    ever deleted: any other folder must be new or empty.
    """
    for root in _protected_roots():
        if ws.is_inside(dest, root):
            raise RoundError(
                f"{dest} is inside {root}, which holds the hidden tests and reference solutions, "
                f"so an AI assistant working there could read them. {_elsewhere(task)}"
            )
        if ws.is_inside(root, dest):
            raise RoundError(f"{dest} contains {root}, the interviewbench install, so ib won't use it. {_elsewhere(task)}")
    if not dest.exists() and not dest.is_symlink():
        return False
    resolved = dest.resolve()
    special = "a drive root" if resolved == Path(resolved.anchor) else "your home folder" if resolved == Path.home().resolve() else None
    if special:
        raise RoundError(f"{dest} is {special}, so ib won't start a round there. {_elsewhere(task)}")
    if dest.is_symlink() or not dest.is_dir():
        raise RoundError(f"{dest} already exists and isn't a plain folder, so ib won't touch it. {_elsewhere(task)}")
    if not any(dest.iterdir()):
        return False  # an empty folder: the round goes into it, nothing is deleted
    if not _holds_a_round(dest):
        raise RoundError(
            f"{dest} already exists, isn't empty and isn't an interviewbench workspace, so ib won't touch "
            f"it (not even with --force). {_elsewhere(task)}"
        )
    if not force:
        raise RoundError(
            f"{dest} already exists and holds an earlier interviewbench round. Use --force to replace it "
            f"(your work there will be lost), or pick another folder."
        )
    return True


def start_round(
    task: Task, dest: Path, *, force: bool = False, git: bool = True, open_editor: bool = True
) -> StartedRound:
    """Set up a workspace: starter code, editor tasks, git, the marker and TASK.md. Starts the clock.

    `dest` must be new, empty, or (with `force`) an earlier round, which is deleted first.
    """
    if _check_destination(task, dest, force):
        ws.remove_tree(dest)
    ws.clear_private_dir(dest)  # results of an earlier round in this folder
    shutil.copytree(task.starter_dir, dest, dirs_exist_ok=True)
    wrote_tasks = ws.write_editor_tasks(dest)
    git_ok = git and ws.git_init(dest, ignored=[ws.EDITOR_TASKS.as_posix()] if wrote_tasks else [])
    started = datetime.now(timezone.utc)
    ws.write_marker(dest, {"task": task.id, "started_at": started.isoformat(), "stage": 1, "git": git_ok})
    (dest / BRIEF).write_text(ws.brief(task, started, git_ok), encoding="utf-8")
    editor = ws.open_in_editor(dest) if open_editor else None
    return StartedRound(task, dest, started, git_ok, editor)


def start_in_free_folder(task: Task, *, git: bool = True, open_editor: bool = True) -> StartedRound:
    """Start a round in <task>, or <task>-2, <task>-3...: an earlier round is never overwritten."""
    root = ws.workspaces_root()
    names = itertools.chain([task.id], (f"{task.id}-{n}" for n in itertools.count(2)))
    dest = next(root / name for name in names if not (root / name).exists())
    return start_round(task, dest, git=git, open_editor=open_editor)


def round_path(round_id: str) -> Path:
    """The folder of `round_id`, which comes from a URL: nothing but a direct child of the workspaces folder."""
    missing = UnknownRound(f"There is no round called '{round_id}'.")
    if not SAFE_NAME.fullmatch(round_id):
        raise missing
    root = ws.workspaces_root().resolve()
    path = (root / round_id).resolve()
    if path.parent != root or path.name != round_id:
        raise missing
    return path


def _started_at(marker: dict) -> datetime | None:
    try:
        started = datetime.fromisoformat(marker["started_at"])
    except (KeyError, TypeError, ValueError):
        return None
    return started if started.tzinfo else started.astimezone()


def load_round(round_id: str) -> RoundInfo:
    """A round by id. Raises UnknownRound for anything that isn't a readable round."""
    path = round_path(round_id)
    try:
        marker = ws.load_marker(path)  # a damaged marker raises MarkerError, a ValueError
        task = get_task(marker["task"])
        stage = int(marker.get("stage", 1))
    except (AttributeError, KeyError, TypeError, ValueError, OSError, TaskError) as exc:
        raise UnknownRound(f"There is no round called '{round_id}'.") from exc
    return RoundInfo(round_id, path, task, marker, max(1, min(stage, len(task.stages))), _started_at(marker))


def list_rounds() -> list[RoundInfo]:
    """Every round in the workspaces folder, newest first. Other folders there are skipped."""
    root = ws.workspaces_root()
    found = []
    for path in root.iterdir() if root.is_dir() else ():
        try:
            found.append(load_round(path.name))
        except UnknownRound:
            continue
    return sorted(found, key=lambda r: r.started.timestamp() if r.started else 0, reverse=True)


def delete_round(round_id: str) -> None:
    path = load_round(round_id).path
    ws.remove_tree(path)
    ws.clear_private_dir(path)


def changes(task: Task, workspace: Path) -> Changes:
    """What differs from the starter, under the grader's ignore rules. Needs no git."""
    before, before_skipped = _read_tree(task.starter_dir)
    after, after_skipped = _read_tree(workspace)
    files: list[FileChange] = []
    diffs: list[str] = []
    for name in sorted({*before, *after, *before_skipped, *after_skipped}):
        old, new = task.starter_dir / name, workspace / name
        if name in before and name in after:
            changed = before[name] != after[name]
        else:  # binary or too large to diff
            changed = not (old.is_file() and new.is_file()) or old.read_bytes() != new.read_bytes()
        if not changed:
            continue
        diff = _diff({k: v for k, v in before.items() if k == name}, {k: v for k, v in after.items() if k == name})
        body = diff.split("\n")[2:]  # after the ---/+++ header
        files.append(FileChange(
            name, "deleted" if not new.is_file() else "added" if not old.is_file() else "modified",
            sum(line.startswith("+") for line in body), sum(line.startswith("-") for line in body),
        ))
        if diff:
            diffs.append(diff)
    diff = "\n".join(diffs)
    return Changes(files, diff[:MAX_DIFF_CHARS], len(diff) > MAX_DIFF_CHARS)


def fingerprint(workspace: Path) -> str:
    """A hash of the graded files: it changes exactly when grading could give a different answer."""
    digest = hashlib.sha256()
    for path in graded_files(workspace):
        digest.update(path.relative_to(workspace).as_posix().encode() + b"\0")
        try:
            digest.update(path.read_bytes() + b"\0")
        except OSError:
            continue
    return digest.hexdigest()


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
    prior: GradeResult | None = None,
    request: JudgeRequest | None = None,
    progress: Progress = no_progress,
    all_stages: bool = False,
) -> GradeOutcome:
    """Run the hidden tests, optionally the judge, and write the report. Raises RunnerError, RoundError.

    judge: "none", "api" (a model, through `settings`), "prepare" (only build the prompt) or "reply"
    (score a chatbot's `reply`). A judge failure keeps the hidden-test scores and sets `judge_error`.
    `prior` and `request` are earlier results for this same code, which save running the tests again.

    Every stage's hidden tests run, but the report only names the failures of stages the round has
    reached: the candidate's AI assistant reads the workspace. The full report goes to ib's private
    folder instead. `all_stages` reports everything, for an interviewer grading a hand-back.
    """
    settings = settings or JudgeSettings()
    revealed = None if all_stages else revealed_stages(task, ws.read_marker(workspace))
    hides = revealed is not None and revealed < len(task.stages)
    full_report = private_folder(workspace) / FULL_REPORT if hides else None  # fail before the slow part
    result = prior or grade(task, workspace, runner, timeout=timeout, progress=progress)
    judge_error = None
    try:
        if judge == "api":
            run_judge(
                result, workspace, runner=runner, model=settings.model, timeout=timeout,
                backend=settings.backend, api_key=settings.api_key, base_url=settings.base_url,
                progress=progress,
            )
        elif judge != "none":
            request = request or prepare_judge(result, workspace, runner=runner, timeout=timeout, progress=progress)
            if judge == "reply":
                apply_judgment(result, request, parse_reply(reply or ""), reply_label)
    except (JudgeError, RunnerError) as exc:
        judge_error = str(exc)
        if settings.api_key:  # a provider's error can quote the key it was given
            judge_error = judge_error.replace(settings.api_key, "[API key]")
    (report_path or workspace / REPORT).write_text(to_markdown(result, revealed), encoding="utf-8")
    if full_report:
        full_report.write_text(to_markdown(result), encoding="utf-8")
    (workspace / UI_STATE).unlink(missing_ok=True)  # an earlier ib kept the GUI's results here, spoilers and all
    return GradeOutcome(result, request, judge_error, revealed, full_report)


def revealed_stages(task: Task, marker: dict | None) -> int | None:
    """How many stages a round has revealed, or None for a folder that isn't a round (a hand-back)."""
    if marker is None:
        return None
    try:
        stage = int(marker.get("stage", 1))
    except (AttributeError, TypeError, ValueError):  # a damaged marker: assume the least is revealed
        stage = 1
    return max(1, min(stage, len(task.stages)))


def private_folder(workspace: Path) -> Path:
    """`ws.private_dir`, created, refusing a data folder inside the workspace (IB_DATA_DIR set there)."""
    folder = ws.private_dir(workspace)
    if ws.is_inside(folder, workspace):
        raise RoundError(f"IB_DATA_DIR ({ws.data_root()}) is inside the workspace. Point it somewhere else.")
    folder.mkdir(parents=True, exist_ok=True)
    return folder


@dataclass
class ExportedPrompt:
    path: Path
    tokens: int
    removed_stale: bool  # an older ib wrote the prompt into the workspace, and that copy is gone now


def export_judge_prompt(workspace: Path, request: JudgeRequest) -> ExportedPrompt:
    """Write the judge prompt for pasting into a chatbot, outside the workspace.

    It holds the hidden tests and the reference solution, so it goes to ib's own data folder (see
    `ws.private_dir`), where an AI assistant working in the workspace doesn't look.
    """
    folder = private_folder(workspace)
    text = request.as_paste()
    path = folder / JUDGE_PROMPT
    path.write_text(text, encoding="utf-8")
    stale = workspace / JUDGE_PROMPT
    removed = stale.is_file()
    if removed:
        stale.unlink()
    return ExportedPrompt(path, tokens_estimate(text), removed)


def time_used_minutes(marker: dict | None) -> int | None:
    started = _started_at(marker or {})
    return int((datetime.now(timezone.utc) - started).total_seconds() // 60) if started else None


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


def suggested_attack_file(task: Task) -> str:
    """A name the task's test runner will collect, following the naming of the starter's own tests."""
    folder = task.starter_dir / task.attack_dir
    names = sorted(p.name for p in folder.iterdir() if p.is_file()) if folder.is_dir() else []
    for name in names:
        match = re.fullmatch(r"(test[_-])\w[\w.-]*?((?:\.\w+)+)", name, re.IGNORECASE)
        if match:  # test_limiter.py -> test_attack.py
            return f"{match[1]}attack{match[2]}"
        match = re.fullmatch(r"\w[\w.-]*?([._-]?(?:test|spec)(?:\.\w+)+)", name, re.IGNORECASE)
        if match:  # merge.test.ts -> attack.test.ts, limiter_test.go -> attack_test.go
            return f"attack{match[1]}"
    return "attack_test.txt"


def check_attack_name(task: Task, filename: str) -> None:
    if not SAFE_NAME.fullmatch(filename) or set(filename) == {"."}:
        raise RoundError(f"'{filename}' isn't a plain file name. Use something like {suggested_attack_file(task)}.")


def break_content(
    task: Task,
    workspace: Path,
    filename: str,
    content: str,
    runner: Runner,
    timeout: int | None = None,
    progress: Progress = no_progress,
) -> BreakOutcome:
    """`ib break` on a file held in memory. It goes to a temp folder, never to the workspace."""
    check_attack_name(task, filename)
    with tempfile.TemporaryDirectory(prefix="ib-attack-", ignore_cleanup_errors=True) as tmp:
        attack = Path(tmp) / filename
        attack.write_text(content, encoding="utf-8", newline="")
        return break_round(task, workspace, attack, runner, timeout, progress)


def check_task(task: Task, runner: Runner, progress: Progress = no_progress) -> list[str]:
    """The starter fails stage 1, and after applying solutions 1..N, stage N's tests all pass.

    Each check runs only the stage it looks at: running every stage would triple the time, mostly on
    performance tests against code that hasn't been optimised yet.
    """
    errors = []
    try:
        progress(f"Checking that the {task.id} starter fails stage 1")
        first = run_stage_tests(task, task.starter_dir, 1, runner)
        if first.error:
            errors.append(f"stage 1 tests could not run on the starter: {first.error}")
        elif first.ratio >= 1:
            errors.append("the starter code already passes stage 1")
        with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
            for stage in task.stages:
                progress(f"Checking {task.id} stage {stage.number} of {len(task.stages)} against its solution")
                ref = build_reference(task, Path(tmp) / f"ref-{stage.number}", runner, upto=stage.number)
                result = run_stage_tests(task, ref, stage.number, runner)
                if result.error or result.total == 0 or result.passed != result.total:
                    detail = result.error or ", ".join(f.name for f in result.failures) or "no tests ran"
                    errors.append(f"after solutions 1..{stage.number}, stage {stage.number} fails: {detail}")
    except RunnerError as exc:
        errors.append(str(exc))
    return errors


def available_tasks() -> list[Task]:
    """Every task that loads: while one is being written, the rest stay usable."""
    tasks = []
    for path in _task_dirs(tasks_root()) if tasks_root().is_dir() else ():
        try:
            tasks.append(load_task(path))
        except TaskError:
            continue
    return tasks


def validate_tasks(
    task_ids: list[str] | None, runner: Runner | None, progress: Progress = no_progress
) -> list[TaskCheck]:
    """`ib validate` as data: a task that doesn't load is a failed check rather than an exception."""
    dirs = _task_dirs(tasks_root()) if tasks_root().is_dir() else []
    unknown = sorted(set(task_ids or ()) - {d.name for d in dirs})
    if unknown:
        raise RoundError(f"Unknown task '{unknown[0]}'. Available: {', '.join(d.name for d in dirs) or 'none'}")
    checks = []
    for path in dirs:
        if task_ids and path.name not in task_ids:
            continue
        try:
            task = load_task(path)
            errors = check_task(task, runner, progress) if runner else []
        except TaskError as exc:
            errors = [str(exc)]
        checks.append(TaskCheck(path.name, path.parent.name, errors))
    return checks


def templates() -> list[str]:
    root = templates_root()
    return sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []


def new_task(task_id: str, category: str, template: str | None = None) -> NewTask:
    """Create a task skeleton from a template."""
    if bench_is_bundled():
        raise RoundError(
            f"ib new needs a clone of the interviewbench repo. This ib was installed as a package, so its tasks "
            f"are in {tasks_root()}, where a new task would be lost on the next upgrade. Clone the repo, install it "
            "with `pip install -e .` and run ib new inside the clone, or set IB_ROOT to a folder that holds "
            "tasks/, rubrics/ and templates/."
        )
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
