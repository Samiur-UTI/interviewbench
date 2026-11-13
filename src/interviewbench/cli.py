from __future__ import annotations

import sys
import time
import webbrowser
from pathlib import Path
from typing import NoReturn, Optional

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.markup import escape
from rich.table import Table

from . import __version__, rounds
from . import workspace as ws
from .breaker import BAD_TEST, REAL_BREAK
from .grader import run_candidate_tests
from .report import render
from .rounds import check_task
from .runner import Runner, RunnerError, get_runner
from .tasks import (
    ATTACK_PROMPT, BRIEF, FULL_REPORT, JUDGE_PROMPT, JUDGE_REPLY, MARKER, REPORT, Task, TaskError, get_task,
    load_each,
)
from .ui.server import serve

app = typer.Typer(
    help="Realistic AI-era coding interview tasks with rubrics and a grader.\n\n"
    "Run `ib` alone to open the GUI in your browser, or use the commands below.",
    invoke_without_command=True,
    add_completion=False,
)
console = Console()


@app.callback()
def _root(ctx: typer.Context) -> None:
    _utf8_output()
    if ctx.invoked_subcommand is None:
        # The GUI is the front door; `ib --help` lists the commands for people who prefer a terminal.
        console.print("[dim]Prefer the terminal? `ib --help` lists the commands.[/dim]")
        ui(port=7473, open_browser=True)


def _utf8_output() -> None:
    """On Windows, Python writes pipes and files in the ANSI code page (cp1252), which can't encode
    characters the briefs use (U+2212, Rich's spinner), so `ib prompt ... | more` or
    `ib start ... > log` crashed with UnicodeEncodeError. Write UTF-8 whatever stdout is."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass  # not a TextIOWrapper (e.g. replaced by a test harness): leave it


def _fail(message: str) -> NoReturn:
    console.print(f"[red]Error:[/red] {escape(message)}")
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


def _marker_or_exit(workspace: Path, advice: str) -> Optional[dict]:
    try:
        return ws.load_marker(workspace)
    except ws.MarkerError as exc:
        _fail(f"{exc} ib can't tell which round this folder holds. {advice}")


_NEW_ROUND = "Start a new round in a new folder: ib start <task> --dir <folder>."


def _task_from_workspace(workspace: Path, task_id: Optional[str], advice: str) -> Task:
    if task_id:
        return _task_or_exit(task_id)
    marker = _marker_or_exit(workspace, advice)
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
    loaded = load_each()
    broken = [d for d, t in loaded if isinstance(t, TaskError)]
    tasks = [
        t for _, t in loaded
        if isinstance(t, Task) and (category is None or t.category == category) and (tag is None or tag in t.tags)
    ]
    table = Table()
    for col in ("ID", "Category", "Title", "Level", "Tags", "Time"):
        table.add_column(col)
    for t in tasks:
        table.add_row(
            escape(t.id), escape(t.category), escape(t.title), escape(t.level), escape(", ".join(t.tags)),
            f"{t.time_limit_minutes} min",
        )
    console.print(table)
    for d in broken:
        console.print(
            f"[yellow]Skipped {escape(f'{d.parent.name}/{d.name}')}:[/yellow] it doesn't load. "
            f"Run [bold]ib validate {escape(d.name)}[/bold] to see why."
        )


@app.command()
def start(
    task_id: str = typer.Argument(..., help="Task to start, e.g. rate-limiter"),
    dir: Optional[Path] = typer.Option(None, "--dir", "-d", help="Where to create the workspace (default: ~/ib-workspaces/<task>, or $IB_WORKSPACES/<task>)"),
    force: bool = typer.Option(False, "--force", help="Replace an earlier round in that folder (your work there is lost). Only a folder ib start made is ever deleted"),
    open_editor: bool = typer.Option(True, "--open/--no-open", help="Open the workspace in your editor ($IB_EDITOR, else VS Code, Cursor or Windsurf)"),
    git: bool = typer.Option(True, "--git/--no-git", help="Make the workspace a git repo, with a commit and tag per stage"),
) -> None:
    """Start a round: starter code in its own folder, TASK.md, git, editor tasks, and your editor opened on it."""
    task = _task_or_exit(task_id)
    dest = (dir or ws.default_workspace(task.id)).expanduser()
    try:
        started = rounds.start_round(task, dest, force=force, git=git, open_editor=open_editor)
    except rounds.RoundError as exc:
        _fail(str(exc))
    editor = started.editor
    shown = escape(str(dest))
    console.print(f"[bold]{escape(task.title)}[/bold] — {task.time_limit_minutes} min, {len(task.stages)} stages")
    console.print(f"Workspace: [green]{shown}[/green]" + (f" (opened in {escape(editor)})" if editor else ""))
    if not editor:
        console.print(
            "Open [bold]only this folder[/bold] in your editor, so your AI assistant can't see the "
            f"hidden tests:  [bold]cd \"{shown}\"[/bold] then e.g. [bold]code .[/bold]"
        )
    if git and not started.git:
        console.print("[dim]git isn't available, so the workspace is not a git repo.[/dim]")
    console.print(f"The brief is in {BRIEF}. Your {task.time_limit_minutes} minutes started now; time is up at {started.ends:%H:%M}.")
    _print_stage(task, 1)
    console.print(
        "In the workspace: [bold]ib test[/bold] runs your tests, [bold]ib next[/bold] reveals the next "
        "stage, [bold]ib grade[/bold] scores your work (also under Terminal > Run Task in your editor)."
    )


def _workspace_or_exit(dir: Path) -> tuple[Task, dict]:
    marker = _marker_or_exit(dir, _NEW_ROUND)
    if marker is None:
        _fail(f"{dir} is not an interviewbench workspace (no {MARKER}). Run this inside the folder `ib start` made.")
    return _task_or_exit(marker["task"]), marker


@app.command("next")
def next_stage(
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
) -> None:
    """Reveal the next stage: commit and tag your work so far, then add the next brief to TASK.md."""
    task, marker = _workspace_or_exit(dir)
    try:
        revealed = rounds.next_stage(task, dir, marker)
    except rounds.RoundError as exc:
        _fail(str(exc))
    if revealed.tagged:
        console.print(f"Committed your work and tagged it [bold]{escape(revealed.tagged)}[/bold].")
    _print_stage(task, revealed.number)
    console.print(f"Added to {BRIEF}.")


@app.command()
def prompt(
    task_id: Optional[str] = typer.Argument(None, help="Task id (optional inside a workspace)"),
    stage: int = typer.Option(1, "--stage", "-s", help="Stage number"),
    dir: Path = typer.Option(Path("."), "--dir", "-d", help="Workspace directory"),
) -> None:
    """Show the brief for a stage (reading ahead skips the real format; prefer `ib next`)."""
    _print_stage(_task_from_workspace(dir, task_id, "Pass the task id: ib prompt <task>."), stage)


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
        console.print(f"[red]FAIL[/red] {escape(failure.name)}: {escape(failure.message)}", highlight=False)
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
    judge_export: bool = typer.Option(False, "--judge-export", help="Write the judge prompt, to paste into any chatbot. It goes outside the workspace (in $IB_DATA_DIR, else your app data folder), since it holds the hidden tests; the path is printed"),
    judge_reply: Optional[Path] = typer.Option(None, "--judge-reply", help="Score the judge criteria from a chatbot's reply to the exported prompt"),
    all_stages: bool = typer.Option(False, "--all-stages", help="Show which hidden tests fail in every stage, including stages the round hasn't reached (for an interviewer grading a hand-back). The report then goes to --output, else outside the workspace"),
) -> None:
    """Grade a workspace against the task's hidden tests and rubric, optionally with an AI judge.

    Every stage's hidden tests run, but inside a round only the stages you've reached show which tests
    fail; later stages show a count.
    """
    if sum((judge, judge_export, judge_reply is not None)) > 1:
        _fail("Use only one of --judge, --judge-export and --judge-reply.")
    if not dir.is_dir():
        _fail(f"{dir} is not a directory")
    if judge_reply is not None and not judge_reply.is_file():
        _fail(f"{judge_reply} doesn't exist. Save the chatbot's reply there first.")
    task = _task_from_workspace(dir, task_id, f"Pass --task <task> to grade it anyway. Or: {_NEW_ROUND}")
    backend = _runner_or_exit(runner)
    revealed = rounds.revealed_stages(task, ws.read_marker(dir))
    if all_stages and revealed is not None and revealed < len(task.stages):
        # The full report would spoil the round for an AI assistant reading the workspace.
        if output is not None and ws.is_inside(output, dir):
            _fail(
                f"--all-stages reports stages this round hasn't reached, so its report can't go inside the "
                f"workspace. Pass an --output outside {dir}."
            )
        try:
            output = output or rounds.private_folder(dir) / FULL_REPORT
        except rounds.RoundError as exc:
            _fail(str(exc))
    mode = "api" if judge else "prepare" if judge_export else "reply" if judge_reply is not None else "none"
    with console.status(f"Running hidden tests ({backend.name} runner)...") as status:
        try:
            outcome = rounds.grade_round(
                task, dir, backend, judge=mode, settings=rounds.JudgeSettings(judge_backend, judge_model),
                reply=judge_reply.read_text(encoding="utf-8") if judge_reply is not None else None,
                reply_label=f"pasted reply ({judge_reply.name})" if judge_reply is not None else "",
                timeout=timeout, report_path=output, progress=lambda phase: status.update(f"{escape(phase)}..."),
                all_stages=all_stages,
            )
        except (RunnerError, rounds.RoundError) as exc:
            _fail(str(exc))
    exported = None
    if judge_export and outcome.request:
        try:
            exported = rounds.export_judge_prompt(dir, outcome.request)
        except (rounds.RoundError, OSError) as exc:
            _fail(f"Couldn't write the judge prompt: {exc}")
    render(outcome.result, console, outcome.revealed)
    used = rounds.time_used_minutes(ws.read_marker(dir))
    if used is not None:
        console.print(f"Time used: {used} min of {task.time_limit_minutes}\n")
    console.print(f"Report written to [green]{escape(str(output or dir / REPORT))}[/green]")
    if outcome.judge_error:
        _fail(f"AI judge failed, so only auto criteria were scored: {outcome.judge_error}")
    if exported:
        prompt_path, reply_path = escape(str(exported.path)), escape(str(exported.path.parent / JUDGE_REPLY))
        console.print(
            f"\nJudge prompt written to [green]{prompt_path}[/green] (~{exported.tokens:,} tokens), outside the "
            "workspace: it contains the hidden tests and the reference solution, so don't share it or copy it into "
            "the workspace. Paste all of it into any chatbot (ChatGPT, Gemini, Claude.ai, DeepSeek...), save its "
            f"reply as [bold]{reply_path}[/bold], then run [bold]ib grade --judge-reply \"{reply_path}\"[/bold].",
            highlight=False, soft_wrap=True,  # no line breaks inside the paths, so they copy cleanly
        )
        if exported.removed_stale:
            console.print(f"[dim]Deleted the old {JUDGE_PROMPT} an earlier ib version left in the workspace.[/dim]")


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
        path = escape(str(rounds.write_attack_prompt(task, dir, marker)))
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
            outcome = rounds.break_round(task, dir, attack, backend, timeout)
        except RunnerError as exc:
            _fail(str(exc))
    table = Table()
    for col in ("Verdict", "Attack test", "Detail"):
        table.add_column(col)
    style = {REAL_BREAK: "red", BAD_TEST: "dim"}
    for a in outcome.attacks:
        color = style.get(a.verdict, "green")
        table.add_row(f"[{color}]{a.verdict}[/{color}]", escape(a.name), escape(a.detail))
    console.print(table)
    counts = outcome.counts
    console.print(
        f"[bold]{counts['real_break']} real break(s)[/bold], {counts['survived']} survived, "
        f"{counts['bad_test']} bad test(s) ignored (they fail on the reference solution too)."
    )


@app.command()
def new(
    task_id: str = typer.Argument(..., help="New task id (its folder name), e.g. order-api"),
    category: str = typer.Option(..., "--category", "-c", help="Task category, e.g. backend"),
    template: Optional[str] = typer.Option(None, "--template", help="Folder under templates/ (default: the first <category>-* one)"),
) -> None:
    """Create a task skeleton from a template (run inside a clone of the repo)."""
    try:
        created = rounds.new_task(task_id, category, template)
    except rounds.RoundError as exc:
        _fail(str(exc))
    console.print(f"Created [green]{escape(str(created.path))}[/green] from templates/{escape(created.template)}.")
    console.print(
        f"Fill in every TODO, then run [bold]ib validate {escape(task_id)} --run[/bold]. See docs/TASK_FORMAT.md."
    )


@app.command()
def validate(
    task_ids: Optional[list[str]] = typer.Argument(None, help="Tasks to check (default: all)"),
    run: bool = typer.Option(False, "--run", help="Also run the tests: the starter must fail stage 1 and each stage's solution must pass it"),
    runner: str = typer.Option("auto", help="Runner for --run: auto, docker, local"),
) -> None:
    """Check tasks follow docs/TASK_FORMAT.md."""
    loaded = load_each()
    if task_ids:
        unknown = [t for t in task_ids if t not in {d.name for d, _ in loaded}]
        if unknown:
            _fail(f"Unknown task '{unknown[0]}'. Available: {', '.join(d.name for d, _ in loaded) or 'none'}")
        loaded = [(d, t) for d, t in loaded if d.name in task_ids]
    backend = _runner_or_exit(runner) if run else None
    failed = False
    for path, task in loaded:
        if isinstance(task, TaskError):
            errors = [str(task)]
        else:
            errors = check_task(task, backend) if backend else []
        verdict = "[green]ok[/green]" if not errors else "[red]FAIL[/red]"
        console.print(f"{verdict} {escape(f'{path.parent.name}/{path.name}')}")
        for error in errors:
            console.print(f"   - {error}", markup=False)
        failed = failed or bool(errors)
    if failed:
        raise typer.Exit(1)


@app.command()
def ui(
    port: int = typer.Option(7473, help="Port on 127.0.0.1 (the next free one if it's taken)"),
    open_browser: bool = typer.Option(True, "--open/--no-open", help="Open the GUI in your browser"),
) -> None:
    """Start the local web GUI: everything `ib` does, in your browser."""
    try:
        server = serve(port)
    except OSError as exc:
        _fail(str(exc))
    console.print("[bold]interviewbench[/bold] is running. This link is your private way in:")
    console.print(server.url, markup=False, highlight=False, soft_wrap=True)
    console.print("[dim]Press Ctrl+C to stop.[/dim]")
    if open_browser:
        webbrowser.open(server.url)
    try:
        while True:
            time.sleep(1)  # a plain wait: Ctrl+C on Windows can't interrupt a blocked lock
    except KeyboardInterrupt:
        console.print("Stopped.")
    finally:
        server.stop()


@app.command()
def version() -> None:
    """Show the interviewbench version."""
    console.print(__version__)
