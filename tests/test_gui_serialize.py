"""The GUI's spoiler rules and its results file."""

import pytest

from interviewbench import grader
from interviewbench.grader import StageResult, score
from interviewbench.ui import serialize
from interviewbench.ui.serialize import grade_record, grade_view, prior_result, task_view


@pytest.fixture
def stored(task, tmp_path):
    stages = [
        StageResult(1, 1, 2, [grader.TestFailure("test_stage_one", "assert 1 == 2")]),
        StageResult(2, 0, 2, [grader.TestFailure("test_hidden_two", "retry_after is wrong"), grader.TestFailure("t", "x")]),
        StageResult(3, 0, 0, error="Traceback: tests/test_secret_stage_three.py exploded"),
    ]
    return grade_record(
        score(task, stages, "local"), fingerprint="abc", judge_error=None, time_used=3, report_path=tmp_path / "r.md",
    )


def stages_of(view):
    return {s["stage"]: s for s in view["stages"]}


def test_a_revealed_stage_shows_everything(task, stored):
    first = stages_of(grade_view(stored, task, 1, False))[1]
    assert first["title"] == task.stages[0].title and first["revealed"] is True
    assert first["failures"] == [{"name": "test_stage_one", "message": "assert 1 == 2"}]
    assert first["withheld_failures"] == 0


def test_an_unrevealed_stage_keeps_only_its_counts(task, stored):
    second = stages_of(grade_view(stored, task, 1, False))[2]
    assert second == {
        "stage": 2, "title": None, "revealed": False, "passed": 0, "total": 2,
        "failures": [], "withheld_failures": 2, "error": None,
    }


def test_an_unrevealed_stages_error_doesnt_quote_test_output(task, stored):
    view = grade_view(stored, task, 1, False)
    third = stages_of(view)[3]
    assert third["error"] and third["withheld_failures"] == 0
    text = str(view)
    assert "test_secret_stage_three" not in text and "test_hidden_two" not in text


def test_auto_criteria_dont_describe_unrevealed_stages(task, stored):
    view = grade_view(stored, task, 1, False)
    by_id = {c["id"]: c for c in view["criteria"]}
    assert "bursts" in by_id["stage1-bug-fixed"]["description"]
    assert by_id["stage2-feature"]["description"] == "Hidden tests for stage 2."
    assert by_id["stage3-scales"]["evidence"] == serialize._WITHHELD_ERROR
    assert by_id["stage2-feature"]["evidence"] == "0/2 hidden tests passed"
    assert by_id["root-cause"]["score"] is None


def test_revealing_a_stage_brings_its_details_back(task, stored):
    view = grade_view(stored, task, 3, False)
    assert stages_of(view)[2]["failures"][0]["name"] == "test_hidden_two"
    assert "test_secret_stage_three" in stages_of(view)[3]["error"]
    assert "retry_after" in {c["id"]: c for c in view["criteria"]}["stage2-feature"]["description"]


def test_the_view_hides_the_fingerprint_and_leaves_the_record_alone(task, stored):
    assert "fingerprint" not in grade_view(stored, task, 1, True)
    assert grade_view(stored, task, 1, True)["judge_prepared"] is True
    assert stored["fingerprint"] == "abc" and stored["stages"][1]["failures"]


def test_a_task_view_only_describes_revealed_stages(task):
    rubric = {c["id"]: c["description"] for c in task_view(task)["rubric"]}
    assert rubric["stage1-bug-fixed"] == "Hidden tests for stage 1."
    rubric = {c["id"]: c["description"] for c in task_view(task, 2)["rubric"]}
    assert "bursts" in rubric["stage1-bug-fixed"] and "retry_after" in rubric["stage2-feature"]
    assert rubric["stage3-scales"] == "Hidden tests for stage 3."


def test_prior_result_is_only_for_the_same_code_and_runner(task, stored):
    prior = prior_result(stored, task, "abc", "local")
    assert prior.points == pytest.approx(7.5) and prior.stages[1].failures[0].name == "test_hidden_two"
    assert prior_result(stored, task, "other", "local") is None
    assert prior_result(stored, task, "abc", "docker") is None
    assert prior_result(None, task, "abc", "local") is None
    assert prior_result({"fingerprint": "abc", "runner": "local"}, task, "abc", "local") is None


def test_state_round_trips_and_tolerates_damage(tmp_path):
    assert serialize.read_state(tmp_path) == {}
    serialize.write_state(tmp_path, {"test": {"passed": 1}})
    assert serialize.read_state(tmp_path) == {"test": {"passed": 1}}
    (tmp_path / "ib-ui.json").write_text("[1]", encoding="utf-8")
    assert serialize.read_state(tmp_path) == {}
