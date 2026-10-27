"""The task-format rules in docs/TASK_FORMAT.md are enforced with clear errors."""

import shutil
from pathlib import Path

import pytest

from interviewbench.cli import check_task
from interviewbench.runner import DockerRunner, docker_available
from interviewbench.tasks import TaskError, get_task, load_all, load_task

REPO = Path(__file__).resolve().parents[1]


@pytest.fixture
def bench(tmp_path):
    """A copy of the rubrics and the rate-limiter task that a test can break."""
    shutil.copytree(REPO / "rubrics", tmp_path / "rubrics")
    shutil.copytree(REPO / "tasks" / "backend" / "rate-limiter", tmp_path / "tasks" / "backend" / "rate-limiter")
    return tmp_path


def task_dir(bench):
    return bench / "tasks" / "backend" / "rate-limiter"


def edit(path, old, new):
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


def test_copy_is_valid(bench):
    assert load_task(task_dir(bench)).id == "rate-limiter"


def test_rubric_layers_merge_by_id(bench):
    task = load_task(task_dir(bench))
    by_id = {c.id: c for c in task.criteria}
    assert by_id["communication"].weight == 5  # task override
    assert by_id["communication"].levels[3].startswith("As 2")  # inherited from base
    assert "TokenBucket" in by_id["root-cause"].levels[2]  # task-specific levels
    assert {"api-compatibility", "error-handling"} <= by_id.keys()  # from backend.yaml
    assert [c.type for c in task.criteria[:3]] == ["auto"] * 3
    assert len(task.focus) == 3
    assert by_id["business-alignment"].weight == 5  # task override of a base criterion
    assert "never exceeding a plan" in task.business


def test_business_alignment_needs_business_section(bench):
    rubric = task_dir(bench) / "rubric.yaml"
    edit(rubric, "business: |", "unused: |")
    with pytest.raises(TaskError, match="needs a `business` section"):
        load_task(task_dir(bench))

    # Excluding the criterion makes the section optional (code-quality takes back its weight).
    edit(rubric, "  - id: code-quality\n    weight: 5\n", "  - id: code-quality\n    weight: 10\n")
    without_override = rubric.read_text(encoding="utf-8").split("  - id: business-alignment")[0]
    rubric.write_text(without_override + "exclude: [business-alignment]\n", encoding="utf-8")
    task = load_task(task_dir(bench))
    assert "business-alignment" not in {c.id for c in task.criteria} and task.business == ""


def test_exclude_drops_inherited_criterion(bench):
    rubric = task_dir(bench) / "rubric.yaml"
    edit(rubric, "  - id: communication\n    weight: 5\n", "  - id: communication\n    weight: 10\n")
    rubric.write_text(rubric.read_text(encoding="utf-8") + "\nexclude: [api-compatibility]\n", encoding="utf-8")
    assert "api-compatibility" not in {c.id for c in load_task(task_dir(bench)).criteria}


@pytest.mark.parametrize(
    "file, old, new, message",
    [
        ("task.toml", 'category = "backend"', 'category = "frontend"', "metadata.category"),
        ("task.toml", 'name = "interviewbench/rate-limiter"', 'name = "x/rate-limiter"', "[task].name"),
        ("task.toml", 'name = "stage-2"', 'name = "two"', "must be named 'stage-2'"),
        ("task.toml", 'difficulty = "medium"', 'difficulty = "nightmare"', "difficulty"),
        ("rubric.yaml", "  - id: communication\n    weight: 5\n", "  - id: communication\n    weight: 6\n", "total 100"),
        ("rubric.yaml", "    stage: 3\n", "    stage: 4\n", "existing stage"),
        ("steps/stage-1/instruction.md", "# Fix the bug", "Fix the bug", "'# Title'"),
    ],
)
def test_broken_task_is_rejected(bench, file, old, new, message):
    edit(task_dir(bench) / file, old, new)
    with pytest.raises(TaskError, match=None) as exc:
        load_task(task_dir(bench))
    assert message in str(exc.value)


def test_missing_solve_script_is_rejected(bench):
    (task_dir(bench) / "steps" / "stage-2" / "solution" / "solve.sh").unlink()
    with pytest.raises(TaskError, match="solve.sh"):
        load_task(task_dir(bench))


def test_crlf_scripts_are_rejected(bench):
    script = task_dir(bench) / "tests" / "test.sh"
    script.write_bytes(script.read_bytes().replace(b"\n", b"\r\n"))
    with pytest.raises(TaskError, match="CRLF"):
        load_task(task_dir(bench))


def test_unknown_category_is_rejected(bench):
    shutil.move(task_dir(bench), bench / "tasks" / "mobile" / "rate-limiter")
    with pytest.raises(TaskError, match="rubrics/mobile.yaml"):
        load_all(bench / "tasks")


def test_task_ids_are_unique_across_categories(bench):
    shutil.copytree(task_dir(bench), bench / "tasks" / "devops" / "rate-limiter")
    edit(bench / "tasks" / "devops" / "rate-limiter" / "task.toml", 'category = "backend"', 'category = "devops"')
    with pytest.raises(TaskError, match="used twice"):
        load_all(bench / "tasks")
    with pytest.raises(TaskError, match="used twice"):
        get_task("rate-limiter", bench / "tasks")


def test_starter_that_already_passes_is_reported(bench, runner):
    task = load_task(task_dir(bench))
    shutil.copytree(task.stages[0].solution_dir / "files", task.starter_dir, dirs_exist_ok=True)
    assert "the starter code already passes stage 1" in check_task(task, runner)


@pytest.mark.skipif(not docker_available(), reason="Docker is not running")
def test_docker_runner_matches_harbor_contract():
    assert check_task(get_task("rate-limiter"), DockerRunner()) == []
