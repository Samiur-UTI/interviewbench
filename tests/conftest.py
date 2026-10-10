import os

import pytest

from interviewbench.grader import build_reference
from interviewbench.runner import get_runner
from interviewbench.tasks import get_task

# The suite runs task scripts with the local runner (bash) by default. IB_TEST_RUNNER=docker runs
# the same tests in containers, as Harbor would.
RUNNER_KIND = os.environ.get("IB_TEST_RUNNER", "local")


@pytest.fixture(scope="session")
def runner():
    return get_runner(RUNNER_KIND)


@pytest.fixture(scope="session")
def task():
    return get_task("rate-limiter")


@pytest.fixture(scope="session")
def solution_dir(task, runner, tmp_path_factory):
    """The rate-limiter reference solution: starter + every stage's solve.sh."""
    return build_reference(task, tmp_path_factory.mktemp("ref") / "solution", runner)
