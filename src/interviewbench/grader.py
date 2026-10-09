from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .tasks import Criterion, Task

if TYPE_CHECKING:
    from .judge import Review

DEFAULT_TIMEOUT = 120
CANDIDATE_TESTS = 0  # StageResult.stage for the candidate's own test suite
_IGNORE = shutil.ignore_patterns(
    ".git", ".venv", "__pycache__", ".pytest_cache", "*.pyc", "ib-report.md", ".interviewbench.json"
)


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

    @property
    def total_weight(self) -> float:
        return sum(s.criterion.weight for s in self.scores)

    @property
    def graded_weight(self) -> float:
        return sum(s.criterion.weight for s in self.scores if s.score is not None)

    @property
    def points(self) -> float:
        return sum(s.criterion.weight * s.score for s in self.scores if s.score is not None)


def run_stage_tests(task: Task, workspace: Path, stage: int, timeout: int = DEFAULT_TIMEOUT) -> StageResult:
    with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        work = tmp_path / "work"
        hidden = tmp_path / "hidden" / f"stage{stage}"
        shutil.copytree(workspace, work, ignore=_IGNORE)
        shutil.copytree(task.hidden_tests_dir(stage), hidden, ignore=_IGNORE)

        # Our own ini + cwd outside the workspace, so candidate files (conftest.py, pytest.ini,
        # a shadowing pytest.py) can't change how the hidden tests run.
        ini = tmp_path / "pytest.ini"
        ini.write_text(f"[pytest]\npythonpath = {work.as_posix()}\n", encoding="utf-8")
        args = [
            str(hidden), "-c", str(ini), "--rootdir", str(tmp_path),
            "--noconftest", "--import-mode=importlib",
        ]
        return _run_pytest(stage, args, tmp_path, tmp_path / "junit.xml", timeout)


def run_candidate_tests(workspace: Path, timeout: int = DEFAULT_TIMEOUT) -> StageResult:
    """Run the tests the candidate wrote, the way they would run them: `python -m pytest` from the repo root."""
    with tempfile.TemporaryDirectory(prefix="ib-", ignore_cleanup_errors=True) as tmp:
        work = Path(tmp) / "work"
        shutil.copytree(workspace, work, ignore=_IGNORE)
        return _run_pytest(CANDIDATE_TESTS, [], work, Path(tmp) / "junit.xml", timeout)


def _run_pytest(stage: int, args: list[str], cwd: Path, junit: Path, timeout: int) -> StageResult:
    cmd = [sys.executable, "-m", "pytest", *args, "-p", "no:cacheprovider", "-q", f"--junitxml={junit}"]
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=_clean_env())
    except subprocess.TimeoutExpired:
        return StageResult(stage, 0, 0, error=f"Tests timed out after {timeout}s")
    if not junit.exists():
        return StageResult(stage, 0, 0, error=_tail(proc.stdout + proc.stderr))
    return _parse_junit(stage, junit)


def _clean_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


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
    return "\n".join(text.strip().splitlines()[-lines:]) or "pytest produced no output"


def grade(task: Task, workspace: Path, timeout: int = DEFAULT_TIMEOUT) -> GradeResult:
    stages = [run_stage_tests(task, workspace, s.number, timeout) for s in task.stages]
    by_stage = {r.stage: r for r in stages}
    scores: list[CriterionScore] = []
    for c in task.criteria:
        if c.type == "auto":
            r = by_stage[c.stage]
            scores.append(CriterionScore(c, r.ratio, r.error or f"{r.passed}/{r.total} hidden tests passed"))
        else:
            scores.append(CriterionScore(c, None, "Needs the AI judge (not run)"))
    return GradeResult(task, stages, scores)
