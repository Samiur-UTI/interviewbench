"""`ib break`: attack tests refereed by the reference solution."""

import json
import shutil

import pytest
from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench import breaker, rounds
from interviewbench import workspace as ws
from interviewbench.breaker import BAD_TEST, REAL_BREAK, SURVIVED, run_break
from interviewbench.cli import app
from interviewbench.grader import build_reference
from interviewbench.runner import RunnerError
from interviewbench.tasks import ATTACK_PROMPT, MARKER

cli = CliRunner()

ATTACK = """\
from ratelimiter import FakeClock, RateLimiter, TokenBucket


def test_burst_after_idle_is_capped():
    clock = FakeClock()
    bucket = TokenBucket(capacity=3, refill_rate=1, clock=clock)
    clock.advance(10_000)
    assert sum(bucket.allow() for _ in range(10)) == 3


def test_retry_after_is_zero_for_a_full_bucket():
    assert RateLimiter(5, 1, FakeClock()).retry_after("k") == 0.0


def test_a_wrong_reading_of_the_brief():
    bucket = TokenBucket(capacity=3, refill_rate=1, clock=FakeClock())
    assert sum(bucket.allow() for _ in range(10)) == 4
"""


@pytest.fixture
def stage1_done(tmp_path, task, runner):
    """A candidate who fixed stage 1 and is now on stage 2 (no retry_after yet)."""
    dest = build_reference(task, tmp_path / "ws", runner, upto=1)
    (dest / MARKER).write_text(json.dumps({"task": "rate-limiter", "started_at": "2026-01-01T00:00:00+00:00", "stage": 2}))
    return dest


@pytest.fixture
def attack(tmp_path):
    path = tmp_path / "attack_test.py"
    path.write_text(ATTACK, encoding="utf-8")
    return path


def test_only_tests_the_reference_passes_count(task, stage1_done, attack, runner):
    verdicts = {a.name: a.verdict for a in run_break(task, stage1_done, attack, runner)}
    assert verdicts == {
        "test_burst_after_idle_is_capped": SURVIVED,
        "test_retry_after_is_zero_for_a_full_bucket": REAL_BREAK,
        "test_a_wrong_reading_of_the_brief": BAD_TEST,
    }


def test_break_command_summary_and_workspace_untouched(stage1_done, attack):
    result = cli.invoke(app, ["break", str(attack), "--dir", str(stage1_done), "--runner", RUNNER_KIND])
    assert result.exit_code == 0, result.output
    assert "1 real break(s), 1 survived, 1 bad test(s) ignored" in " ".join(result.output.split())
    assert not (stage1_done / "tests" / attack.name).exists()


def test_break_command_prints_brackets_in_attack_tests_as_text(tmp_path, stage1_done):
    path = tmp_path / "attack_test.py"
    path.write_text(
        "import pytest\nfrom ratelimiter import FakeClock, TokenBucket\n\n\n"
        "@pytest.mark.parametrize('capacity', [3], ids=['cheap-plan'])\n"
        "def test_cap(capacity):\n"
        "    assert TokenBucket(capacity=capacity, refill_rate=1, clock=FakeClock()).allow()\n\n\n"
        "def test_route():\n    assert '[/api]' == 'x'\n",
        encoding="utf-8",
    )
    result = cli.invoke(
        app, ["break", str(path), "--dir", str(stage1_done), "--runner", RUNNER_KIND], env={"COLUMNS": "200"}
    )
    assert result.exit_code == 0, result.output
    assert "test_cap[cheap-plan]" in result.output and "[/api]" in result.output


def test_break_prompt_shows_revealed_stages_and_code_but_no_hidden_tests(stage1_done):
    result = cli.invoke(app, ["break", "--prompt", "--dir", str(stage1_done)])
    assert result.exit_code == 0, result.output
    text = (stage1_done / ATTACK_PROMPT).read_text(encoding="utf-8")
    assert "## Stage 2/3" in text and "## Stage 3/3" not in text
    assert '<file path="ratelimiter/bucket.py">' in text and "`tests/<file name>`" in text
    assert "test_burst_after_idle_is_capped_at_capacity" not in text  # hidden stage 1 test
    assert "_EPSILON" not in text  # the reference solution's code


def test_a_file_without_tests_is_reported(tmp_path, stage1_done):
    empty = tmp_path / "nothing_test.py"
    empty.write_text("VALUE = 1\n", encoding="utf-8")
    result = cli.invoke(app, ["break", str(empty), "--dir", str(stage1_done), "--runner", RUNNER_KIND])
    assert result.exit_code == 1 and "No attack tests ran" in " ".join(result.output.split())


# Stage 2 makes a cost above capacity raise ValueError; until then it is just refused.
COST_ATTACK = """\
import pytest
from ratelimiter import FakeClock, RateLimiter


def test_a_cost_above_capacity_is_refused():
    assert RateLimiter(5, 1, FakeClock()).allow("k", cost=10) is False


def test_a_cost_above_capacity_raises():
    with pytest.raises(ValueError):
        RateLimiter(5, 1, FakeClock()).allow("k", cost=10)
"""


def test_the_reference_solves_only_the_revealed_stages(tmp_path, task, runner, monkeypatch):
    built = []

    def recording(task, dest, runner, upto=None):
        built.append(upto)
        return build_reference(task, dest, runner, upto=upto)

    monkeypatch.setattr(breaker, "build_reference", recording)
    dest = rounds.start_round(task, tmp_path / "ws", git=False, open_editor=False).path
    attack = tmp_path / "attack_test.py"
    attack.write_text(COST_ATTACK, encoding="utf-8")

    result = cli.invoke(app, ["break", str(attack), "--dir", str(dest), "--runner", RUNNER_KIND])
    assert result.exit_code == 0, result.output
    assert built == [1] and "0 real break(s), 1 survived, 1 bad test(s)" in " ".join(result.output.split())
    verdicts = {a.name: a.verdict for a in rounds.break_round(task, dest, attack, runner).attacks}
    assert verdicts == {"test_a_cost_above_capacity_is_refused": SURVIVED, "test_a_cost_above_capacity_raises": BAD_TEST}

    rounds.next_stage(task, dest, ws.read_marker(dest))
    outcome = rounds.break_content(task, dest, "test_attack.py", COST_ATTACK, runner)  # the GUI's path
    assert built == [1, 1, 2]
    verdicts = {a.name: a.verdict for a in outcome.attacks}
    assert verdicts == {"test_a_cost_above_capacity_is_refused": BAD_TEST, "test_a_cost_above_capacity_raises": REAL_BREAK}


def test_a_hand_back_is_refereed_by_the_full_reference(tmp_path, task, runner, monkeypatch):
    built = []
    monkeypatch.setattr(breaker, "build_reference", lambda task, dest, runner, upto=None: built.append(upto) or dest)
    monkeypatch.setattr(breaker, "_cases", lambda *args: {})  # runs nothing, so no attack tests ran
    attack = tmp_path / "attack_test.py"
    attack.write_text(COST_ATTACK, encoding="utf-8")
    handback = shutil.copytree(task.starter_dir, tmp_path / "handback")  # no round marker
    with pytest.raises(RunnerError, match="No attack tests ran"):
        rounds.break_round(task, handback, attack, runner)
    assert built == [None]


@pytest.mark.parametrize("inside", ["my_attack_test.py", "tests/my_attack_test.py"])
def test_an_attack_file_inside_the_workspace_is_refused(stage1_done, monkeypatch, inside):
    """The candidate's run would collect the copy too, and the duplicate module would fail that run."""
    copy = stage1_done / inside
    copy.write_text(ATTACK, encoding="utf-8")
    monkeypatch.setattr(breaker, "build_reference", lambda *args, **kwargs: pytest.fail("ran before the check"))
    result = cli.invoke(app, ["break", str(copy), "--dir", str(stage1_done), "--runner", RUNNER_KIND])
    text = " ".join(result.output.split())
    assert result.exit_code == 1 and "is inside the workspace" in text and "../my_attack_test.py" in text


def test_a_test_that_did_not_run_on_your_code_is_not_a_break(tmp_path, task, runner, monkeypatch):
    runs = iter([{}, {"m::test_ran": None, "m::test_lost": None}, {"m::test_ran": None}])  # baseline, reference, yours
    monkeypatch.setattr(breaker, "build_reference", lambda task, dest, runner, upto=None: dest)
    monkeypatch.setattr(breaker, "_cases", lambda *args: next(runs))
    attack = tmp_path / "attack_test.py"
    attack.write_text(ATTACK, encoding="utf-8")
    outcome = rounds.break_round(task, task.starter_dir, attack, runner)
    assert {a.name: a.verdict for a in outcome.attacks} == {"test_ran": SURVIVED, "test_lost": BAD_TEST}
    assert outcome.counts == {"real_break": 0, "survived": 1, "bad_test": 1}
    assert "did not run on your code" in outcome.attacks[1].detail
