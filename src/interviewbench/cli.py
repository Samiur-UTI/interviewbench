from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn, Optional

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.table import Table

from . import __version__
from .grader import DEFAULT_TIMEOUT, grade as grade_workspace
from .judge import JudgeError, run_judge
from .report import render, to_markdown
from .tasks import Task, TaskError, get_task, load_all

MARKER = ".interviewbench.json"
DEFAULT_WORKSPACE = Path("ib-workspace")

app = typer.Typer(
    help="Realistic AI-era coding interview tasks with rubrics and a grader.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


def _fail(message: str) -> NoReturn:
    console.print(f"[red]Error:[/red] {message}")
    raise typer.Exit(1)


def _task_or_exit(task_id: str) -> Task:
    try:
        return get_task(task_id)
    except TaskError as exc:
        _fail(str(exc))


def _task_from_workspace(workspace: Path, task_id: Optional[str]) -> Task:
    if task_id:
        return _task_or_exit(task_id)
    marker = workspace / MARKER
    if not marker.is_file():
        _fail(f"{workspace} is not an interviewbench workspace (no {MARKER}). Pass --task <id>.")
    return _task_or_exit(json.loads(marker.read_text(encoding="utf-8"))["task"])


def _print_stage(task: Task, number: int) -> None:
    try:
        stage = task.stage(number)
    except TaskError as exc:
        _fail(str(exc))
    console.print(f"\n[bold cyan]Stage {stage.number}/{len(task.stages)}: {stage.title}[/bold cyan]\n")
    console.print(Markdown(stage.prompt))
    console.print()


@app.command("list")
def list_tasks() -> None:
    """List available tasks."""
    try:
        tasks = load_all()
    except TaskError as exc:
        _fail(str(exc))
    table = Table()
    for col in ("ID", "Title", "Level", "Language", "Time"):
        table.add_column(col)
    for t in tasks:
        table.add_row(t.id, t.title, t.level, t.language, f"{t.time_limit_minutes} min")
    console.print(table)


@app.command()
def start(
    task_id: str = typer.Argument(..., help="Task to start, e.g. rate-limiter"),
    dir: Optional[Path] = typer.Option(None, "--dir", "-d", help="Where to create the workspace"),
    force: bool = typer.Option(False, "--force", help="Overwrite an existing workspace"),
) -> None:
    """Copy a task's starter repo into a workspace and show the stage 1 brief."""
    task = _task_or_exit(task_id)
    dest = dir or DEFAULT_WORKSPACE / task.id
    if dest.exists():
        if not force:
            _fail(f"{dest} already exists. Use --force to overwrite it (your changes there will be lost).")
        shutil.rmtree(dest)
    shutil.copytree(task.repo_dir, dest)
    (dest / MARKER).write_text(
        json.dumps({"task": task.id, "started_at": datetime.now(timezone.utc).isoformat()}, indent=2),
        encoding="utf-8",
    )
    console.print(f"[bold]{task.title}[/bold] — {task.time_limit_minutes} min, {len(task.stages)} stages")
    if task.summary:
        console.print(task.summary)
    console.print(f"Workspace: [green]{dest}[/green]")
    _print_stage(task, 1)
    console.print(
        f"Next: solve it (any AI assistant is allowed), then run [bold]ib grade --dir {dest}[/bold]. "
        f"See the next stage with [bold]ib prompt --dir {dest} -s 2[/bold]."
    )


@app.command()
def prompt(
    task_id: Optional[str] = typer.Argument(None, help="Task id (optional inside a workspace)"),
    stage: int = typer.Option(1, "--stage", "-s", help="Stage number"),
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
) -> None:
    """Show the brief for a stage."""
    _print_stage(_task_from_workspace(dir, task_id), stage)


@app.command()
def grade(
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory to grade"),
    task_id: Optional[str] = typer.Option(None, "--task", "-t", help="Task id (read from the workspace if omitted)"),
    output: Optional[Path] = typer.Option(None, "--output", "-o", help="Markdown report path"),
    timeout: int = typer.Option(DEFAULT_TIMEOUT, help="Per-stage test timeout in seconds"),
    judge: bool = typer.Option(False, "--judge", help="Also score the judge criteria with Claude (needs an API key)"),
    judge_model: Optional[str] = typer.Option(None, help="Claude model for --judge (default: $IB_JUDGE_MODEL or claude-opus-5-5)"),
) -> None:
    """Grade a workspace against the task's hidden tests and rubric."""
    if not dir.is_dir():
        _fail(f"{dir} is not a directory")
    task = _task_from_workspace(dir, task_id)
    with console.status("Running hidden tests..."):
        result = grade_workspace(task, dir, timeout=timeout)
    judge_error = None
    if judge:
        with console.status("Running the AI judge..."):
            try:
                run_judge(result, dir, model=judge_model, timeout=timeout)
            except JudgeError as exc:
                judge_error = str(exc)
    render(result, console)
    report_path = output or dir / "ib-report.md"
    report_path.write_text(to_markdown(result), encoding="utf-8")
    console.print(f"Report written to [green]{report_path}[/green]")
    if judge_error:
        _fail(f"AI judge failed, so only auto criteria were scored: {judge_error}")


@app.command()
def version() -> None:
    """Show the interviewbench version."""
    console.print(__version__)
