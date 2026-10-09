from __future__ import annotations

from rich.console import Console
from rich.table import Table

from .grader import GradeResult

MAX_FAILURES_SHOWN = 5


def _pct(score: float | None) -> str:
    return "-" if score is None else f"{score * 100:.0f}%"


def summary_line(result: GradeResult) -> str:
    graded, total = result.graded_weight, result.total_weight
    pct = result.points / graded * 100 if graded else 0.0
    line = f"Score: {result.points:.1f}/{graded:.0f} on auto-checked criteria ({pct:.0f}%)"
    pending = total - graded
    if pending:
        line += f"; {pending:.0f} of {total:.0f} rubric points need the AI judge"
    return line


def render(result: GradeResult, console: Console) -> None:
    console.print(f"\n[bold]{result.task.title}[/bold]  ({result.task.id})")
    table = Table(show_lines=False)
    table.add_column("Criterion")
    table.add_column("Type")
    table.add_column("Weight", justify="right")
    table.add_column("Score", justify="right")
    table.add_column("Evidence")
    for s in result.scores:
        color = "dim" if s.score is None else ("green" if s.score == 1 else "yellow" if s.score > 0 else "red")
        table.add_row(
            s.criterion.id, s.criterion.type, f"{s.criterion.weight:.0f}",
            f"[{color}]{_pct(s.score)}[/{color}]", s.evidence,
        )
    console.print(table)
    for stage in result.stages:
        if stage.error:
            console.print(f"[red]Stage {stage.stage} could not run:[/red]\n{stage.error}")
        for f in stage.failures[:MAX_FAILURES_SHOWN]:
            console.print(f"[red]FAIL[/red] stage {stage.stage} - {f.name}: {f.message}")
        hidden = len(stage.failures) - MAX_FAILURES_SHOWN
        if hidden > 0:
            console.print(f"[dim]...and {hidden} more failing tests in stage {stage.stage}[/dim]")
    if result.review:
        console.print(f"\n[bold]AI review[/bold] ({result.review.model})")
        for line in _review_lines(result):
            console.print(line, markup=False)
    console.print(f"\n[bold]{summary_line(result)}[/bold]\n")


def to_markdown(result: GradeResult) -> str:
    lines = [
        f"# interviewbench report: {result.task.title}",
        "",
        f"**{summary_line(result)}**",
        "",
        "| Criterion | Type | Weight | Score | Evidence |",
        "|---|---|---:|---:|---|",
    ]
    for s in result.scores:
        lines.append(
            f"| {s.criterion.id} | {s.criterion.type} | {s.criterion.weight:.0f} | {_pct(s.score)} | {s.evidence} |"
        )
    failing = [(st.stage, f) for st in result.stages for f in st.failures]
    errors = [st for st in result.stages if st.error]
    if failing or errors:
        lines += ["", "## Failing hidden tests", ""]
        for st in errors:
            lines += [f"- Stage {st.stage} could not run:", "", "```", st.error or "", "```"]
        for stage, f in failing:
            lines.append(f"- Stage {stage} `{f.name}`: {f.message}")
    if result.review:
        lines += ["", f"## AI review ({result.review.model})", "", *_review_lines(result)]
    lines += ["", "## Rubric", ""]
    for s in result.scores:
        lines.append(f"- **{s.criterion.id}** ({s.criterion.weight:.0f} pts): {s.criterion.description}")
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
