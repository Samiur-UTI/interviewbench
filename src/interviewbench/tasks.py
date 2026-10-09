from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

CRITERION_TYPES = ("auto", "judge")


class TaskError(Exception):
    pass


@dataclass
class Stage:
    number: int
    title: str
    prompt: str


@dataclass
class Criterion:
    id: str
    description: str
    weight: float
    type: str
    stage: int | None = None
    levels: dict[int, str] = field(default_factory=dict)


@dataclass
class Task:
    id: str
    title: str
    level: str
    language: str
    time_limit_minutes: int
    summary: str
    stages: list[Stage]
    criteria: list[Criterion]
    path: Path

    @property
    def repo_dir(self) -> Path:
        return self.path / "repo"

    @property
    def solution_dir(self) -> Path:
        return self.path / "solution"

    def hidden_tests_dir(self, stage: int) -> Path:
        return self.path / "tests" / f"stage{stage}"

    def stage(self, number: int) -> Stage:
        for s in self.stages:
            if s.number == number:
                return s
        raise TaskError(f"Task '{self.id}' has no stage {number} (stages: 1-{len(self.stages)})")


def tasks_root() -> Path:
    env = os.environ.get("IB_TASKS_DIR")
    if env:
        return Path(env)
    bundled = Path(__file__).parent / "_tasks"
    if bundled.is_dir():
        return bundled
    return Path(__file__).resolve().parents[2] / "tasks"


def _read_yaml(path: Path) -> dict:
    if not path.is_file():
        raise TaskError(f"Missing {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise TaskError(f"{path} must contain a mapping")
    return data


def load_task(task_dir: Path) -> Task:
    meta = _read_yaml(task_dir / "task.yaml")
    rubric = _read_yaml(task_dir / "rubric.yaml")
    try:
        stages = [
            Stage(number=i, title=s["title"], prompt=s["prompt"].strip())
            for i, s in enumerate(meta["stages"], start=1)
        ]
        criteria = [
            Criterion(
                id=c["id"],
                description=c["description"].strip(),
                weight=float(c["weight"]),
                type=c["type"],
                stage=c.get("stage"),
                levels={int(k): str(v).strip() for k, v in (c.get("levels") or {}).items()},
            )
            for c in rubric["criteria"]
        ]
        task = Task(
            id=meta["id"],
            title=meta["title"],
            level=meta.get("level", "mid"),
            language=meta.get("language", "python"),
            time_limit_minutes=int(meta.get("time_limit_minutes", 60)),
            summary=meta.get("summary", "").strip(),
            stages=stages,
            criteria=criteria,
            path=task_dir,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise TaskError(f"Invalid task definition in {task_dir}: {exc!r}") from exc
    _validate(task)
    return task


def _validate(task: Task) -> None:
    if task.id != task.path.name:
        raise TaskError(f"Task id '{task.id}' must match its folder name '{task.path.name}'")
    if not task.repo_dir.is_dir():
        raise TaskError(f"Task '{task.id}' is missing repo/")
    stage_numbers = {s.number for s in task.stages}
    for s in task.stages:
        if not task.hidden_tests_dir(s.number).is_dir():
            raise TaskError(f"Task '{task.id}' is missing tests/stage{s.number}/")
    for c in task.criteria:
        if c.type not in CRITERION_TYPES:
            raise TaskError(f"Criterion '{c.id}' has type '{c.type}'; expected one of {CRITERION_TYPES}")
        if c.weight <= 0:
            raise TaskError(f"Criterion '{c.id}' must have a positive weight")
        if c.type == "auto" and c.stage not in stage_numbers:
            raise TaskError(f"Auto criterion '{c.id}' must reference an existing stage")
        if c.type == "judge" and (len(c.levels) < 2 or sorted(c.levels) != list(range(len(c.levels)))):
            raise TaskError(f"Judge criterion '{c.id}' needs levels numbered 0, 1, 2, ...")


def load_all(root: Path | None = None) -> list[Task]:
    root = root or tasks_root()
    if not root.is_dir():
        return []
    return [load_task(d) for d in sorted(root.iterdir()) if (d / "task.yaml").is_file()]


def get_task(task_id: str, root: Path | None = None) -> Task:
    root = root or tasks_root()
    task_dir = root / task_id
    if not (task_dir / "task.yaml").is_file():
        available = ", ".join(t.id for t in load_all(root)) or "none"
        raise TaskError(f"Unknown task '{task_id}'. Available: {available}")
    return load_task(task_dir)
