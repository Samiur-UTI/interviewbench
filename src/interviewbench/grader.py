from __future__ import annotations

import os
import shutil
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterator

from .runner import Completed, Runner, RunnerError, Sandbox, get_runner
from .tasks import WORKSPACE_FILES, Criterion, Stage, Task

if TYPE_CHECKING:
    from .judge import Review

Progress = Callable[[str], None]  # called with a sentence for the candidate before each long step
CANDIDATE_TESTS = 0  # StageResult.stage for the candidate's own test suite
_IGNORE = shutil.ignore_patterns(
    ".git", ".venv", ".vscode", "node_modules", "__pycache__", ".pytest_cache", "*.pyc",
    *WORKSPACE_FILES,
)


def no_progress(phase: str) -> None:
    pass


@dataclass
class TestFailure:
    name: str
    message: str


@dataclass
class StageResult:
    stage: int
    passed: int
    total: int
    failures: list[TestFailure] = field(default_factory=list)
    error: str | None = None

    @property
    def ratio(self) -> float:
        return self.passed / self.total if self.total else 0.0


@dataclass
class CriterionScore:
    criterion: Criterion
    score: float | None
    evidence: str


@dataclass
class GradeResult:
    task: Task
    stages: list[StageResult]
    scores: list[CriterionScore]
    review: Review | None = None
    runner: str = ""

    @property
    def total_weight(self) -> float:
        return sum(s.criterion.weight for s in self.scores)

    @property
    def graded_weight(self) -> float:
        return sum(s.criterion.weight for s in self.scores if s.score is not None)

    @property
    def points(self) -> float:
        return sum(s.criterion.weight * s.score for s in self.scores if s.score is not None)


def _copy_app(source: Path, dest: Path) -> Path:
    shutil.copytree(source, dest, ignore=_IGNORE)
    return dest


def graded_files(root: Path) -> Iterator[Path]:
    """The files under `root` that `_copy_app` copies, in a stable order."""
    for dirpath, dirnames, filenames in os.walk(root):
        ignored = _IGNORE(dirpath, dirnames + filenames)
        dirnames[:] = sorted(d for d in dirnames if d not in ignored)
        for name in sorted(n for n in filenames if n not in ignored):
            yield Path(dirpath) / name


def _stage_tests(task: Task, stage: Stage, dest: Path) -> Path:
    """Shared tests/ then the stage's tests/ on top, as Harbor uploads them to /tests."""
    dest.mkdir(parents=True)
    if task.shared_tests_dir.is_dir():
        shutil.copytree(task.shared_tests_dir, dest, ignore=_IGNORE, dirs_exist_ok=True)
    shutil.copytree(stage.tests_dir, dest, ignore=_IGNORE, dirs_exist_ok=True)
    return dest


def run_stage_tests(
    task: Task, workspace: Path, stage: int, runner: Runner, timeout: int | None = None
) -> StageResult:
    with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        sandbox = Sandbox(
            app=_copy_app(workspace, tmp_path / "app"),
            tests=_stage_tests(task, task.stage(stage), tmp_path / "tests"),
            logs=tmp_path / "logs",
            temp=tmp_path / "temp",
        )
        done = runner.run(task, 'bash "$TESTS_DIR/test.sh"', sandbox, timeout or task.verifier_timeout)
        return _result(stage, done, sandbox.logs / "junit.xml", timeout or task.verifier_timeout)


def run_candidate_tests(task: Task, workspace: Path, runner: Runner, timeout: int | None = None) -> StageResult:
    """Run the tests the candidate wrote, with the task's `candidate_tests` command."""
    if not task.candidate_tests:
        return StageResult(CANDIDATE_TESTS, 0, 0, error="This task does not define candidate_tests")
    with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        sandbox = Sandbox(
            app=_copy_app(workspace, tmp_path / "app"), logs=tmp_path / "logs", temp=tmp_path / "temp"
        )
        done = runner.run(task, task.candidate_tests, sandbox, timeout or task.verifier_timeout)
        return _result(CANDIDATE_TESTS, done, sandbox.logs / "junit.xml", timeout or task.verifier_timeout)


def build_reference(task: Task, dest: Path, runner: Runner, upto: int | None = None) -> Path:
    """Write the starter code plus each stage's reference solution (through `upto`) to `dest`.

    Runs each stage's solve.sh, exactly like Harbor's oracle agent does.
    """
    if dest.exists():
        shutil.rmtree(dest)
    with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
        app = _copy_app(task.starter_dir, Path(tmp) / "app")
        for stage in task.stages[:upto]:
            sandbox = Sandbox(
                app=app, solution=stage.solution_dir, logs=Path(tmp) / "logs", temp=Path(tmp) / "temp"
            )
            done = runner.run(task, 'bash "$SOLUTION_DIR/solve.sh"', sandbox, task.verifier_timeout)
            if done.returncode != 0:
                raise RunnerError(f"{stage.name}/solution/solve.sh failed:\n{_tail(done.output)}")
        shutil.copytree(app, dest, ignore=_IGNORE)
    return dest


def _result(stage: int, done: Completed, junit: Path, timeout: int) -> StageResult:
    if done.timed_out:
        return StageResult(stage, 0, 0, error=f"Tests timed out after {timeout}s")
    if not junit.is_file():
        return StageResult(stage, 0, 0, error=_tail(done.output))
    try:
        return _parse_junit(stage, junit)
    except ET.ParseError:
        return StageResult(stage, 0, 0, error="Unreadable JUnit XML\n" + _tail(done.output))


def _parse_junit(stage: int, path: Path) -> StageResult:
    root = ET.parse(path).getroot()
    passed = total = 0
    failures: list[TestFailure] = []
    for case in root.iter("testcase"):
        total += 1
        bad = next((c for c in case if c.tag in ("failure", "error", "skipped")), None)
        if bad is None:
            passed += 1
            continue
        lines = (bad.get("message") or bad.tag).strip().splitlines()
        failures.append(TestFailure(case.get("name", "?"), (lines[0] if lines else bad.tag)[:200]))
    return StageResult(stage, passed, total, failures)


def _tail(text: str, lines: int = 15) -> str:
    return "\n".join(text.strip().splitlines()[-lines:]) or "The tests produced no output"


def grade(
    task: Task,
    workspace: Path,
    runner: Runner | None = None,
    timeout: int | None = None,
    progress: Progress = no_progress,
) -> GradeResult:
    runner = runner or get_runner()
    stages = []
    for s in task.stages:
        progress(f"Running hidden tests for stage {s.number} of {len(task.stages)}")
        stages.append(run_stage_tests(task, workspace, s.number, runner, timeout))
    return score(task, stages, runner.name)


def score(task: Task, stages: list[StageResult], runner_name: str) -> GradeResult:
    """Turn stage results into rubric scores. The judge criteria stay ungraded."""
    by_stage = {r.stage: r for r in stages}
    scores: list[CriterionScore] = []
    for c in task.criteria:
        if c.type == "auto":
            r = by_stage[c.stage]
            scores.append(CriterionScore(c, r.ratio, r.error or f"{r.passed}/{r.total} hidden tests passed"))
        else:
            scores.append(CriterionScore(c, None, "Needs the AI judge (not run)"))
    return GradeResult(task, stages, scores, runner=runner_name)
