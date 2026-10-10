"""Every task must follow docs/TASK_FORMAT.md: the starter fails stage 1 and the reference passes."""

import pytest

from interviewbench.cli import check_task
from interviewbench.tasks import load_all

TASKS = load_all()


def test_tasks_exist():
    assert TASKS, "no tasks found"


@pytest.mark.parametrize("task", TASKS, ids=lambda t: f"{t.category}/{t.id}")
def test_starter_fails_and_each_stage_solution_passes(task, runner):
    assert check_task(task, runner) == []


@pytest.mark.parametrize("task", TASKS, ids=lambda t: f"{t.category}/{t.id}")
def test_harbor_accepts_task(task):
    harbor = pytest.importorskip("harbor.models.task.task", reason="pip install harbor to check")
    loaded = harbor.Task(task.path)
    assert harbor.Task.is_valid_dir(task.path)
    assert [s.name for s in loaded.config.steps] == [s.name for s in task.stages]
