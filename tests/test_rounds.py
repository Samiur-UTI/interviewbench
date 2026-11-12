"""The workflows behind the CLI and the GUI, called directly."""

import json
import shutil
from pathlib import Path

import pytest

from interviewbench import judge, rounds
from interviewbench import workspace as ws
from interviewbench.breaker import Attack
from interviewbench.grader import score
from interviewbench.judge import JudgeError
from interviewbench.tasks import (
    ATTACK_PROMPT, BRIEF, JUDGE_PROMPT, MARKER, REPORT, UI_STATE, WORKSPACE_FILES, get_task,
)


@pytest.fixture
def workspaces(tmp_path, monkeypatch):
    root = tmp_path / "rounds"
    monkeypatch.setenv("IB_WORKSPACES", str(root))
    return root


def test_start_round_reports_what_it_set_up(tmp_path, task):
    started = rounds.start_round(task, tmp_path / "ws", open_editor=False)
    assert started.path == tmp_path / "ws" and started.git is True and started.editor is None
    assert ws.read_marker(started.path)["stage"] == 1
    with pytest.raises(rounds.RoundError, match="already exists"):
        rounds.start_round(task, tmp_path / "ws", open_editor=False)


def test_force_never_deletes_a_folder_that_isnt_a_round(tmp_path, task):
    project = tmp_path / "my-project"
    (project / ".git").mkdir(parents=True)
    (project / "main.py").write_text("print('mine')\n", encoding="utf-8")
    for force in (False, True):
        with pytest.raises(rounds.RoundError, match="isn't an interviewbench workspace") as caught:
            rounds.start_round(task, project, force=force, open_editor=False)
        assert "Use --force" not in str(caught.value)
    assert (project / "main.py").read_text(encoding="utf-8") == "print('mine')\n"
    assert (project / ".git").is_dir() and not (project / MARKER).exists()


def test_force_replaces_an_earlier_round(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", open_editor=False).path
    (dest / "scratch.txt").write_text("old work", encoding="utf-8")
    with pytest.raises(rounds.RoundError, match="Use --force"):
        rounds.start_round(task, dest, open_editor=False)
    rounds.start_round(task, dest, force=True, open_editor=False)
    assert not (dest / "scratch.txt").exists() and ws.read_marker(dest)["stage"] == 1


@pytest.mark.parametrize("force", [False, True])
def test_an_empty_folder_takes_the_round(tmp_path, task, force):
    (tmp_path / "empty").mkdir()
    started = rounds.start_round(task, tmp_path / "empty", force=force, git=False, open_editor=False)
    assert (started.path / BRIEF).is_file() and ws.read_marker(started.path)["task"] == task.id


def test_a_folder_holding_interviewbench_is_refused(tmp_path, task, monkeypatch):
    outer = tmp_path / "code"
    bench = outer / "interviewbench"
    shutil.copytree(task.path.parents[2] / "rubrics", bench / "rubrics")
    (outer / MARKER).write_text('{"task": "rate-limiter"}', encoding="utf-8")  # even if it looks like a round
    monkeypatch.setenv("IB_ROOT", str(bench))
    with pytest.raises(rounds.RoundError, match="contains"):
        rounds.start_round(task, outer, force=True, open_editor=False)
    assert (bench / "rubrics" / "base.yaml").is_file()
    with pytest.raises(rounds.RoundError, match="hidden tests"):
        rounds.start_round(task, bench / "ws", open_editor=False)


def test_the_home_folder_and_files_are_refused(tmp_path, task, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    (home / MARKER).write_text('{"task": "rate-limiter"}', encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    with pytest.raises(rounds.RoundError, match="home folder"):
        rounds.start_round(task, home, force=True, open_editor=False)
    assert (home / MARKER).is_file()
    (tmp_path / "notes.txt").write_text("keep", encoding="utf-8")
    with pytest.raises(rounds.RoundError, match="isn't a plain folder"):
        rounds.start_round(task, tmp_path / "notes.txt", force=True, open_editor=False)
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "keep"


def test_export_judge_prompt_goes_outside_the_workspace(tmp_path, task, runner, solution_dir, monkeypatch):
    monkeypatch.setenv("IB_DATA_DIR", str(tmp_path / "data"))
    dest = shutil.copytree(solution_dir, tmp_path / "ws")
    (dest / JUDGE_PROMPT).write_text("stale", encoding="utf-8")
    outcome = rounds.grade_round(task, dest, runner, judge="prepare")
    exported = rounds.export_judge_prompt(dest, outcome.request)
    assert exported.path == ws.private_dir(dest) / JUDGE_PROMPT
    assert not exported.path.resolve().is_relative_to(dest.resolve())
    assert "<hidden_tests>" in exported.path.read_text(encoding="utf-8")
    assert exported.removed_stale and not (dest / JUDGE_PROMPT).exists()
    assert ws.private_dir(tmp_path / "other" / "ws") != ws.private_dir(dest)  # same name, other round
    monkeypatch.setenv("IB_DATA_DIR", str(dest / "data"))
    with pytest.raises(rounds.RoundError, match="inside the workspace"):
        rounds.export_judge_prompt(dest, outcome.request)


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


def test_starting_a_task_again_takes_the_next_free_folder(workspaces, task):
    names = [rounds.start_in_free_folder(task, git=False, open_editor=False).path.name for _ in range(3)]
    assert names == ["rate-limiter", "rate-limiter-2", "rate-limiter-3"]
    rounds.delete_round("rate-limiter-2")
    assert rounds.start_in_free_folder(task, git=False, open_editor=False).path.name == "rate-limiter-2"


def test_list_rounds_is_newest_first_and_skips_what_isnt_a_round(workspaces, task):
    first = rounds.start_in_free_folder(task, git=False, open_editor=False).path
    second = rounds.start_in_free_folder(task, git=False, open_editor=False).path
    marker = ws.read_marker(first)
    marker["started_at"] = "2020-01-01T00:00:00+00:00"
    ws.write_marker(first, marker)
    for name, text in (
        ("corrupt", "{not json"),
        ("a-list", "[1, 2]"),
        ("no-task", "{}"),
        ("gone", '{"task": "a-task-that-was-deleted"}'),
        ("bad-stage", '{"task": "rate-limiter", "stage": "two"}'),
        ("has space", '{"task": "rate-limiter"}'),
    ):
        (workspaces / name).mkdir()
        (workspaces / name / MARKER).write_text(text, encoding="utf-8")
    (workspaces / "plain-folder").mkdir()
    (workspaces / "a-file.txt").write_text("x", encoding="utf-8")
    assert [r.path.name for r in rounds.list_rounds()] == [second.name, first.name]
    assert rounds.list_rounds()[1].ends.isoformat() == "2020-01-01T01:00:00+00:00"


def test_list_rounds_with_no_workspaces_folder(workspaces):
    assert rounds.list_rounds() == []


def test_a_round_without_a_start_time_still_lists(workspaces):
    (workspaces / "old").mkdir(parents=True)
    (workspaces / "old" / MARKER).write_text('{"task": "rate-limiter", "stage": 99}', encoding="utf-8")
    only = rounds.list_rounds()[0]
    assert only.started is None and only.ends is None and only.stage == 3


@pytest.mark.parametrize("bad", ["..", ".", "a/b", "..\\x", "x\n", "", "a b", "../rounds"])
def test_round_ids_cant_leave_the_workspaces_folder(workspaces, bad):
    with pytest.raises(rounds.UnknownRound):
        rounds.round_path(bad)


def test_a_link_out_of_the_workspaces_folder_is_not_a_round(workspaces, task, tmp_path):
    real = rounds.start_round(task, tmp_path / "elsewhere", git=False, open_editor=False).path
    workspaces.mkdir()
    try:
        (workspaces / "link").symlink_to(real, target_is_directory=True)
    except OSError:
        pytest.skip("this machine can't create symlinks")
    with pytest.raises(rounds.UnknownRound):
        rounds.round_path("link")


def test_delete_round_refuses_a_folder_that_isnt_a_round(workspaces):
    (workspaces / "photos").mkdir(parents=True)
    with pytest.raises(rounds.UnknownRound):
        rounds.delete_round("photos")
    assert (workspaces / "photos").is_dir()


def test_delete_round_removes_a_git_workspace(workspaces, task):
    path = rounds.start_in_free_folder(task, open_editor=False).path
    rounds.delete_round(path.name)
    assert not path.exists()


def test_changes_against_the_starter_ignore_ibs_own_files(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", open_editor=False).path
    assert rounds.changes(task, dest) == rounds.Changes([], "", False)
    bucket = dest / "ratelimiter" / "bucket.py"
    bucket.write_text(bucket.read_text(encoding="utf-8").replace("class TokenBucket", "class Bucket"), encoding="utf-8")
    (dest / "extra.md").write_text("one\ntwo\n", encoding="utf-8")
    (dest / "blob.bin").write_bytes(b"\xff\xfe\x00")
    (dest / "ratelimiter" / "__init__.py").unlink()
    (dest / UI_STATE).write_text("{}", encoding="utf-8")
    found = rounds.changes(task, dest)
    assert [(f.path, f.status, f.additions, f.deletions) for f in found.files] == [
        ("blob.bin", "added", 0, 0),
        ("extra.md", "added", 2, 0),
        ("ratelimiter/__init__.py", "deleted", 0, found.files[2].deletions),
        ("ratelimiter/bucket.py", "modified", 1, 1),
    ]
    assert found.files[2].deletions > 0
    assert "+class Bucket" in found.diff and "+++ b/extra.md" in found.diff and not found.truncated


def test_changes_flag_a_truncated_diff(tmp_path, task, monkeypatch):
    dest = rounds.start_round(task, tmp_path / "ws", git=False, open_editor=False).path
    (dest / "extra.md").write_text("line\n" * 100, encoding="utf-8")
    monkeypatch.setattr(rounds, "MAX_DIFF_CHARS", 50)
    found = rounds.changes(task, dest)
    assert found.truncated and len(found.diff) == 50 and found.files[0].additions == 100


def test_fingerprint_follows_the_graded_files_only(tmp_path, task):
    dest = rounds.start_round(task, tmp_path / "ws", open_editor=False).path
    before = rounds.fingerprint(dest)
    (dest / UI_STATE).write_text("{}", encoding="utf-8")
    (dest / REPORT).write_text("report", encoding="utf-8")
    (dest / "__pycache__").mkdir()
    (dest / "__pycache__" / "a.pyc").write_bytes(b"x")
    assert rounds.fingerprint(dest) == before
    (dest / "extra.md").write_text("notes", encoding="utf-8")
    changed = rounds.fingerprint(dest)
    assert changed != before
    (dest / "extra.md").rename(dest / "extra2.md")
    assert rounds.fingerprint(dest) != changed


def test_ui_state_is_a_workspace_file_git_ignores(tmp_path, task):
    assert UI_STATE in WORKSPACE_FILES
    dest = rounds.start_round(task, tmp_path / "ws", open_editor=False).path
    assert UI_STATE in (dest / ".git" / "info" / "exclude").read_text(encoding="utf-8")


def test_suggested_attack_file_follows_each_tasks_naming(task):
    assert rounds.suggested_attack_file(task) == "test_attack.py"
    assert rounds.suggested_attack_file(get_task("flight-search-aggregator")) == "attack.test.ts"


@pytest.mark.parametrize("existing, suggested", [
    ("limiter_test.go", "attack_test.go"),
    ("widget.spec.tsx", "attack.spec.tsx"),
    ("Test_widget.py", "Test_attack.py"),
    ("OrderTest.java", "attackTest.java"),
    ("helpers.py", "attack_test.txt"),
])
def test_suggested_attack_file_from_other_namings(tmp_path, task, existing, suggested):
    (tmp_path / "environment" / "app" / "tests").mkdir(parents=True)
    (tmp_path / "environment" / "app" / "tests" / existing).write_text("", encoding="utf-8")
    other = type(task)(**{**task.__dict__, "path": tmp_path})
    assert rounds.suggested_attack_file(other) == suggested


ATTACK = """\
from ratelimiter import FakeClock, RateLimiter


def test_retry_after_is_zero_for_a_full_bucket():
    assert RateLimiter(5, 1, FakeClock()).retry_after("k") == 0.0
"""


def test_break_content_runs_from_memory_and_leaves_the_workspace_alone(tmp_path, task, runner):
    dest = rounds.start_round(task, tmp_path / "ws", git=False, open_editor=False).path
    before = rounds.fingerprint(dest)
    outcome = rounds.break_content(task, dest, "test_attack.py", ATTACK, runner)
    assert outcome.counts == {"real_break": 1, "survived": 0, "bad_test": 0}
    assert rounds.fingerprint(dest) == before


@pytest.mark.parametrize("name", ["../evil.py", "a/b.py", "..\\evil.py", "..", ".", "", "c:evil.py", "a b.py"])
def test_break_content_wants_a_bare_file_name(tmp_path, task, runner, name):
    with pytest.raises(rounds.RoundError, match="plain file name"):
        rounds.break_content(task, tmp_path, name, ATTACK, runner)


def test_prior_results_and_prompt_are_reused_instead_of_rerun(tmp_path, task, runner, solution_dir):
    dest = shutil.copytree(solution_dir, tmp_path / "ws")
    first = rounds.grade_round(task, dest, runner, judge="prepare")
    prior = score(task, first.result.stages, first.result.runner)
    phases = []
    reply = json.dumps(judge_answer(task))
    again = rounds.grade_round(
        task, dest, runner, judge="reply", reply=reply, prior=prior, request=first.request, progress=phases.append
    )
    assert phases == [] and again.judge_error is None
    assert again.result.graded_weight == again.result.total_weight
    assert "**Score: 100.0/100 (100%)**" in (dest / REPORT).read_text(encoding="utf-8")


def test_available_tasks_skips_a_broken_task(tmp_path, monkeypatch):
    repo = Path(__file__).resolve().parents[1]
    shutil.copytree(repo / "rubrics", tmp_path / "rubrics")
    shutil.copytree(repo / "tasks" / "backend" / "rate-limiter", tmp_path / "tasks" / "backend" / "rate-limiter")
    (tmp_path / "tasks" / "backend" / "broken").mkdir()
    (tmp_path / "tasks" / "backend" / "broken" / "task.toml").write_text("not toml =", encoding="utf-8")
    monkeypatch.setenv("IB_ROOT", str(tmp_path))
    assert [t.id for t in rounds.available_tasks()] == ["rate-limiter"]
    checks = {c.id: c for c in rounds.validate_tasks(None, None)}
    assert checks["rate-limiter"].errors == []
    assert "not valid TOML" in checks["broken"].errors[0]
    with pytest.raises(rounds.RoundError, match="Unknown task 'nope'"):
        rounds.validate_tasks(["nope"], None)
