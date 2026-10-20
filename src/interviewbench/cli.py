from __future__ import annotations

import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import NoReturn, Optional

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.table import Table

from . import __version__
from . import workspace as ws
from .breaker import BAD_TEST, REAL_BREAK, attack_prompt, run_break
from .grader import build_reference, grade as grade_workspace, run_candidate_tests
from .judge import JudgeError, apply_judgment, parse_reply, prepare_judge, run_judge
from .report import render, to_markdown
from .runner import RUNNERS, Runner, RunnerError, get_runner
from .tasks import (
    ATTACK_PROMPT, BRIEF, JUDGE_PROMPT, JUDGE_REPLY, MARKER, REPORT, Task, TaskError, bench_root,
    categories, get_task, load_all, tasks_root, templates_root,
)

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
    marker = ws.read_marker(workspace)
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
    git: bool = typer.Option(True, "--git/--no-git", help="Make the workspace a git repo, with a commit and tag per stage"),
) -> None:
    """Start a round: starter code in its own folder, TASK.md, git, editor tasks, and your editor opened on it."""
    task = _task_or_exit(task_id)
    dest = (dir or ws.default_workspace(task.id)).expanduser()
    if ws.is_inside(dest, bench_root()):
        _fail(
            f"{dest} is inside {bench_root()}, which holds the hidden tests and reference solutions, "
            f"so an AI assistant working there could read them. Pick a folder outside it, or leave out "
            f"--dir to use {ws.default_workspace(task.id)}."
        )
    if dest.exists():
        if not force:
            _fail(f"{dest} already exists. Use --force to overwrite it (your changes there will be lost).")
        shutil.rmtree(dest)
    shutil.copytree(task.starter_dir, dest)
    wrote_tasks = ws.write_editor_tasks(dest)
    git_ok = git and ws.git_init(dest, ignored=[ws.EDITOR_TASKS.as_posix()] if wrote_tasks else [])
    started = datetime.now(timezone.utc)
    ws.write_marker(dest, {"task": task.id, "started_at": started.isoformat(), "stage": 1, "git": git_ok})
    (dest / BRIEF).write_text(ws.brief(task, started, git_ok), encoding="utf-8")

    editor = ws.open_in_editor(dest) if open_editor else None
    console.print(f"[bold]{task.title}[/bold] — {task.time_limit_minutes} min, {len(task.stages)} stages")
    console.print(f"Workspace: [green]{dest}[/green]" + (f" (opened in {editor})" if editor else ""))
    if not editor:
        console.print(
            "Open [bold]only this folder[/bold] in your editor, so your AI assistant can't see the "
            f"hidden tests:  [bold]cd \"{dest}\"[/bold] then e.g. [bold]code .[/bold]"
        )
    if git and not git_ok:
        console.print("[dim]git isn't available, so the workspace is not a git repo.[/dim]")
    ends = started.astimezone() + timedelta(minutes=task.time_limit_minutes)
    console.print(f"The brief is in {BRIEF}. Your {task.time_limit_minutes} minutes started now; time is up at {ends:%H:%M}.")
    _print_stage(task, 1)
    console.print(
        "In the workspace: [bold]ib test[/bold] runs your tests, [bold]ib next[/bold] reveals the next "
        "stage, [bold]ib grade[/bold] scores your work (also under Terminal > Run Task in your editor)."
    )


def _workspace_or_exit(dir: Path) -> tuple[Task, dict]:
    marker = ws.read_marker(dir)
    if marker is None:
        _fail(f"{dir} is not an interviewbench workspace (no {MARKER}). Run this inside the folder `ib start` made.")
    return _task_or_exit(marker["task"]), marker


@app.command("next")
def next_stage(
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
) -> None:
    """Reveal the next stage: commit and tag your work so far, then add the next brief to TASK.md."""
    task, marker = _workspace_or_exit(dir)
    current = int(marker.get("stage", 1))
    if current >= len(task.stages):
        _fail(f"All {len(task.stages)} stages are already revealed. Run `ib grade` when you're done.")
    if marker.get("git") and ws.checkpoint(dir, f"Stage {current} done", tag=f"stage-{current}"):
        console.print(f"Committed your work and tagged it [bold]stage-{current}[/bold].")
    number = current + 1
    marker["stage"] = number
    ws.write_marker(dir, marker)
    ws.append_stage(dir, task, number)
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


@app.command("test")
def own_tests(
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
    runner: str = typer.Option("auto", help="Where tests run: auto (docker if running, else local), docker, local"),
    timeout: Optional[int] = typer.Option(None, help="Timeout in seconds (default: the task's)"),
) -> None:
    """Run your own tests, the way the grader does. Hidden tests stay hidden: no spoilers."""
    task, _ = _workspace_or_exit(dir)
    backend = _runner_or_exit(runner)
    with console.status(f"Running your tests ({backend.name} runner)..."):
        try:
            result = run_candidate_tests(task, dir, backend, timeout)
        except RunnerError as exc:
            _fail(str(exc))
    if result.error:
        _fail(f"Your tests could not run:\n{result.error}")
    for failure in result.failures:
        console.print(f"[red]FAIL[/red] {failure.name}: {failure.message}", highlight=False)
    color = "green" if result.passed == result.total and result.total else "red"
    console.print(f"[{color}]{result.passed}/{result.total} of your tests passed[/{color}]")
    if result.passed != result.total or not result.total:
        raise typer.Exit(1)


@app.command()
def grade(
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory to grade"),
    task_id: Optional[str] = typer.Option(None, "--task", "-t", help="Task id (read from the workspace if omitted)"),
    output: Optional[Path] = typer.Option(None, "--output", "-o", help="Markdown report path"),
    timeout: Optional[int] = typer.Option(None, help="Per-stage test timeout in seconds (default: the task's)"),
    runner: str = typer.Option("auto", help="Where tests run: auto (docker if running, else local), docker, local"),
    judge: bool = typer.Option(False, "--judge", help="Also score the judge criteria with an AI model (see --judge-backend)"),
    judge_backend: Optional[str] = typer.Option(None, help="claude (needs ANTHROPIC_API_KEY) or openai (any OpenAI-compatible API: set IB_JUDGE_BASE_URL and IB_JUDGE_API_KEY). Default: $IB_JUDGE_BACKEND, else claude"),
    judge_model: Optional[str] = typer.Option(None, help="Model for --judge (default: $IB_JUDGE_MODEL, else claude-opus-5-5 for claude)"),
    judge_export: bool = typer.Option(False, "--judge-export", help=f"Write the judge prompt to {JUDGE_PROMPT}, to paste into any chatbot"),
    judge_reply: Optional[Path] = typer.Option(None, "--judge-reply", help="Score the judge criteria from a chatbot's reply to the exported prompt"),
) -> None:
    """Grade a workspace against the task's hidden tests and rubric, optionally with an AI judge."""
    if sum((judge, judge_export, judge_reply is not None)) > 1:
        _fail("Use only one of --judge, --judge-export and --judge-reply.")
    if not dir.is_dir():
        _fail(f"{dir} is not a directory")
    if judge_reply is not None and not judge_reply.is_file():
        _fail(f"{judge_reply} doesn't exist. Save the chatbot's reply there first.")
    task = _task_from_workspace(dir, task_id)
    backend = _runner_or_exit(runner)
    with console.status(f"Running hidden tests ({backend.name} runner)..."):
        try:
            result = grade_workspace(task, dir, backend, timeout=timeout)
        except RunnerError as exc:
            _fail(str(exc))
    judge_error = None
    if judge or judge_export or judge_reply is not None:
        with console.status("Running the AI judge..." if judge else "Preparing the judge prompt..."):
            try:
                if judge:
                    run_judge(result, dir, runner=backend, model=judge_model, timeout=timeout, backend=judge_backend)
                else:
                    request = prepare_judge(result, dir, runner=backend, timeout=timeout)
                    if judge_export:
                        (dir / JUDGE_PROMPT).write_text(request.as_paste(), encoding="utf-8")
                    else:
                        reply = parse_reply(judge_reply.read_text(encoding="utf-8"))
                        apply_judgment(result, request, reply, f"pasted reply ({judge_reply.name})")
            except (JudgeError, RunnerError) as exc:
                judge_error = str(exc)
    render(result, console)
    marker = ws.read_marker(dir)
    if marker and "started_at" in marker:
        used = datetime.now(timezone.utc) - datetime.fromisoformat(marker["started_at"])
        console.print(f"Time used: {int(used.total_seconds() // 60)} min of {task.time_limit_minutes}\n")
    report_path = output or dir / REPORT
    report_path.write_text(to_markdown(result), encoding="utf-8")
    console.print(f"Report written to [green]{report_path}[/green]")
    if judge_error:
        _fail(f"AI judge failed, so only auto criteria were scored: {judge_error}")
    if judge_export:
        prompt_path = dir / JUDGE_PROMPT
        size = len(prompt_path.read_text(encoding="utf-8")) // 4
        console.print(
            f"\nJudge prompt written to [green]{prompt_path}[/green] (~{size:,} tokens). Paste all of it into any "
            f"chatbot (ChatGPT, Gemini, Claude.ai, DeepSeek...), save its reply as [bold]{JUDGE_REPLY}[/bold] in "
            f"the workspace, then run [bold]ib grade --judge-reply {JUDGE_REPLY}[/bold]. The prompt contains the "
            "hidden tests and the reference solution, so don't share it."
        )


@app.command("break")
def break_code(
    attack: Optional[Path] = typer.Argument(None, help="Test file of attack tests, written by any LLM"),
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
    runner: str = typer.Option("auto", help="Where tests run: auto (docker if running, else local), docker, local"),
    timeout: Optional[int] = typer.Option(None, help="Timeout per test run in seconds (default: the task's)"),
    write_prompt: bool = typer.Option(False, "--prompt", help=f"Write {ATTACK_PROMPT}: ask any chatbot or agent to write attack tests"),
) -> None:
    """Try to break your code: run attack tests on it and on the reference; only real breaks count."""
    task, marker = _workspace_or_exit(dir)
    if write_prompt:
        revealed = min(int(marker.get("stage", len(task.stages))), len(task.stages))
        path = dir / ATTACK_PROMPT
        path.write_text(attack_prompt(task, dir, revealed), encoding="utf-8")
        console.print(
            f"Wrote [green]{path}[/green]. Give it to any chatbot or coding agent, save the test file it writes "
            f"[bold]outside[/bold] this folder (e.g. ../attack_test.py), then run [bold]ib break ../attack_test.py[/bold]."
        )
        return
    if attack is None:
        _fail("Pass the attack test file, or use --prompt to get a prompt that asks an LLM to write one.")
    backend = _runner_or_exit(runner)
    with console.status(f"Running the attack tests on your code and on the reference ({backend.name} runner)..."):
        try:
            attacks = run_break(task, dir, attack, backend, timeout)
        except RunnerError as exc:
            _fail(str(exc))
    table = Table()
    for col in ("Verdict", "Attack test", "Detail"):
        table.add_column(col)
    style = {REAL_BREAK: "red", BAD_TEST: "dim"}
    for a in attacks:
        color = style.get(a.verdict, "green")
        table.add_row(f"[{color}]{a.verdict}[/{color}]", a.name, a.detail)
    console.print(table)
    counts = {v: sum(a.verdict == v for a in attacks) for v in (REAL_BREAK, BAD_TEST)}
    survived = len(attacks) - sum(counts.values())
    console.print(
        f"[bold]{counts[REAL_BREAK]} real break(s)[/bold], {survived} survived, "
        f"{counts[BAD_TEST]} bad test(s) ignored (they fail on the reference solution too)."
    )


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
