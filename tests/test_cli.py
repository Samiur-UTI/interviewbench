import json
import shutil

from typer.testing import CliRunner

from conftest import RUNNER_KIND
from interviewbench import workspace as ws
from interviewbench.cli import app
from interviewbench.grader import _IGNORE
from interviewbench.tasks import BRIEF, MARKER, bench_root

runner = CliRunner()


def test_list_shows_tasks():
    result = runner.invoke(app, ["list"])
    assert result.exit_code == 0
    assert "rate-limiter" in result.output and "backend" in result.output


def test_list_filters_by_category_and_tag():
    assert "rate-limiter" not in runner.invoke(app, ["list", "--category", "frontend"]).output
    assert "rate-limiter" in runner.invoke(app, ["list", "--tag", "python"]).output
    assert "rate-limiter" not in runner.invoke(app, ["list", "--tag", "react"]).output


def flat(output):
    """CLI output with Rich's line wrapping undone."""
    return " ".join(output.split())


def start(dest, *extra):
    return runner.invoke(app, ["start", "rate-limiter", "--dir", str(dest), "--no-open", *extra])


def test_start_creates_workspace(tmp_path):
    dest = tmp_path / "ws"
    result = start(dest)
    assert result.exit_code == 0, result.output
    assert (dest / "ratelimiter" / "bucket.py").is_file()
    marker = json.loads((dest / MARKER).read_text())
    assert marker["task"] == "rate-limiter" and marker["stage"] == 1
    assert "Fix the bug" in result.output
    brief = (dest / BRIEF).read_text(encoding="utf-8")
    assert "## Stage 1/3: Fix the bug" in brief and "Incident report" in brief
    assert "Stage 2" not in brief  # later stages stay hidden until `ib next`


def test_start_refuses_to_overwrite(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    assert start(dest).exit_code == 1
    assert start(dest, "--force").exit_code == 0


def test_start_force_leaves_a_project_folder_alone(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "app.py").write_text("mine\n", encoding="utf-8")
    result = start(project, "--force")
    assert result.exit_code == 1
    assert "isn't an interviewbench workspace" in flat(result.output) and "Use --force" not in flat(result.output)
    assert [p.name for p in project.iterdir()] == ["app.py"]


def test_start_defaults_to_a_folder_outside_the_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("IB_WORKSPACES", str(tmp_path / "rounds"))
    result = runner.invoke(app, ["start", "rate-limiter", "--no-open"])
    assert result.exit_code == 0, result.output
    assert (tmp_path / "rounds" / "rate-limiter" / BRIEF).is_file()


def test_start_refuses_a_folder_inside_the_repo():
    inside = bench_root() / "ib-workspace" / "rate-limiter"
    result = start(inside)
    assert result.exit_code == 1
    assert "hidden tests" in flat(result.output)
    assert not inside.exists()


def test_start_opens_the_editor(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setenv("IB_EDITOR", "my-editor --new-window")
    monkeypatch.setattr(ws, "_launch", calls.append)
    dest = tmp_path / "ws"
    result = runner.invoke(app, ["start", "rate-limiter", "--dir", str(dest)])
    assert result.exit_code == 0, result.output
    assert calls == [["my-editor", "--new-window", str(dest)]]
    assert "opened in my-editor" in flat(result.output)


def test_start_without_an_editor_says_how_to_open_the_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("IB_EDITOR", "")
    result = runner.invoke(app, ["start", "rate-limiter", "--dir", str(tmp_path / "ws")])
    assert result.exit_code == 0, result.output
    assert "only this folder" in flat(result.output)


def test_next_reveals_one_stage_at_a_time(tmp_path):
    dest = tmp_path / "ws"
    start(dest)
    for number in (2, 3):
        result = runner.invoke(app, ["next", "--dir", str(dest)])
        assert result.exit_code == 0, result.output
        assert json.loads((dest / MARKER).read_text())["stage"] == number
        assert f"## Stage {number}/3" in (dest / BRIEF).read_text(encoding="utf-8")
    result = runner.invoke(app, ["next", "--dir", str(dest)])
    assert result.exit_code == 1 and "already revealed" in flat(result.output)


def test_next_outside_a_workspace_errors(tmp_path):
    result = runner.invoke(app, ["next", "--dir", str(tmp_path)])
    assert result.exit_code == 1 and "not an interviewbench workspace" in flat(result.output)


def test_workspace_files_are_never_graded(tmp_path, solution_dir):
    ws = tmp_path / "ws"
    shutil.copytree(solution_dir, ws)
    (ws / BRIEF).write_text("# brief\n", encoding="utf-8")
    copy = tmp_path / "copy"
    shutil.copytree(ws, copy, ignore=_IGNORE)
    assert not (copy / BRIEF).exists()


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


def test_new_creates_valid_skeleton(tmp_path, monkeypatch):
    root = tmp_path / "bench"
    for folder in ("rubrics", "templates"):
        shutil.copytree(f"{folder}", root / folder)
    (root / "tasks").mkdir()
    monkeypatch.setenv("IB_ROOT", str(root))
    result = runner.invoke(app, ["new", "order-api", "--category", "backend"])
    assert result.exit_code == 0, result.output
    task_toml = (root / "tasks" / "backend" / "order-api" / "task.toml").read_text(encoding="utf-8")
    assert 'name = "interviewbench/order-api"' in task_toml
    # The skeleton loads and passes static validation; only its TODO content is missing.
    assert runner.invoke(app, ["validate", "order-api"]).exit_code == 0
    assert runner.invoke(app, ["new", "order-api", "--category", "backend"]).exit_code == 1


def test_new_rejects_unknown_category():
    result = runner.invoke(app, ["new", "x", "--category", "mobile"])
    assert result.exit_code == 1
    assert "rubrics/mobile.yaml" in result.output


def test_output_survives_a_pipe_without_a_utf8_locale():
    """Piped or redirected, Python on Windows writes the ANSI code page, which can't encode the
    briefs' U+2212; ib used to crash with UnicodeEncodeError. It must write UTF-8 instead."""
    import os
    import subprocess
    import sys

    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONIOENCODING", "PYTHONUTF8")}
    if os.name == "nt":
        env["PYTHONUTF8"] = "0"  # the default for Windows users: no UTF-8 mode
    done = subprocess.run(
        [sys.executable, "-m", "interviewbench", "prompt", "flight-search-aggregator"],
        capture_output=True, env=env, timeout=60,
    )
    assert done.returncode == 0, done.stderr.decode("utf-8", "replace")[-500:]
    assert "−" in done.stdout.decode("utf-8")
