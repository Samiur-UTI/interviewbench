import pytest

from interviewbench.grader import grade
from interviewbench.tasks import load_all

TASKS = load_all()


def test_tasks_exist():
    assert TASKS, "no tasks found"


@pytest.mark.parametrize("task", TASKS, ids=lambda t: t.id)
def test_starter_repo_fails_stage1(task):
    result = grade(task, task.repo_dir)
    assert result.stages[0].ratio < 1, "starter repo should not already pass stage 1"


@pytest.mark.parametrize("task", TASKS, ids=lambda t: t.id)
def test_solution_passes_every_stage(task):
    assert task.solution_dir.is_dir(), "every task needs a reference solution/"
    result = grade(task, task.solution_dir)
    for stage in result.stages:
        assert stage.error is None, stage.error
        assert stage.total > 0
        assert stage.passed == stage.total, [f.name for f in stage.failures]
