"""Dataclasses -> the JSON shapes in docs/GUI.md, including the spoiler rules, and ib-ui.json.

Stored results keep every stage's failures, so a failure in stage 2 appears once stage 2 is revealed,
without grading again. That makes ib-ui.json a spoiler, so it lives in ib's private folder for the
workspace, not in the workspace. What's withheld from the browser is decided here, per request, with
the rules in report.py that ib-report.md follows too.
"""

from __future__ import annotations

import json
from pathlib import Path

from .. import workspace as ws
from ..grader import GradeResult, StageResult, TestFailure, score
from ..judge import Review
from ..report import WITHHELD_ERROR, criterion_description, is_hidden, summary_line
from ..rounds import BreakOutcome, Changes, RoundInfo, TaskCheck, private_folder
from ..tasks import UI_STATE, Task
from .jobs import now_iso


# --- ib-ui.json -----------------------------------------------------------------------------


def read_state(workspace: Path) -> dict:
    """The stored results. A missing or damaged file just means there are none."""
    try:
        state = json.loads((ws.private_dir(workspace) / UI_STATE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def write_state(workspace: Path, state: dict) -> None:
    """Raises RoundError when the private folder would be inside the workspace."""
    (private_folder(workspace) / UI_STATE).write_text(json.dumps(state, indent=2), encoding="utf-8")
    (workspace / UI_STATE).unlink(missing_ok=True)  # an earlier ib kept it in the workspace, spoilers and all


def prior_result(stored: dict | None, task: Task, fingerprint: str, runner: str) -> GradeResult | None:
    """The stored grade as a GradeResult, if it is for this exact code and runner."""
    if not stored or stored.get("fingerprint") != fingerprint or stored.get("runner") != runner:
        return None
    try:
        stages = [
            StageResult(
                s["stage"], s["passed"], s["total"],
                [TestFailure(f["name"], f["message"]) for f in s["failures"]], s["error"],
            )
            for s in stored["stages"]
        ]
        return score(task, stages, runner)
    except (KeyError, TypeError):
        return None


# --- Tasks and rounds -----------------------------------------------------------------------


def task_view(task: Task, revealed: int = 0) -> dict:
    return {
        "id": task.id,
        "title": task.title,
        "category": task.category,
        "tags": task.tags,
        "level": task.level,
        "difficulty": task.difficulty,
        "language": task.language,
        "time_limit_minutes": task.time_limit_minutes,
        "stage_count": len(task.stages),
        "rubric": [
            {"id": c.id, "type": c.type, "weight": c.weight, "description": criterion_description(c, revealed)}
            for c in task.criteria
        ],
    }


def round_summary(info: RoundInfo, state: dict, active_job: str | None) -> dict:
    grade = state.get("grade")
    return {
        "id": info.id,
        "task_id": info.task.id,
        "title": info.task.title,
        "path": str(info.path),
        "started_at": info.started.isoformat() if info.started else None,
        "ends_at": info.ends.isoformat() if info.ends else None,
        "time_limit_minutes": info.task.time_limit_minutes,
        "stage": info.stage,
        "stage_count": len(info.task.stages),
        "score_percent": grade.get("percent") if isinstance(grade, dict) else None,
        "active_job": active_job,
    }


def round_view(info: RoundInfo, state: dict, active_job: str | None, judge_prepared: bool) -> dict:
    task = info.task
    return {
        **round_summary(info, state, active_job),
        "task": task_view(task, info.stage),
        "git": bool(info.marker.get("git")),
        "stages": [
            {"number": s.number, "title": s.title, "markdown": s.prompt.partition("\n")[2].strip()}
            for s in task.stages[:info.stage]
        ],
        "all_revealed": info.stage >= len(task.stages),
        "last": {
            "test": state.get("test"),
            "grade": _stored_grade_view(state.get("grade"), task, info.stage, judge_prepared),
            "break": state.get("break"),
        },
    }


# --- Results --------------------------------------------------------------------------------


def _failures(failures: list[TestFailure]) -> list[dict]:
    return [{"name": f.name, "message": f.message} for f in failures]


def candidate_tests_view(result: StageResult, runner: str) -> dict:
    return {
        "passed": result.passed,
        "total": result.total,
        "failures": _failures(result.failures),
        "error": result.error,
        "runner": runner,
        "finished_at": now_iso(),
    }


def _review_record(review: Review | None, runner: str) -> dict | None:
    if review is None:
        return None
    return {
        "model": review.model,
        "summary": review.summary,
        "candidate_tests": candidate_tests_view(review.candidate_tests, runner),
        "missed_edge_cases": review.missed_edge_cases,
        "issues": [
            {"severity": i.severity, "category": i.category, "location": i.location, "description": i.description}
            for i in review.issues
        ],
    }


def grade_record(
    result: GradeResult, *, fingerprint: str, judge_error: str | None, time_used: int | None, report_path: Path
) -> dict:
    """A grade as ib-ui.json stores it: a GradeView before the spoiler rules, plus the fingerprint."""
    graded, total = result.graded_weight, result.total_weight
    return {
        "fingerprint": fingerprint,
        "runner": result.runner,
        "summary": summary_line(result),
        "percent": result.points / graded * 100 if graded else 0.0,
        "points": result.points,
        "graded_weight": graded,
        "total_weight": total,
        "pending_weight": total - graded,
        "time_used_minutes": time_used,
        "report_path": str(report_path),
        "finished_at": now_iso(),
        "judge_error": judge_error,
        "stages": [
            {"stage": s.stage, "passed": s.passed, "total": s.total, "failures": _failures(s.failures), "error": s.error}
            for s in result.stages
        ],
        "criteria": [
            {
                "id": s.criterion.id,
                "type": s.criterion.type,
                "weight": s.criterion.weight,
                "score": s.score,
                "evidence": s.evidence,
                "description": s.criterion.description,
                "stage": s.criterion.stage,
            }
            for s in result.scores
        ],
        "review": _review_record(result.review, result.runner),
    }


def _stage_view(stage: dict, task: Task, revealed: int) -> dict:
    number = stage["stage"]
    if not is_hidden(number, revealed):
        title = next((s.title for s in task.stages if s.number == number), None)
        return {**stage, "title": title, "revealed": True, "withheld_failures": 0}
    return {
        **stage,
        "title": None,
        "revealed": False,
        "failures": [],
        "withheld_failures": len(stage["failures"]),
        "error": WITHHELD_ERROR if stage["error"] else None,
    }


def _criterion_view(entry: dict, task: Task, stages: dict[int, dict], revealed: int) -> dict:
    stage = entry.get("stage")
    criterion = next((c for c in task.criteria if c.id == entry["id"]), None)
    view = dict(entry)
    if criterion is not None:
        view["description"] = criterion_description(criterion, revealed)
    if entry["type"] == "auto" and is_hidden(stage, revealed) and stages.get(stage, {}).get("error"):
        view["evidence"] = WITHHELD_ERROR  # evidence repeats the stage's error, which quotes test output
    return view


def grade_view(stored: dict, task: Task, revealed: int, judge_prepared: bool) -> dict:
    """What the browser sees of a stored grade. Unrevealed stages keep only their counts."""
    by_stage = {s["stage"]: s for s in stored["stages"]}
    view = {k: v for k, v in stored.items() if k != "fingerprint"}
    return {
        **view,
        "stages": [_stage_view(s, task, revealed) for s in stored["stages"]],
        "criteria": [_criterion_view(c, task, by_stage, revealed) for c in stored["criteria"]],
        "judge_prepared": judge_prepared,
    }


def _stored_grade_view(stored: object, task: Task, revealed: int, judge_prepared: bool) -> dict | None:
    if not stored:
        return None
    try:
        return grade_view(stored, task, revealed, judge_prepared)
    except (AttributeError, KeyError, TypeError):  # a damaged ib-ui.json
        return None


def break_view(outcome: BreakOutcome, runner: str) -> dict:
    return {
        "attacks": [{"name": a.name, "verdict": a.verdict, "detail": a.detail} for a in outcome.attacks],
        "counts": outcome.counts,
        "runner": runner,
        "finished_at": now_iso(),
    }


def changes_view(changes: Changes) -> dict:
    return {
        "files": [
            {"path": f.path, "status": f.status, "additions": f.additions, "deletions": f.deletions}
            for f in changes.files
        ],
        "diff": changes.diff,
        "truncated": changes.truncated,
    }


def check_view(check: TaskCheck) -> dict:
    return {"id": check.id, "category": check.category, "ok": not check.errors, "errors": check.errors}
