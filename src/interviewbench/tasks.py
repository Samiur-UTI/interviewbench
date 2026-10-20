"""Loading and validating tasks.

A task is a Harbor multi-step task (https://harborframework.com/docs/tasks/multi-step) with a
few interviewbench-only extras. The full contract is in docs/TASK_FORMAT.md:

    tasks/<category>/<task-id>/
    ├── task.toml                 # Harbor config; ib settings under [metadata.interviewbench]
    ├── environment/Dockerfile    # builds the container; copies app/ to /app
    ├── environment/app/          # starter code (what `ib start` copies)
    ├── tests/test.sh             # verifier shared by all stages
    ├── steps/stage-N/            # instruction.md, tests/ (hidden tests), solution/solve.sh
    └── rubric.yaml               # ib-only: merged over rubrics/base.yaml + rubrics/<category>.yaml
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

CRITERION_TYPES = ("auto", "judge")
TOTAL_WEIGHT = 100
TASK_ORG = "interviewbench"
LEVELS = ("junior", "mid", "senior")
DIFFICULTIES = ("easy", "medium", "hard")
_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_LF_ONLY = ("*.sh", "Dockerfile", "*.toml")
# Files `ib` writes into a workspace. They are never graded, so a starter may not contain them.
MARKER = ".interviewbench.json"
BRIEF = "TASK.md"
REPORT = "ib-report.md"
JUDGE_PROMPT = "ib-judge-prompt.md"
JUDGE_REPLY = "ib-judge-reply.txt"
ATTACK_PROMPT = "ib-attack-prompt.md"
WORKSPACE_FILES = (MARKER, BRIEF, REPORT, JUDGE_PROMPT, JUDGE_REPLY, ATTACK_PROMPT)


class TaskError(Exception):
    pass


@dataclass
class Stage:
    number: int
    name: str
    title: str
    prompt: str
    path: Path

    @property
    def tests_dir(self) -> Path:
        return self.path / "tests"

    @property
    def solution_dir(self) -> Path:
        return self.path / "solution"


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
    category: str
    tags: list[str]
    difficulty: str
    level: str
    language: str
    time_limit_minutes: int
    stages: list[Stage]
    criteria: list[Criterion]
    focus: list[str]
    path: Path
    verifier_timeout: int
    candidate_tests: str | None = None
    attack_dir: str = "tests"  # where `ib break` puts attack tests, relative to the app folder
    cpus: int | None = None
    memory_mb: int | None = None

    @property
    def environment_dir(self) -> Path:
        return self.path / "environment"

    @property
    def starter_dir(self) -> Path:
        return self.environment_dir / "app"

    @property
    def shared_tests_dir(self) -> Path:
        return self.path / "tests"

    def stage(self, number: int) -> Stage:
        for s in self.stages:
            if s.number == number:
                return s
        raise TaskError(f"Task '{self.id}' has no stage {number} (stages: 1-{len(self.stages)})")


# --- Locations ------------------------------------------------------------------------------


def bench_root() -> Path:
    """Folder holding tasks/, rubrics/ and templates/: $IB_ROOT, the installed copy, or the repo."""
    env = os.environ.get("IB_ROOT")
    if env:
        return Path(env)
    bundled = Path(__file__).parent / "_bench"
    if bundled.is_dir():
        return bundled
    return Path(__file__).resolve().parents[2]


def tasks_root() -> Path:
    return bench_root() / "tasks"


def rubrics_root() -> Path:
    return bench_root() / "rubrics"


def templates_root() -> Path:
    return bench_root() / "templates"


def categories(root: Path | None = None) -> list[str]:
    """A category exists when rubrics/<category>.yaml does; its tasks live in tasks/<category>/."""
    rubrics = (root / "rubrics") if root else rubrics_root()
    return sorted(p.stem for p in rubrics.glob("*.yaml") if p.stem != "base")


# --- Loading --------------------------------------------------------------------------------


def _read_yaml(path: Path) -> dict:
    if not path.is_file():
        raise TaskError(f"Missing {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise TaskError(f"{path} must contain a mapping")
    return data


def _read_toml(path: Path) -> dict:
    if not path.is_file():
        raise TaskError(f"Missing {path}")
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise TaskError(f"{path} is not valid TOML: {exc}") from exc


def _title(instruction: Path) -> tuple[str, str]:
    """Split an instruction.md into its `# Title` and the rest."""
    if not instruction.is_file():
        raise TaskError(f"Missing {instruction}")
    text = instruction.read_text(encoding="utf-8").strip()
    first, _, rest = text.partition("\n")
    if not first.startswith("# "):
        raise TaskError(f"{instruction} must start with a '# Title' line")
    return first[2:].strip(), text


def _merge_rubric(layers: list[tuple[Path, dict]]) -> tuple[list[dict], list[str]]:
    """Merge rubric layers by criterion id; later layers override earlier ones field by field."""
    merged: dict[str, dict] = {}
    focus: list[str] = []
    for path, layer in layers:
        if layer.get("focus"):
            focus.append(str(layer["focus"]).strip())
        for cid in layer.get("exclude") or []:
            if merged.pop(cid, None) is None:
                raise TaskError(f"{path} excludes unknown criterion '{cid}'")
        for c in layer.get("criteria") or []:
            if not isinstance(c, dict) or "id" not in c:
                raise TaskError(f"{path}: every criterion needs an id")
            merged[c["id"]] = {**merged.get(c["id"], {}), **c}
    # Auto criteria first (in stage order), then judge criteria in the order they were declared.
    ordered = sorted(merged.values(), key=lambda c: (c.get("type") != "auto", c.get("stage") or 0))
    return ordered, focus


def load_task(task_dir: Path) -> Task:
    config = _read_toml(task_dir / "task.toml")
    category = task_dir.parent.name
    rubric_root = task_dir.parent.parent.parent / "rubrics"
    if not (rubric_root / f"{category}.yaml").is_file():
        known = ", ".join(categories(rubric_root.parent)) or "none"
        raise TaskError(
            f"{task_dir} is in unknown category '{category}' (known: {known}). "
            f"Add rubrics/{category}.yaml to create it."
        )
    layers = [
        (rubric_root / "base.yaml", _read_yaml(rubric_root / "base.yaml")),
        (rubric_root / f"{category}.yaml", _read_yaml(rubric_root / f"{category}.yaml")),
        (task_dir / "rubric.yaml", _read_yaml(task_dir / "rubric.yaml")),
    ]
    try:
        info = config["task"]
        meta = config.get("metadata", {})
        ib = meta.get("interviewbench", {})
        stages = []
        for i, step in enumerate(config.get("steps") or [], start=1):
            if step["name"] != f"stage-{i}":
                raise TaskError(f"{task_dir}: step {i} must be named 'stage-{i}', not '{step['name']}'")
            step_dir = task_dir / "steps" / step["name"]
            title, prompt = _title(step_dir / "instruction.md")
            stages.append(Stage(number=i, name=step["name"], title=title, prompt=prompt, path=step_dir))
        merged, focus = _merge_rubric(layers)
        criteria = [
            Criterion(
                id=c["id"],
                description=str(c["description"]).strip(),
                weight=float(c["weight"]),
                type=c["type"],
                stage=c.get("stage"),
                levels={int(k): str(v).strip() for k, v in (c.get("levels") or {}).items()},
            )
            for c in merged
        ]
        env = config.get("environment", {})
        task = Task(
            id=str(info["name"]).partition("/")[2] or str(info["name"]),
            title=info["description"],
            category=meta["category"],
            tags=list(meta.get("tags", [])),
            difficulty=meta.get("difficulty", "medium"),
            level=ib.get("level", "mid"),
            language=ib["language"],
            time_limit_minutes=int(ib.get("time_limit_minutes", 60)),
            stages=stages,
            criteria=criteria,
            focus=focus,
            path=task_dir,
            verifier_timeout=int(config.get("verifier", {}).get("timeout_sec", 120)),
            candidate_tests=ib.get("candidate_tests"),
            attack_dir=str(ib.get("attack_dir", "tests")).strip("/") or ".",
            cpus=env.get("cpus"),
            memory_mb=env.get("memory_mb"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise TaskError(f"Invalid task definition in {task_dir}: missing or bad field {exc!r}") from exc
    _validate(task, config)
    return task


# --- Validation -----------------------------------------------------------------------------


def _validate(task: Task, config: dict) -> None:
    def fail(msg: str) -> None:
        raise TaskError(f"Task '{task.id}' ({task.path}): {msg}")

    folder = task.path.name
    if config["task"]["name"] != f"{TASK_ORG}/{folder}":
        fail(f"[task].name must be '{TASK_ORG}/{folder}' (the folder name)")
    if not _ID_PATTERN.match(folder):
        fail("folder name must be lowercase letters, digits and hyphens")
    if task.category != task.path.parent.name:
        fail(f"metadata.category is '{task.category}' but the task is in tasks/{task.path.parent.name}/")
    if task.difficulty not in DIFFICULTIES:
        fail(f"metadata.difficulty must be one of {DIFFICULTIES}")
    if task.level not in LEVELS:
        fail(f"metadata.interviewbench.level must be one of {LEVELS}")
    if not (task.environment_dir / "Dockerfile").is_file():
        fail("missing environment/Dockerfile")
    if not task.starter_dir.is_dir():
        fail("missing environment/app/ (the starter code)")
    for name in WORKSPACE_FILES:
        if (task.starter_dir / name).exists():
            fail(f"environment/app/{name} is reserved: `ib start` writes it into the workspace")
    if not task.stages:
        fail("task.toml must declare at least one [[steps]]")
    shared_test = (task.shared_tests_dir / "test.sh").is_file()
    for s in task.stages:
        if not s.tests_dir.is_dir() or not any(p.is_file() for p in s.tests_dir.rglob("*")):
            fail(f"steps/{s.name}/tests/ must contain the hidden tests")
        if not shared_test and not (s.tests_dir / "test.sh").is_file():
            fail(f"no test.sh for {s.name}: add tests/test.sh or steps/{s.name}/tests/test.sh")
        if not (s.solution_dir / "solve.sh").is_file():
            fail(f"missing steps/{s.name}/solution/solve.sh")
    for pattern in _LF_ONLY:
        for path in task.path.rglob(pattern):
            if b"\r\n" in path.read_bytes():
                fail(f"{path.relative_to(task.path)} has CRLF line endings; it must use LF (see .gitattributes)")

    ids = [c.id for c in task.criteria]
    if len(ids) != len(set(ids)):
        fail("criterion ids must be unique")
    stage_numbers = {s.number for s in task.stages}
    for c in task.criteria:
        if c.type not in CRITERION_TYPES:
            fail(f"criterion '{c.id}' has type '{c.type}'; expected one of {CRITERION_TYPES}")
        if c.weight <= 0:
            fail(f"criterion '{c.id}' must have a positive weight")
        if c.type == "auto" and c.stage not in stage_numbers:
            fail(f"auto criterion '{c.id}' must reference an existing stage")
        if c.type == "judge" and (len(c.levels) < 2 or sorted(c.levels) != list(range(len(c.levels)))):
            fail(f"judge criterion '{c.id}' needs levels numbered 0, 1, 2, ...")
    missing = stage_numbers - {c.stage for c in task.criteria if c.type == "auto"}
    if missing:
        fail(f"every stage needs an auto criterion; missing for stage(s) {sorted(missing)}")
    total = sum(c.weight for c in task.criteria)
    if abs(total - TOTAL_WEIGHT) > 1e-9:
        fail(f"rubric weights must total {TOTAL_WEIGHT}, got {total:g}")


# --- Lookup ---------------------------------------------------------------------------------


def _task_dirs(root: Path) -> list[Path]:
    return sorted(d for d in root.glob("*/*") if (d / "task.toml").is_file())


def load_all(root: Path | None = None) -> list[Task]:
    root = root or tasks_root()
    if not root.is_dir():
        return []
    tasks = [load_task(d) for d in _task_dirs(root)]
    seen: dict[str, Path] = {}
    for t in tasks:
        if t.id in seen:
            raise TaskError(f"Task id '{t.id}' is used twice: {seen[t.id]} and {t.path}")
        seen[t.id] = t.path
    return tasks


def get_task(task_id: str, root: Path | None = None) -> Task:
    root = root or tasks_root()
    matches = [d for d in _task_dirs(root) if d.name == task_id] if root.is_dir() else []
    if not matches:
        available = ", ".join(d.name for d in _task_dirs(root)) if root.is_dir() else ""
        raise TaskError(f"Unknown task '{task_id}'. Available: {available or 'none'}")
    if len(matches) > 1:
        raise TaskError(f"Task id '{task_id}' is used twice: {', '.join(map(str, matches))}")
    return load_task(matches[0])

