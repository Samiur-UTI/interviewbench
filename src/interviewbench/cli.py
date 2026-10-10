from __future__ import annotations

import json
import shutil
import tempfile
from datetime import datetime, timezone
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
    console.print(f"\n[bold cyan]Stage {stage.number}/{len(task.stages)}[/bold cyan]\n")
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
    shutil.copytree(task.starter_dir, dest)
    (dest / MARKER).write_text(
        json.dumps({"task": task.id, "started_at": datetime.now(timezone.utc).isoformat()}, indent=2),
        encoding="utf-8",
    )
    console.print(f"[bold]{task.title}[/bold] — {task.time_limit_minutes} min, {len(task.stages)} stages")
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
    report_path = output or dir / "ib-report.md"
    report_path.write_text(to_markdown(result), encoding="utf-8")
    console.print(f"Report written to [green]{report_path}[/green]")
    if judge_error:
        _fail(f"AI judge failed, so only auto criteria were scored: {judge_error}")


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
