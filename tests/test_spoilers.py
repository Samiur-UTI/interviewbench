"""Nothing reveals a stage the round hasn't reached: the AI judge waits for the last stage."""

import shutil

import pytest
from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench import judge, rounds
from interviewbench import workspace as ws
from interviewbench.cli import app
from interviewbench.grader import StageResult, score
from interviewbench.judge import JudgeRequest
from interviewbench.tasks import REPORT

cli = CliRunner()
MODES = ["api", "prepare", "reply"]
NOT_YET = "runs once every stage is revealed"


def forbid(monkeypatch, *names):
    def boom(*args, **kwargs):
        raise AssertionError("ran before the judge check")

    for module, name in names:
        monkeypatch.setattr(module, name, boom)


@pytest.fixture
def no_work(monkeypatch):
    """Neither the hidden tests nor any judge step nor any provider may run."""
    forbid(
        monkeypatch, (rounds, "grade"), (rounds, "run_judge"), (rounds, "prepare_judge"), (rounds, "apply_judgment"),
        (judge, "_call_claude"), (judge, "_call_openai_compatible"),
    )


@pytest.fixture
def judged(monkeypatch, task):
    """Fast stand-ins that record which judge steps ran."""
    calls = []
    result = score(task, [StageResult(s.number, 1, 1) for s in task.stages], "local")
    monkeypatch.setattr(rounds, "grade", lambda *args, **kwargs: result)
    monkeypatch.setattr(rounds, "run_judge", lambda *args, **kwargs: calls.append("api"))

    def prepare(*args, **kwargs):
        calls.append("prepare")
        return JudgeRequest(system="s", user="u", schema={}, criteria=[], candidate_tests=StageResult(0, 1, 1))

    monkeypatch.setattr(rounds, "prepare_judge", prepare)
    monkeypatch.setattr(rounds, "apply_judgment", lambda *args, **kwargs: calls.append("reply"))
    return calls


def started(tmp_path, task):
    return rounds.start_round(task, tmp_path / "ws", open_editor=False).path


@pytest.mark.parametrize("mode", MODES)
def test_the_judge_is_refused_mid_round_before_anything_runs(tmp_path, task, runner, no_work, mode):
    dest = started(tmp_path, task)
    rounds.next_stage(task, dest, ws.read_marker(dest))
    with pytest.raises(rounds.RoundError, match=NOT_YET) as caught:
        rounds.grade_round(task, dest, runner, judge=mode, reply="{}")
    assert "you are on stage 2 of 3" in str(caught.value) and "`ib next`" in str(caught.value)
    assert not (dest / REPORT).exists()


def test_grading_without_the_judge_is_unchanged_mid_round(tmp_path, task, runner, judged):
    outcome = rounds.grade_round(task, started(tmp_path, task), runner)
    assert outcome.revealed == 1 and judged == []


@pytest.mark.parametrize("mode", MODES)
def test_the_judge_runs_once_every_stage_is_revealed(tmp_path, task, runner, judged, mode):
    dest = started(tmp_path, task)
    for _ in task.stages[1:]:
        rounds.next_stage(task, dest, ws.read_marker(dest))
    rounds.grade_round(task, dest, runner, judge=mode, reply='{"criteria": []}')
    assert judged[-1] == mode


@pytest.mark.parametrize("mode", MODES)
def test_the_judge_runs_for_an_interviewer_or_a_hand_back(tmp_path, task, runner, judged, mode):
    dest = started(tmp_path, task)
    rounds.grade_round(task, dest, runner, judge=mode, reply='{"criteria": []}', all_stages=True,
                       report_path=tmp_path / "review.md")
    assert judged[-1] == mode
    handback = shutil.copytree(task.starter_dir, tmp_path / "handback")  # no marker: not a round
    rounds.grade_round(task, handback, runner, judge=mode, reply='{"criteria": []}')
    assert judged.count(mode) == 2


@pytest.mark.parametrize("option", ["--judge", "--judge-export", "--judge-reply"])
def test_ib_grade_refuses_the_judge_mid_round(tmp_path, task, no_work, option):
    dest = started(tmp_path, task)
    reply = tmp_path / "reply.txt"
    reply.write_text("{}", encoding="utf-8")
    args = ["grade", "--dir", str(dest), "--runner", RUNNER_KIND, option] + ([str(reply)] if option == "--judge-reply" else [])
    result = cli.invoke(app, args)
    assert result.exit_code == 1 and NOT_YET in " ".join(result.output.split())
    assert "you are on stage 1 of 3" in " ".join(result.output.split())
