from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NoReturn, Optional

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.table import Table

from . import __version__
from .grader import build_reference, grade as grade_workspace
from .judge import JudgeError, run_judge
from .report import render, to_markdown
from .runner import RUNNERS, Runner, RunnerError, get_runner
from .tasks import (
    BRIEF, MARKER, Task, TaskError, bench_root, categories, get_task, load_all, tasks_root, templates_root,
)

# Editors tried in order when $IB_EDITOR is unset. Each opens a folder as `<editor> <folder>`.
EDITORS = ("code", "cursor", "windsurf")

app = typer.Typer(
    help="Realistic AI-era coding interview tasks with rubrics and a grader.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


def _fail(message: str) -> NoReturn:
    console.print(f"[red]Error:[/red] {message}")
    raise typer.Exit(1)


def _runner_or_exit(kind: str) -> Runner:
    try:
        return get_runner(kind)
    except RunnerError as exc:
        _fail(str(exc))


def _task_or_exit(task_id: str) -> Task:
    try:
        return get_task(task_id)
    except TaskError as exc:
        _fail(str(exc))


def _read_marker(workspace: Path) -> dict | None:
    marker = workspace / MARKER
    return json.loads(marker.read_text(encoding="utf-8")) if marker.is_file() else None


def _task_from_workspace(workspace: Path, task_id: Optional[str]) -> Task:
    if task_id:
        return _task_or_exit(task_id)
    marker = _read_marker(workspace)
    if marker is None:
        _fail(f"{workspace} is not an interviewbench workspace (no {MARKER}). Pass --task <id>.")
    return _task_or_exit(marker["task"])


def _print_stage(task: Task, number: int) -> None:
    try:
        stage = task.stage(number)
    except TaskError as exc:
        _fail(str(exc))
    console.print(f"\n[bold cyan]Stage {stage.number}/{len(task.stages)}[/bold cyan]\n")
    console.print(Markdown(stage.prompt))
    console.print()


# --- Workspaces -----------------------------------------------------------------------------


def default_workspace(task_id: str) -> Path:
    """$IB_WORKSPACES/<task>, else ~/ib-workspaces/<task>: away from the repo's hidden tests."""
    base = os.environ.get("IB_WORKSPACES")
    return (Path(base).expanduser() if base else Path.home() / "ib-workspaces") / task_id


def _is_inside(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def _stage_section(task: Task, number: int) -> str:
    stage = task.stage(number)
    body = stage.prompt.partition("\n")[2].strip()
    return f"## Stage {number}/{len(task.stages)}: {stage.title}\n\n{body}\n"


def _brief(task: Task, started: datetime) -> str:
    """TASK.md: what the candidate reads in their editor, like the instructions panel of a real round."""
    local = started.astimezone()
    ends = local + timedelta(minutes=task.time_limit_minutes)
    return (
        f"# {task.title}\n\n"
        f"**Time limit:** {task.time_limit_minutes} min. Started at {local:%H:%M}, time is up at {ends:%H:%M}.\n\n"
        f"{len(task.stages)} stages, revealed one at a time. Any AI assistant is allowed. In this folder:\n\n"
        "- `ib next` reveals the next stage (it is added to this file).\n"
        "- `ib grade` runs the hidden tests and scores your work.\n"
        "- Write what you found and why in `NOTES.md`; it is graded too.\n\n"
        "---\n\n"
        + _stage_section(task, 1)
    )


def _editor_command() -> list[str] | None:
    """$IB_EDITOR (set it to an empty string to never open an editor), else the first of EDITORS found."""
    custom = os.environ.get("IB_EDITOR")
    if custom is not None:
        return [part.strip('"') for part in shlex.split(custom, posix=os.name != "nt")] or None
    for name in EDITORS:
        found = shutil.which(name)  # on Windows this resolves e.g. code -> ...\bin\code.cmd
        if found:
            return [found]
    return None


def _open_in_editor(folder: Path) -> str | None:
    """Open `folder` in the candidate's editor without waiting. Returns the editor's name, or None."""
    command = _editor_command()
    if not command:
        return None
    try:
        subprocess.Popen(
            [*command, str(folder)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError:
        return None
    return Path(command[0]).stem


@app.command("list")
def list_tasks(
    category: Optional[str] = typer.Option(None, "--category", "-c", help="Only this category"),
    tag: Optional[str] = typer.Option(None, "--tag", help="Only tasks with this tag"),
) -> None:
    """List available tasks."""
    try:
        tasks = load_all()
    except TaskError as exc:
        _fail(str(exc))
    tasks = [
        t for t in tasks
        if (category is None or t.category == category) and (tag is None or tag in t.tags)
    ]
    table = Table()
    for col in ("ID", "Category", "Title", "Level", "Tags", "Time"):
        table.add_column(col)
    for t in tasks:
        table.add_row(
            t.id, t.category, t.title, t.level, ", ".join(t.tags), f"{t.time_limit_minutes} min"
        )
    console.print(table)


@app.command()
def start(
    task_id: str = typer.Argument(..., help="Task to start, e.g. rate-limiter"),
    dir: Optional[Path] = typer.Option(None, "--dir", "-d", help="Where to create the workspace (default: ~/ib-workspaces/<task>, or $IB_WORKSPACES/<task>)"),
    force: bool = typer.Option(False, "--force", help="Overwrite an existing workspace"),
    open_editor: bool = typer.Option(True, "--open/--no-open", help="Open the workspace in your editor ($IB_EDITOR, else VS Code, Cursor or Windsurf)"),
) -> None:
    """Start a round: copy the starter code to a workspace outside the repo, write TASK.md, open your editor."""
    task = _task_or_exit(task_id)
    dest = (dir or default_workspace(task.id)).expanduser()
    if _is_inside(dest, bench_root()):
        _fail(
            f"{dest} is inside {bench_root()}, which holds the hidden tests and reference solutions, "
            f"so an AI assistant working there could read them. Pick a folder outside it, or leave out "
            f"--dir to use {default_workspace(task.id)}."
        )
    if dest.exists():
        if not force:
            _fail(f"{dest} already exists. Use --force to overwrite it (your changes there will be lost).")
        shutil.rmtree(dest)
    shutil.copytree(task.starter_dir, dest)
    started = datetime.now(timezone.utc)
    (dest / MARKER).write_text(
        json.dumps({"task": task.id, "started_at": started.isoformat(), "stage": 1}, indent=2),
        encoding="utf-8",
    )
    (dest / BRIEF).write_text(_brief(task, started), encoding="utf-8")

    editor = _open_in_editor(dest) if open_editor else None
    console.print(f"[bold]{task.title}[/bold] — {task.time_limit_minutes} min, {len(task.stages)} stages")
    console.print(f"Workspace: [green]{dest}[/green]" + (f" (opened in {editor})" if editor else ""))
    if not editor:
        console.print(
            "Open [bold]only this folder[/bold] in your editor, so your AI assistant can't see the "
            f"hidden tests:  [bold]cd \"{dest}\"[/bold] then e.g. [bold]code .[/bold]"
        )
    ends = started.astimezone() + timedelta(minutes=task.time_limit_minutes)
    console.print(f"The brief is in {BRIEF}. Your {task.time_limit_minutes} minutes started now; time is up at {ends:%H:%M}.")
    _print_stage(task, 1)
    console.print("In the workspace: [bold]ib next[/bold] reveals the next stage, [bold]ib grade[/bold] scores your work.")


@app.command("next")
def next_stage(
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
) -> None:
    """Reveal the next stage: show its brief and add it to TASK.md."""
    marker = _read_marker(dir)
    if marker is None:
        _fail(f"{dir} is not an interviewbench workspace (no {MARKER}). Run this inside the folder `ib start` made.")
    task = _task_or_exit(marker["task"])
    current = int(marker.get("stage", 1))
    if current >= len(task.stages):
        _fail(f"All {len(task.stages)} stages are already revealed. Run `ib grade` when you're done.")
    number = current + 1
    marker["stage"] = number
    (dir / MARKER).write_text(json.dumps(marker, indent=2), encoding="utf-8")
    brief = dir / BRIEF
    existing = brief.read_text(encoding="utf-8") if brief.is_file() else f"# {task.title}\n"
    brief.write_text(f"{existing.rstrip()}\n\n---\n\n{_stage_section(task, number)}", encoding="utf-8")
    _print_stage(task, number)
    console.print(f"Added to {BRIEF}.")


@app.command()
def prompt(
    task_id: Optional[str] = typer.Argument(None, help="Task id (optional inside a workspace)"),
    stage: int = typer.Option(1, "--stage", "-s", help="Stage number"),
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
) -> None:
    """Show the brief for a stage (reading ahead skips the real format; prefer `ib next`)."""
    _print_stage(_task_from_workspace(dir, task_id), stage)


@app.command()
def grade(
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory to grade"),
    task_id: Optional[str] = typer.Option(None, "--task", "-t", help="Task id (read from the workspace if omitted)"),
    output: Optional[Path] = typer.Option(None, "--output", "-o", help="Markdown report path"),
    timeout: Optional[int] = typer.Option(None, help="Per-stage test timeout in seconds (default: the task's)"),
    runner: str = typer.Option("auto", help="Where tests run: auto (docker if running, else local), docker, local"),
    judge: bool = typer.Option(False, "--judge", help="Also score the judge criteria with Claude (needs an API key)"),
    judge_model: Optional[str] = typer.Option(None, help="Claude model for --judge (default: $IB_JUDGE_MODEL or claude-opus-5-5)"),
) -> None:
    """Grade a workspace against the task's hidden tests and rubric."""
    if not dir.is_dir():
        _fail(f"{dir} is not a directory")
    task = _task_from_workspace(dir, task_id)
    backend = _runner_or_exit(runner)
    with console.status(f"Running hidden tests ({backend.name} runner)..."):
        try:
            result = grade_workspace(task, dir, backend, timeout=timeout)
        except RunnerError as exc:
            _fail(str(exc))
    judge_error = None
    if judge:
        with console.status("Running the AI judge..."):
            try:
                run_judge(result, dir, runner=backend, model=judge_model, timeout=timeout)
            except (JudgeError, RunnerError) as exc:
                judge_error = str(exc)
    render(result, console)
    marker = _read_marker(dir)
    if marker and "started_at" in marker:
        used = datetime.now(timezone.utc) - datetime.fromisoformat(marker["started_at"])
        console.print(f"Time used: {int(used.total_seconds() // 60)} min of {task.time_limit_minutes}\n")
    report_path = output or dir / "ib-report.md"
    report_path.write_text(to_markdown(result), encoding="utf-8")
    console.print(f"Report written to [green]{report_path}[/green]")
    if judge_error:
        _fail(f"AI judge failed, so only auto criteria were scored: {judge_error}")


@app.command()
def new(
    task_id: str = typer.Argument(..., help="New task id (its folder name), e.g. order-api"),
    category: str = typer.Option(..., "--category", "-c", help="Task category, e.g. backend"),
    template: Optional[str] = typer.Option(None, "--template", help="Folder under templates/ (default: the first <category>-* one)"),
) -> None:
    """Create a task skeleton from a template (run inside a clone of the repo)."""
    known = categories()
    if category not in known:
        _fail(f"Unknown category '{category}'. Known: {', '.join(known)}. Add rubrics/{category}.yaml to create one.")
    root = templates_root()
    available = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    template = template or next((t for t in available if t.startswith(f"{category}-")), None)
    if template not in available:
        _fail(f"No template for '{category}'. Available: {', '.join(available) or 'none'}. Pass --template.")
    if any(d.name == task_id for d in tasks_root().glob("*/*")):
        _fail(f"A task named '{task_id}' already exists")
    dest = tasks_root() / category / task_id
    shutil.copytree(root / template, dest)
    for path in dest.rglob("*"):
        if path.is_file() and path.suffix in (".toml", ".md", ".yaml"):
            text = path.read_text(encoding="utf-8")
            text = text.replace("{{task_id}}", task_id).replace("{{category}}", category)
            path.write_text(text, encoding="utf-8", newline="\n")
    console.print(f"Created [green]{dest}[/green] from templates/{template}.")
    console.print(f"Fill in every TODO, then run [bold]ib validate {task_id} --run[/bold]. See docs/TASK_FORMAT.md.")


@app.command()
def validate(
    task_ids: Optional[list[str]] = typer.Argument(None, help="Tasks to check (default: all)"),
    run: bool = typer.Option(False, "--run", help="Also run the tests: the starter must fail stage 1 and each stage's solution must pass it"),
    runner: str = typer.Option("auto", help="Runner for --run: auto, docker, local"),
) -> None:
    """Check tasks follow docs/TASK_FORMAT.md."""
    try:
        tasks = [get_task(t) for t in task_ids] if task_ids else load_all()
    except TaskError as exc:
        _fail(str(exc))
    backend = _runner_or_exit(runner) if run else None
    failed = False
    for task in tasks:
        errors = check_task(task, backend) if backend else []
        console.print(f"{'[green]ok[/green]' if not errors else '[red]FAIL[/red]'} {task.category}/{task.id}")
        for error in errors:
            console.print(f"   - {error}", markup=False)
        failed = failed or bool(errors)
    if failed:
        raise typer.Exit(1)


def check_task(task: Task, runner: Runner) -> list[str]:
    """The starter fails stage 1, and after applying solutions 1..N, stage N's tests all pass."""
    errors = []
    try:
        first = grade_workspace(task, task.starter_dir, runner).stages[0]
        if first.error:
            errors.append(f"stage 1 tests could not run on the starter: {first.error}")
        elif first.ratio >= 1:
            errors.append("the starter code already passes stage 1")
        with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
            for stage in task.stages:
                ref = build_reference(task, Path(tmp) / f"ref-{stage.number}", runner, upto=stage.number)
                result = grade_workspace(task, ref, runner).stages[stage.number - 1]
                if result.error or result.total == 0 or result.passed != result.total:
                    detail = result.error or ", ".join(f.name for f in result.failures) or "no tests ran"
                    errors.append(f"after solutions 1..{stage.number}, stage {stage.number} fails: {detail}")
    except RunnerError as exc:
        errors.append(str(exc))
    return errors


@app.command()
def version() -> None:
    """Show the interviewbench version."""
    console.print(__version__)
