import shutil

import pytest
from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench import judge
from interviewbench.cli import app
from interviewbench.grader import grade, run_candidate_tests
from interviewbench.judge import JudgeError, run_judge
from interviewbench.tasks import get_task

TASK = get_task("rate-limiter")
JUDGE_IDS = [c.id for c in TASK.criteria if c.type == "judge"]


def fake_output(levels):
    return {
        "criteria": [
            {"id": cid, "rationale": f"why {cid}", "evidence": ["bucket.py:29"], "level": level}
            for cid, level in levels.items()
        ],
        "missed_edge_cases": ["retry_after with cost == capacity"],
        "issues": [
            {"severity": "low", "category": "code-quality", "location": "limiter.py", "description": "nit"},
            {"severity": "high", "category": "integrity", "location": "tests/", "description": "edited a test"},
        ],
        "summary": "Solid work.",
    }


@pytest.fixture
def captured(monkeypatch):
    calls = {}

    def fake_call(model, *, system, user, schema):
        calls.update(model=model, system=system, user=user, schema=schema)
        return calls["output"]

    monkeypatch.setattr(judge, "_call_claude", fake_call)
    return calls


def test_judge_scores_criteria_and_attaches_review(captured, runner, solution_dir):
    max_levels = {c.id: max(c.levels) for c in TASK.criteria if c.type == "judge"}
    captured["output"] = fake_output(max_levels | {"communication": 1})
    result = grade(TASK, solution_dir, runner)
    run_judge(result, solution_dir, runner=runner, model="test-model")

    scores = {s.criterion.id: s.score for s in result.scores}
    assert scores["root-cause"] == 1.0
    assert scores["communication"] == pytest.approx(1 / 3)
    assert result.graded_weight == result.total_weight == 100
    assert [i.severity for i in result.review.issues] == ["high", "low"]
    assert result.review.candidate_tests.passed == result.review.candidate_tests.total > 0


def test_judge_prompt_has_task_context_and_candidate_diff(captured, runner, solution_dir):
    captured["output"] = fake_output({cid: 1 for cid in JUDGE_IDS})
    run_judge(grade(TASK, solution_dir, runner), solution_dir, runner=runner, model="test-model")

    system = captured["system"]
    assert "<hidden_tests>" in system and "class NeverEvictingLimiter" in system
    assert "+    def time_until(self, cost: float = 1) -> float:" in system
    assert "Backend review focus" in system and "eviction that changes observable results" in system
    assert "<business_context>" in system and "never exceeding a plan" in system
    assert "+        self._tokens = min(self.capacity" in captured["user"]
    assert "Hidden stage 3 tests: " in captured["user"]
    assert captured["schema"]["properties"]["criteria"]["items"]["properties"]["id"]["enum"] == JUDGE_IDS


def test_invalid_or_missing_levels_leave_criterion_ungraded(captured, runner):
    captured["output"] = fake_output({"root-cause": 7})
    result = grade(TASK, TASK.starter_dir, runner)
    run_judge(result, TASK.starter_dir, runner=runner, model="test-model")

    judged = {s.criterion.id: s for s in result.scores if s.criterion.type == "judge"}
    assert judged["root-cause"].score is None and "invalid level 7" in judged["root-cause"].evidence
    assert judged["verification"].score is None


def test_starter_diff_is_empty(captured, runner):
    captured["output"] = fake_output({})
    run_judge(grade(TASK, TASK.starter_dir, runner), TASK.starter_dir, runner=runner, model="test-model")
    assert "<diff>\n(no changes)\n</diff>" in captured["user"]


def test_candidate_tests_report_failures(tmp_path, runner):
    ws = tmp_path / "ws"
    shutil.copytree(TASK.starter_dir, ws)
    (ws / "tests" / "test_extra.py").write_text("def test_broken():\n    assert 1 == 2\n", encoding="utf-8")
    result = run_candidate_tests(TASK, ws, runner)
    assert result.total == result.passed + 1
    assert result.failures[0].name == "test_broken"


def test_cli_judge_failure_still_writes_report(tmp_path, monkeypatch, solution_dir):
    def boom(*args, **kwargs):
        raise JudgeError("no credentials")

    monkeypatch.setattr(judge, "_call_claude", boom)
    ws = tmp_path / "ws"
    shutil.copytree(solution_dir, ws)
    result = CliRunner().invoke(
        app, ["grade", "--dir", str(ws), "--task", "rate-limiter", "--judge", "--runner", RUNNER_KIND]
    )
    assert result.exit_code == 1
    assert "no credentials" in result.output
    assert "45.0/45" in (ws / "ib-report.md").read_text(encoding="utf-8")
