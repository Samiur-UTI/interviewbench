"""A round from the candidate's side: git history per stage, editor tasks and `ib test`."""

import json
import shutil
import stat
import subprocess
import sys

import pytest
from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench import workspace as ws
from interviewbench.cli import app
from interviewbench.tasks import BRIEF, MARKER

cli = CliRunner()


def flat(output):
    return " ".join(output.split())


def git(dest, *args):
    return subprocess.run(["git", "-C", str(dest), *args], capture_output=True, text=True, check=True).stdout.strip()


def start(dest, *extra):
    result = cli.invoke(app, ["start", "rate-limiter", "--dir", str(dest), "--no-open", *extra])
    assert result.exit_code == 0, result.output
    return result


def test_start_makes_a_git_repo_with_the_starter_commit(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    assert git(dest, "log", "--format=%s by %an") == "starter by interviewbench"
    assert git(dest, "status", "--porcelain") == ""  # ib's own files never show up as changes
    tracked = git(dest, "ls-files").splitlines()
    assert "ratelimiter/bucket.py" in tracked
    assert not {BRIEF, MARKER, ".vscode/tasks.json"} & set(tracked)
    assert json.loads((dest / MARKER).read_text())["git"] is True
    assert "git repo" in (dest / BRIEF).read_text(encoding="utf-8")


def test_remove_tree_deletes_read_only_files(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    objects = [p for p in (dest / ".git" / "objects").rglob("*") if p.is_file()]
    assert objects
    objects[0].chmod(stat.S_IREAD)  # git does this itself; Windows then refuses to delete them
    ws.remove_tree(dest)
    assert not dest.exists()


def test_remove_tree_leaves_the_target_of_a_link_alone(tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("keep me", encoding="utf-8")
    outside.chmod(stat.S_IREAD)
    dest = tmp_path / "ws"
    dest.mkdir()
    try:
        (dest / "link").symlink_to(outside)
    except OSError:
        pytest.skip("this machine can't create symlinks")
    ws.remove_tree(dest)
    assert not dest.exists()
    assert not outside.stat().st_mode & stat.S_IWRITE


def test_start_without_git(tmp_path):
    dest = tmp_path / "ws"
    start(dest, "--no-git")
    assert not (dest / ".git").exists()
    assert json.loads((dest / MARKER).read_text())["git"] is False


def test_start_when_git_is_missing(tmp_path, monkeypatch):
    which = shutil.which
    monkeypatch.setattr(ws.shutil, "which", lambda name: None if name == "git" else which(name))
    dest = tmp_path / "ws"
    result = start(dest)
    assert not (dest / ".git").exists()
    assert "isn't available" in flat(result.output)


def test_next_commits_and_tags_each_stage(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    (dest / "NOTES.md").write_text("found it\n", encoding="utf-8")
    result = cli.invoke(app, ["next", "--dir", str(dest)])
    assert result.exit_code == 0, result.output
    assert "tagged it stage-1" in flat(result.output)
    assert git(dest, "show", "stage-1:NOTES.md") == "found it"
    assert git(dest, "status", "--porcelain") == ""
    cli.invoke(app, ["next", "--dir", str(dest)])
    assert git(dest, "tag").split() == ["stage-1", "stage-2"]


def test_editor_tasks_run_ib_with_this_python(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    tasks = json.loads((dest / ".vscode" / "tasks.json").read_text(encoding="utf-8"))["tasks"]
    labels = [t["label"] for t in tasks]
    assert labels[:3] == ["ib: run my tests", "ib: next stage", "ib: grade"]
    assert "ib: grade with the AI judge" in labels
    assert tasks[0]["command"] == sys.executable and tasks[0]["args"] == ["-m", "interviewbench", "test"]
    # What the editor runs really works from the workspace, with no `ib` on PATH needed.
    done = subprocess.run(
        [sys.executable, "-m", "interviewbench", "test", "--runner", RUNNER_KIND],
        cwd=dest, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    assert "4/4 of your tests passed" in flat(done.stdout)


def test_a_starters_own_editor_tasks_are_kept(tmp_path):
    (tmp_path / ".vscode").mkdir()
    (tmp_path / ".vscode" / "tasks.json").write_text("{}", encoding="utf-8")
    assert ws.write_editor_tasks(tmp_path) is False
    assert (tmp_path / ".vscode" / "tasks.json").read_text(encoding="utf-8") == "{}"


def test_ib_test_shows_your_failures_but_no_hidden_tests(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    (dest / "tests" / "test_extra.py").write_text("def test_broken():\n    assert 1 == 2\n", encoding="utf-8")
    result = cli.invoke(app, ["test", "--dir", str(dest), "--runner", RUNNER_KIND])
    assert result.exit_code == 1
    out = flat(result.output)
    assert "test_broken" in out and "4/5 of your tests passed" in out
    assert "test_burst_after_idle_is_capped_at_capacity" not in out  # a hidden stage 1 test


def test_ib_test_prints_brackets_in_your_tests_as_text(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    (dest / "tests" / "test_extra.py").write_text(
        "import pytest\n\n\ndef test_route():\n    assert '[/api]' == 'x'\n\n\n"
        "@pytest.mark.parametrize('plan', ['x'], ids=['cheap-plan'])\n"
        "def test_plan(plan):\n    assert '[object Object]' == plan\n",
        encoding="utf-8",
    )
    result = cli.invoke(app, ["test", "--dir", str(dest), "--runner", RUNNER_KIND])
    assert result.exit_code == 1 and isinstance(result.exception, SystemExit), result.exception  # no MarkupError
    out = flat(result.output)
    assert "[/api]" in out and "test_plan[cheap-plan]" in out and "[object Object]" in out
    assert "4/6 of your tests passed" in out


def test_ib_test_outside_a_workspace_errors(tmp_path):
    result = cli.invoke(app, ["test", "--dir", str(tmp_path)])
    assert result.exit_code == 1 and "not an interviewbench workspace" in flat(result.output)
