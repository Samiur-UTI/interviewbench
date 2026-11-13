"""Damaged input gives a clear error naming the file, never a traceback, and never takes down the rest."""

import json
import re
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench import __version__, grader, judge, rounds, tasks
from interviewbench import cli as cli_module
from interviewbench import workspace as ws
from interviewbench.cli import app
from interviewbench.judge import JudgeError
from interviewbench.tasks import MARKER, REPORT, TaskError, load_all, load_task

REPO = Path(__file__).resolve().parents[1]
cli = CliRunner()


def flat(output):
    return " ".join(output.split())


@pytest.fixture
def bench(tmp_path, monkeypatch):
    """IB_ROOT with the rubrics and two copies of rate-limiter: `rate-limiter` and `spare`."""
    shutil.copytree(REPO / "rubrics", tmp_path / "rubrics")
    tasks = tmp_path / "tasks" / "backend"
    for name in ("rate-limiter", "spare"):
        shutil.copytree(REPO / "tasks" / "backend" / "rate-limiter", tasks / name)
    toml = tasks / "spare" / "task.toml"
    toml.write_text(toml.read_text(encoding="utf-8").replace("/rate-limiter", "/spare"), encoding="utf-8", newline="\n")
    monkeypatch.setenv("IB_ROOT", str(tmp_path))
    return tmp_path


def spare(bench):
    return bench / "tasks" / "backend" / "spare"


def append(path, text):
    path.write_text(path.read_text(encoding="utf-8") + text, encoding="utf-8", newline="\n")


# --- A broken task file ----------------------------------------------------------------------


def break_rubric(bench):
    append(spare(bench) / "rubric.yaml", "criteria: [\n  - oops\n")
    return spare(bench) / "rubric.yaml"


def break_instruction(bench):
    path = spare(bench) / "steps" / "stage-2" / "instruction.md"
    path.write_bytes(b"# Title\n\nCaf\xe9 latin-1\n")
    return path


def break_metadata(bench):
    path = spare(bench) / "task.toml"
    text = path.read_text(encoding="utf-8")
    text = text.replace("[metadata]", "[old-metadata]").replace("[metadata.interviewbench]", "[old-ib]")
    path.write_text('metadata = "backend"\n' + text, encoding="utf-8", newline="\n")
    return path


@pytest.mark.parametrize("damage, message", [
    (break_rubric, "is not valid YAML"),
    (break_instruction, "is not UTF-8 text"),
    (break_metadata, "[metadata] must be a table"),
])
def test_a_broken_task_file_is_a_task_error_naming_the_file(bench, damage, message):
    path = damage(bench)
    with pytest.raises(TaskError) as exc:
        load_task(spare(bench))
    assert message in str(exc.value) and str(path) in str(exc.value)
    with pytest.raises(TaskError, match="not valid YAML|not UTF-8|must be a table"):
        load_all()


@pytest.mark.parametrize("damage", [break_rubric, break_instruction, break_metadata])
def test_one_broken_task_leaves_the_others_usable(bench, damage):
    damage(bench)
    listed = cli.invoke(app, ["list"])
    assert listed.exit_code == 0, listed.output
    assert "rate-limiter" in listed.output and "Skipped backend/spare" in flat(listed.output)
    assert "ib validate spare" in flat(listed.output)

    checked = cli.invoke(app, ["validate"])
    assert checked.exit_code == 1 and not isinstance(checked.exception, Exception)
    assert "ok backend/rate-limiter" in checked.output and "FAIL backend/spare" in checked.output
    one = cli.invoke(app, ["validate", "spare"])
    assert one.exit_code == 1 and "FAIL backend/spare" in one.output and "rate-limiter" not in one.output
    assert cli.invoke(app, ["validate", "rate-limiter"]).exit_code == 0

    assert [t.id for t in rounds.available_tasks()] == ["rate-limiter"]
    checks = {c.id: c.errors for c in rounds.validate_tasks(None, None)}
    assert checks["rate-limiter"] == [] and checks["spare"]


@pytest.mark.parametrize("weight", [".nan", ".inf", "-5", "0"])
def test_a_weight_must_be_a_positive_number(bench, weight):
    rubric = spare(bench) / "rubric.yaml"
    old = "  - id: communication\n    weight: 5\n"
    assert old in rubric.read_text(encoding="utf-8")
    rubric.write_text(rubric.read_text(encoding="utf-8").replace(old, f"  - id: communication\n    weight: {weight}\n"),
                      encoding="utf-8", newline="\n")
    with pytest.raises(TaskError, match="'communication' must have a positive weight"):
        load_task(spare(bench))


def judge_answer(task, **first):
    criteria = [{"id": c.id, "rationale": "r", "evidence": [], "level": 1} for c in task.criteria if c.type == "judge"]
    criteria[0].update(first)
    return {"criteria": criteria, "missed_edge_cases": [], "issues": [], "summary": "s"}


@pytest.mark.parametrize("bad, message", [
    ({"level": [2]}, "level [2], which isn't a whole number"),
    ({"level": {"n": 2}}, "which isn't a whole number"),
    ({"level": 1.5}, "level 1.5, which isn't a whole number"),
    ({"level": True}, "level True"),
    ({"id": ["root-cause"]}, "criterion id ['root-cause'], which isn't a string"),
    ({"id": {"x": 1}}, "which isn't a string"),
])
def test_a_malformed_judge_answer_is_a_judge_error(task, bad, message):
    with pytest.raises(JudgeError, match=re.escape(message)):
        judge._normalize(judge_answer(task, **bad))
    with pytest.raises(JudgeError, match="no 'criteria' list"):
        judge._normalize([judge_answer(task)])
    assert judge._normalize(judge_answer(task, level="2"))["criteria"][0]["level"] == 2  # still lenient there
    assert judge._normalize(judge_answer(task, level=None))["criteria"][0]["level"] is None  # that one stays ungraded
    loose = judge._normalize({**judge_answer(task), "missed_edge_cases": 3, "issues": "none"})
    assert loose["missed_edge_cases"] == [] and loose["issues"] == []


def test_a_malformed_pasted_reply_keeps_the_hidden_test_scores(task, tmp_path, solution_dir, runner):
    workspace = shutil.copytree(solution_dir, tmp_path / "ws")
    reply = "```json\n" + json.dumps(judge_answer(task, level=[2])) + "\n```"
    outcome = rounds.grade_round(task, workspace, runner, judge="reply", reply=reply)
    assert "isn't a whole number" in outcome.judge_error
    assert "45.0/45" in (workspace / REPORT).read_text(encoding="utf-8")


class FakeStream:
    def __init__(self, text):
        self.text = text

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=self.text)])


def claude_failing(monkeypatch, *, on_build=None, on_stream=None, text="{}"):
    anthropic = pytest.importorskip("anthropic")

    def stream(**kwargs):
        if on_stream:
            raise on_stream
        return FakeStream(text)

    def build(**kwargs):
        if on_build:
            raise on_build
        return SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(stream=stream)))

    monkeypatch.setattr(anthropic, "Anthropic", build)


@pytest.mark.parametrize("failure, message", [
    ({"on_stream": TypeError("Could not resolve authentication method. Expected one of api_key, auth_token, "
                             "or credentials to be set.")}, "No credentials for the Claude API: set ANTHROPIC_API_KEY"),
    ({"on_stream": TypeError("Messages.stream() got an unexpected keyword argument 'fallbacks'")},
     "The installed Anthropic SDK can't make this request"),
    ({"on_stream": ValueError("unknown beta")}, "can't make this request (unknown beta)"),
    ({"on_build": "AnthropicError"}, "Claude API error: no profile"),
    ({"on_stream": "AnthropicError"}, "Claude API error: no profile"),
    ({"text": "{not json"}, "The judge's answer isn't valid JSON"),
])
def test_claude_backend_failures_are_judge_errors(monkeypatch, failure, message):
    anthropic = pytest.importorskip("anthropic")
    failure = {k: anthropic.AnthropicError("no profile") if v == "AnthropicError" else v for k, v in failure.items()}
    claude_failing(monkeypatch, **failure)
    with pytest.raises(JudgeError, match=re.escape(message)):
        judge._call_claude("m", system="s", user="u", schema={})


DAMAGED_MARKERS = {
    "not-json": ("{bad", "isn't readable JSON"),
    "a-list": ("[1]", "doesn't say which task"),
    "no-task": ('{"stage": 1}', "doesn't say which task"),
    "bad-stage": ('{"task": "rate-limiter", "stage": "x"}', 'its stage, "x", isn\'t a whole number'),
}


@pytest.mark.parametrize("command", [["test"], ["next"], ["grade"], ["break", "attack.py"], ["break", "--prompt"]])
@pytest.mark.parametrize("name", DAMAGED_MARKERS)
def test_a_damaged_marker_is_one_clear_error(tmp_path, command, name):
    text, detail = DAMAGED_MARKERS[name]
    (tmp_path / MARKER).write_text(text, encoding="utf-8")
    result = cli.invoke(app, [*command, "--dir", str(tmp_path)])
    assert result.exit_code == 1 and not isinstance(result.exception, Exception), result.output
    out = flat(result.output)
    assert f"{tmp_path / MARKER}isdamaged".replace(" ", "") in out.replace(" ", "")  # Rich may wrap the path
    assert detail in out
    assert ("--task" in out) == (command == ["grade"]) and "ib start" in out


def test_a_damaged_marker_can_still_be_graded_with_task(tmp_path, solution_dir):
    workspace = shutil.copytree(solution_dir, tmp_path / "ws")
    (workspace / MARKER).write_text("{bad", encoding="utf-8")
    result = cli.invoke(app, ["grade", "--dir", str(workspace), "--task", "rate-limiter", "--runner", RUNNER_KIND])
    assert result.exit_code == 0, result.output
    assert "45.0/45" in (workspace / REPORT).read_text(encoding="utf-8")


@pytest.mark.parametrize("name", DAMAGED_MARKERS)
def test_the_gui_skips_a_damaged_round(tmp_path, monkeypatch, name):
    monkeypatch.setenv("IB_WORKSPACES", str(tmp_path))
    (tmp_path / name).mkdir()
    (tmp_path / name / MARKER).write_text(DAMAGED_MARKERS[name][0], encoding="utf-8")
    with pytest.raises(rounds.UnknownRound):
        rounds.load_round(name)
    assert rounds.list_rounds() == []
    assert ws.read_marker(tmp_path / name) == {}  # what grading reads: no task, so the first stage revealed


def test_new_refuses_to_write_into_an_installed_package(tmp_path, monkeypatch):
    package = tmp_path / "site-packages" / "interviewbench"
    for folder in ("rubrics", "templates"):
        shutil.copytree(REPO / folder, package / "_bench" / folder)
    (package / "_bench" / "tasks").mkdir()
    monkeypatch.delenv("IB_ROOT", raising=False)
    monkeypatch.setattr(tasks, "__file__", str(package / "tasks.py"))
    assert tasks.bench_root() == package / "_bench"
    result = cli.invoke(app, ["new", "my-task", "--category", "backend"])
    assert result.exit_code == 1 and not isinstance(result.exception, Exception), result.output
    out = flat(result.output)
    assert "ib new needs a clone of the interviewbench repo" in out and "pip install -e ." in out and "IB_ROOT" in out
    assert not any((package / "_bench" / "tasks").iterdir())

    monkeypatch.setenv("IB_ROOT", str(package / "_bench"))  # an explicit bench folder is the author's choice
    assert cli.invoke(app, ["new", "my-task", "--category", "backend"]).exit_code == 0


@pytest.mark.parametrize("width", [110, 60])
def test_list_never_cuts_off_a_task_id(monkeypatch, width):
    monkeypatch.setattr(cli_module.console, "width", width)
    result = cli.invoke(app, ["list"])
    assert result.exit_code == 0 and "flight-search-aggregator" in result.output, result.output


def test_list_rejects_an_unknown_category_and_says_when_one_is_empty():
    result = cli.invoke(app, ["list", "-c", "nope"])
    assert result.exit_code == 1 and "Unknown category 'nope'. Categories: backend, devops, frontend." in flat(result.output)
    result = cli.invoke(app, ["list", "-c", "devops"])
    assert result.exit_code == 0 and "There are no tasks in the devops category yet." in flat(result.output)
    assert "ID" not in result.output  # no empty table
    result = cli.invoke(app, ["list", "--tag", "cobol"])
    assert result.exit_code == 0 and "There are no tasks tagged 'cobol' yet." in flat(result.output)


@pytest.mark.parametrize("args", [["--version"], ["version"]])
def test_version(args, monkeypatch):
    monkeypatch.setattr(cli_module, "ui", lambda **kwargs: pytest.fail("--version must not open the GUI"))
    result = cli.invoke(app, args)
    assert result.exit_code == 0 and result.output.strip() == __version__, result.output


def test_check_task_runs_only_the_stage_each_check_needs(task, runner, monkeypatch):
    ran, real = [], grader.run_stage_tests

    def counting(task, workspace, stage, runner, timeout=None):
        ran.append(stage)
        return real(task, workspace, stage, runner, timeout)

    monkeypatch.setattr(grader, "run_stage_tests", counting)
    monkeypatch.setattr(rounds, "run_stage_tests", counting, raising=False)
    assert rounds.check_task(task, runner) == []
    assert ran == [1, 1, 2, 3]  # the starter on stage 1, then stage N after solutions 1..N


def test_validate_still_reports_unknown_and_duplicate_ids(bench):
    result = cli.invoke(app, ["validate", "nope"])
    assert result.exit_code == 1 and "Unknown task 'nope'" in result.output
    shutil.copytree(spare(bench), bench / "tasks" / "frontend" / "spare")
    toml = bench / "tasks" / "frontend" / "spare" / "task.toml"
    toml.write_text(toml.read_text(encoding="utf-8").replace('"backend"', '"frontend"'), encoding="utf-8", newline="\n")
    assert load_task(toml.parent).category == "frontend"  # each copy is fine on its own
    result = cli.invoke(app, ["validate"])
    assert result.exit_code == 1 and "ok backend/rate-limiter" in result.output
    assert flat(result.output).count("is used twice") == 2
