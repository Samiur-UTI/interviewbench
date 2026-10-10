import json
import shutil

from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench.cli import MARKER, app

runner = CliRunner()


def test_list_shows_tasks():
    result = runner.invoke(app, ["list"])
    assert result.exit_code == 0
    assert "rate-limiter" in result.output and "backend" in result.output


def test_start_creates_workspace(tmp_path):
    dest = tmp_path / "ws"
    result = runner.invoke(app, ["start", "rate-limiter", "--dir", str(dest)])
    assert result.exit_code == 0, result.output
    assert (dest / "ratelimiter" / "bucket.py").is_file()
    assert json.loads((dest / MARKER).read_text())["task"] == "rate-limiter"
    assert "Fix the bug" in result.output


def test_start_refuses_to_overwrite(tmp_path):
    dest = tmp_path / "ws"
    runner.invoke(app, ["start", "rate-limiter", "--dir", str(dest)])
    result = runner.invoke(app, ["start", "rate-limiter", "--dir", str(dest)])
    assert result.exit_code == 1


def test_unknown_task_errors():
    result = runner.invoke(app, ["start", "nope"])
    assert result.exit_code == 1
    assert "Unknown task" in result.output


def test_grade_solution_writes_report(tmp_path, solution_dir):
    ws = tmp_path / "ws"
    shutil.copytree(solution_dir, ws)
    result = runner.invoke(app, ["grade", "--dir", str(ws), "--task", "rate-limiter", "--runner", RUNNER_KIND])
    assert result.exit_code == 0, result.output
    report = (ws / "ib-report.md").read_text(encoding="utf-8")
    assert "45.0/45" in report
    assert f"{RUNNER_KIND} runner" in report


def test_grade_rejects_non_workspace(tmp_path):
    result = runner.invoke(app, ["grade", "--dir", str(tmp_path)])
    assert result.exit_code == 1


def test_validate_all_tasks():
    result = runner.invoke(app, ["validate"])
    assert result.exit_code == 0, result.output
    assert "ok backend/rate-limiter" in result.output

