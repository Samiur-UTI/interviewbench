"""The workflows behind the CLI and the GUI, called directly."""

import json
import shutil

import pytest

from interviewbench import judge, rounds
from interviewbench import workspace as ws
from interviewbench.breaker import Attack
from interviewbench.judge import JudgeError
from interviewbench.tasks import ATTACK_PROMPT, BRIEF, JUDGE_PROMPT, REPORT


def test_start_round_reports_what_it_set_up(tmp_path, task):
    started = rounds.start_round(task, tmp_path / "ws", open_editor=False)
    assert started.path == tmp_path / "ws" and started.git is True and started.editor is None
    assert ws.read_marker(started.path)["stage"] == 1
    with pytest.raises(rounds.RoundError, match="already exists"):
        rounds.start_round(task, tmp_path / "ws", open_editor=False)


def test_next_stage_reports_the_tag_and_stops_at_the_last_stage(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", open_editor=False).path
    marker = ws.read_marker(dest)
    assert rounds.next_stage(task, dest, marker) == rounds.RevealedStage(2, "stage-1")
    assert rounds.next_stage(task, dest, marker) == rounds.RevealedStage(3, "stage-2")
    assert "## Stage 3/3" in (dest / BRIEF).read_text(encoding="utf-8")
    with pytest.raises(rounds.AllRevealed, match="already revealed"):
        rounds.next_stage(task, dest, marker)


def test_next_stage_without_git_tags_nothing(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", git=False, open_editor=False).path
    assert rounds.next_stage(task, dest, ws.read_marker(dest)).tagged is None


def judge_answer(task):
    return {
        "criteria": [
            {"id": c.id, "rationale": "why", "evidence": ["a.py:1"], "level": max(c.levels)}
            for c in task.criteria if c.type == "judge"
        ],
        "missed_edge_cases": [],
        "issues": [],
        "summary": "Solid.",
    }


def test_grade_round_writes_the_report(tmp_path, task, runner, solution_dir):
    dest = shutil.copytree(solution_dir, tmp_path / "ws")
    outcome = rounds.grade_round(task, dest, runner)
    assert outcome.request is None and outcome.judge_error is None
    assert outcome.result.points == 45
    assert "45.0/45" in (dest / REPORT).read_text(encoding="utf-8")


def test_grade_round_keeps_scores_when_the_judge_fails(tmp_path, task, runner, solution_dir, monkeypatch):
    def boom(*args, **kwargs):
        raise JudgeError("no credentials")

    monkeypatch.setattr(judge, "_call_claude", boom)
    dest = shutil.copytree(solution_dir, tmp_path / "ws")
    outcome = rounds.grade_round(task, dest, runner, judge="api")
    assert outcome.judge_error == "no credentials" and outcome.result.points == 45
    assert (dest / REPORT).is_file()


def test_grade_round_prepare_keeps_the_prompt_out_of_the_workspace(tmp_path, task, runner, solution_dir):
    dest = shutil.copytree(solution_dir, tmp_path / "ws")
    outcome = rounds.grade_round(task, dest, runner, judge="prepare")
    assert "<hidden_tests>" in outcome.request.as_paste()
    assert not (dest / JUDGE_PROMPT).exists()


def test_grade_round_scores_a_pasted_reply(tmp_path, task, runner, solution_dir):
    dest = shutil.copytree(solution_dir, tmp_path / "ws")
    reply = f"Here it is:\n```json\n{json.dumps(judge_answer(task))}\n```"
    outcome = rounds.grade_round(task, dest, runner, judge="reply", reply=reply)
    assert outcome.result.graded_weight == outcome.result.total_weight
    assert outcome.result.review.model == "pasted reply"
    bad = rounds.grade_round(task, dest, runner, judge="reply", reply="sorry, no")
    assert "no JSON object" in bad.judge_error


def test_grade_round_reports_each_phase(tmp_path, task, runner, solution_dir):
    dest = shutil.copytree(solution_dir, tmp_path / "ws")
    phases = []
    rounds.grade_round(task, dest, runner, judge="prepare", progress=phases.append)
    assert phases == [
        "Running hidden tests for stage 1 of 3",
        "Running hidden tests for stage 2 of 3",
        "Running hidden tests for stage 3 of 3",
        "Running your own tests",
        "Building the reference solution",
    ]


def test_break_round_reports_each_phase(tmp_path, task, runner, solution_dir):
    attack = tmp_path / "test_attack.py"
    attack.write_text("def test_nothing():\n    assert True\n", encoding="utf-8")
    phases = []
    outcome = rounds.break_round(task, solution_dir, attack, runner, progress=phases.append)
    assert outcome.counts["survived"] == 1
    assert phases[-1] == "Running the attack tests on your code" and len(phases) == 3


def test_break_outcome_counts_each_verdict():
    attacks = [Attack("a", "real break"), Attack("b", "survived"), Attack("c", "survived"), Attack("d", "bad test")]
    assert rounds.BreakOutcome(attacks).counts == {"real_break": 1, "survived": 2, "bad_test": 1}


def test_write_attack_prompt_stops_at_the_revealed_stage(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", open_editor=False).path
    path = rounds.write_attack_prompt(task, dest, ws.read_marker(dest))
    assert path == dest / ATTACK_PROMPT
    text = path.read_text(encoding="utf-8")
    assert "## Stage 1/3" in text and "## Stage 2/3" not in text


def test_new_task_rejects_what_it_cannot_create():
    with pytest.raises(rounds.RoundError, match="Unknown category"):
        rounds.new_task("x", "mobile")
    with pytest.raises(rounds.RoundError, match="already exists"):
        rounds.new_task("rate-limiter", "backend")
