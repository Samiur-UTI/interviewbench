"""Damaged input gives a clear error naming the file, never a traceback, and never takes down the rest."""

import json
import re
import shutil
from pathlib import Path

import pytest
from typer.testing import CliRunner

from interviewbench import judge, rounds
from interviewbench.cli import app
from interviewbench.judge import JudgeError
from interviewbench.tasks import REPORT, TaskError, load_all, load_task

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
    ({"level": None}, "level None"),
    ({"id": ["root-cause"]}, "criterion id ['root-cause'], which isn't a string"),
    ({"id": {"x": 1}}, "which isn't a string"),
])
def test_a_malformed_judge_answer_is_a_judge_error(task, bad, message):
    with pytest.raises(JudgeError, match=re.escape(message)):
        judge._normalize(judge_answer(task, **bad))
    with pytest.raises(JudgeError, match="no 'criteria' list"):
        judge._normalize([judge_answer(task)])
    assert judge._normalize(judge_answer(task, level="2"))["criteria"][0]["level"] == 2  # still lenient there
    loose = judge._normalize({**judge_answer(task), "missed_edge_cases": 3, "issues": "none"})
    assert loose["missed_edge_cases"] == [] and loose["issues"] == []


def test_a_malformed_pasted_reply_keeps_the_hidden_test_scores(task, tmp_path, solution_dir, runner):
    workspace = shutil.copytree(solution_dir, tmp_path / "ws")
    reply = "```json\n" + json.dumps(judge_answer(task, level=[2])) + "\n```"
    outcome = rounds.grade_round(task, workspace, runner, judge="reply", reply=reply)
    assert "isn't a whole number" in outcome.judge_error
    assert "45.0/45" in (workspace / REPORT).read_text(encoding="utf-8")


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
