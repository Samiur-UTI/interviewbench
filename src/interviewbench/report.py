from __future__ import annotations

from rich.console import Console
from rich.markup import escape
from rich.table import Table

from .grader import CriterionScore, GradeResult
from .tasks import Criterion

MAX_FAILURES_SHOWN = 5
# Spoiler rules, shared with the GUI: a stage the round hasn't reached shows how many of its hidden
# tests failed, never which ones or why, and its auto criterion doesn't say what the stage is about.
WITHHELD_ERROR = "This stage's hidden tests could not run. The details stay hidden until it's revealed."


def is_hidden(stage: int | None, revealed: int | None) -> bool:
    """revealed: the stages the round has reached, or None to show everything."""
    return revealed is not None and stage is not None and stage > revealed


def criterion_description(criterion: Criterion, revealed: int | None) -> str:
    """An auto criterion says what its stage is about, so it counts as part of that stage's brief."""
    if criterion.type == "auto" and is_hidden(criterion.stage, revealed):
        return f"Hidden tests for stage {criterion.stage}."
    return criterion.description


def _evidence(result: GradeResult, s: CriterionScore, revealed: int | None) -> str:
    stage = next((st for st in result.stages if st.stage == s.criterion.stage), None)
    if s.criterion.type == "auto" and is_hidden(s.criterion.stage, revealed) and stage and stage.error:
        return WITHHELD_ERROR  # the evidence is the stage's error, which quotes test output
    return s.evidence


def _withheld_line(stage: int, failures: int) -> str:
    noun = "test fails" if failures == 1 else "tests fail"
    return f"Stage {stage}: {failures} hidden {noun}. You'll see which once you reach stage {stage}."


def _pct(score: float | None) -> str:
    return "-" if score is None else f"{score * 100:.0f}%"


def summary_line(result: GradeResult) -> str:
    graded, total = result.graded_weight, result.total_weight
    pct = result.points / graded * 100 if graded else 0.0
    pending = total - graded
    if not pending:
        return f"Score: {result.points:.1f}/{total:.0f} ({pct:.0f}%)"
    scope = "auto-checked criteria" if result.review is None else "the criteria graded so far"
    return (
        f"Score: {result.points:.1f}/{graded:.0f} on {scope} ({pct:.0f}%); "
        f"{pending:.0f} of {total:.0f} rubric points need the AI judge"
    )


def render(result: GradeResult, console: Console, revealed: int | None = None) -> None:
    console.print(
        f"\n[bold]{escape(result.task.title)}[/bold]  ({escape(f'{result.task.category}/{result.task.id}')}, "
        f"{escape(result.runner)} runner)"
    )
    table = Table(show_lines=False)
    table.add_column("Criterion")
    table.add_column("Type")
    table.add_column("Weight", justify="right")
    table.add_column("Score", justify="right")
    table.add_column("Evidence")
    for s in result.scores:
        color = "dim" if s.score is None else ("green" if s.score == 1 else "yellow" if s.score > 0 else "red")
        table.add_row(
            escape(s.criterion.id), escape(s.criterion.type), f"{s.criterion.weight:.0f}",
            f"[{color}]{_pct(s.score)}[/{color}]", escape(_evidence(result, s, revealed)),
        )
    console.print(table)
    for stage in result.stages:
        if is_hidden(stage.stage, revealed):
            if stage.error:
                console.print(f"[dim]Stage {stage.stage}: {WITHHELD_ERROR}[/dim]")
            elif stage.failures:
                console.print(f"[dim]{_withheld_line(stage.stage, len(stage.failures))}[/dim]")
            continue
        if stage.error:
            console.print(f"[red]Stage {stage.stage} could not run:[/red]\n{escape(stage.error)}")
        for f in stage.failures[:MAX_FAILURES_SHOWN]:
            console.print(f"[red]FAIL[/red] stage {stage.stage} - {escape(f.name)}: {escape(f.message)}")
        hidden = len(stage.failures) - MAX_FAILURES_SHOWN
        if hidden > 0:
            console.print(f"[dim]...and {hidden} more failing tests in stage {stage.stage}[/dim]")
    if result.review:
        console.print(f"\n[bold]AI review[/bold] ({escape(result.review.model)})")
        for line in _review_lines(result):
            console.print(line, markup=False)
    console.print(f"\n[bold]{summary_line(result)}[/bold]\n")


def to_markdown(result: GradeResult, revealed: int | None = None) -> str:
    """The report. With `revealed`, stages past it keep only their failure counts (see is_hidden)."""
    lines = [
        f"# interviewbench report: {result.task.title}",
        "",
        f"**{summary_line(result)}**",
        "",
        f"Task: `{result.task.category}/{result.task.id}` · Hidden tests ran with the {result.runner} runner",
        "",
        "| Criterion | Type | Weight | Score | Evidence |",
        "|---|---|---:|---:|---|",
    ]
    for s in result.scores:
        lines.append(
            f"| {s.criterion.id} | {s.criterion.type} | {s.criterion.weight:.0f} | {_pct(s.score)} "
            f"| {_evidence(result, s, revealed)} |"
        )
    shown = [st for st in result.stages if not is_hidden(st.stage, revealed)]
    hidden = [st for st in result.stages if is_hidden(st.stage, revealed) and (st.error or st.failures)]
    failing = [(st.stage, f) for st in shown for f in st.failures]
    errors = [st for st in shown if st.error]
    if failing or errors or hidden:
        lines += ["", "## Failing hidden tests", ""]
        for st in errors:
            lines += [f"- Stage {st.stage} could not run:", "", "```", st.error or "", "```"]
        for stage, f in failing:
            lines.append(f"- Stage {stage} `{f.name}`: {f.message}")
        for st in hidden:
            lines.append(
                f"- Stage {st.stage}: {WITHHELD_ERROR}" if st.error else f"- {_withheld_line(st.stage, len(st.failures))}"
            )
    if result.review:
        lines += ["", f"## AI review ({result.review.model})", "", *_review_lines(result)]
    lines += ["", "## Rubric", ""]
    for s in result.scores:
        lines.append(
            f"- **{s.criterion.id}** ({s.criterion.weight:.0f} pts): {criterion_description(s.criterion, revealed)}"
        )
    return "\n".join(lines) + "\n"


def _review_lines(result: GradeResult) -> list[str]:
    review = result.review
    assert review is not None
    tests = review.candidate_tests
    ran = tests.error or f"{tests.passed}/{tests.total} passed"
    lines = [review.summary, "", f"- Candidate's own tests: {ran}"]
    lines += [f"- Missed edge case: {case}" for case in review.missed_edge_cases]
    lines += [f"- [{i.severity}] {i.category} at {i.location}: {i.description}" for i in review.issues]
    return lines
