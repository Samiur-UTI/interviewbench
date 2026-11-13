"""`ib break`: attack tests written by any LLM, refereed by the task's reference solution.

An attack test only counts if the reference solution passes it, so a model that misreads the brief
can't produce fake "bugs". This works for any language: the attack file runs with the task's own
`candidate_tests` command, and the attack tests are found as the JUnit test cases that appear only
once the file is added.
"""

from __future__ import annotations

import shutil
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from .grader import Progress, _copy_app, _tail, build_reference, no_progress
from .judge import _files_block, _read_tree
from .runner import Runner, RunnerError, Sandbox
from .tasks import Task
from .workspace import stage_section

REAL_BREAK, BAD_TEST, SURVIVED = "real break", "bad test", "survived"


@dataclass
class Attack:
    name: str
    verdict: str  # REAL_BREAK, BAD_TEST or SURVIVED
    detail: str = ""


def run_break(
    task: Task,
    workspace: Path,
    attack: Path,
    runner: Runner,
    timeout: int | None = None,
    progress: Progress = no_progress,
    upto: int | None = None,
) -> list[Attack]:
    """Run `attack` against the candidate's code and the reference solution. Raises RunnerError.

    `upto`: the stages the reference solves, which should be the ones the candidate has been asked
    for. A later stage's reference would judge an attack by behaviour that stage changes, and its
    failure messages would describe it. None solves every stage.
    """
    if not task.candidate_tests:
        raise RunnerError(f"Task '{task.id}' defines no candidate_tests command, so attack tests can't run")
    if not attack.is_file():
        raise RunnerError(f"{attack} is not a file")
    destination = Path(task.attack_dir) / attack.name
    with tempfile.TemporaryDirectory(prefix="ib-break-", ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        progress("Building the reference solution")
        reference = build_reference(task, tmp_path / "reference", runner, upto=upto)
        baseline = _cases(task, runner, reference, tmp_path / "logs-baseline", timeout)
        progress("Running the attack tests on the reference solution")
        _place(attack, reference / destination)
        on_reference = _cases(task, runner, reference, tmp_path / "logs-reference", timeout)
        progress("Running the attack tests on your code")
        yours = _copy_app(workspace, tmp_path / "yours")
        _place(attack, yours / destination)
        on_yours = _cases(task, runner, yours, tmp_path / "logs-yours", timeout)

    attacks = []
    for case_id, ref_error in on_reference.items():
        if case_id in baseline:
            continue  # one of the existing tests, not an attack
        name = case_id.rpartition("::")[2]
        if ref_error is not None:
            attacks.append(Attack(name, BAD_TEST, f"fails on the reference too: {ref_error}"))
        elif case_id not in on_yours:
            attacks.append(Attack(name, REAL_BREAK, "did not run on your code"))
        elif on_yours[case_id] is not None:
            attacks.append(Attack(name, REAL_BREAK, on_yours[case_id]))
        else:
            attacks.append(Attack(name, SURVIVED))
    if not attacks:
        raise RunnerError(
            f"No attack tests ran from {attack.name} (placed at {destination.as_posix()}). "
            "Check the file defines tests the task's test runner collects."
        )
    return attacks


def attack_prompt(task: Task, workspace: Path, revealed: int) -> str:
    """A prompt for any chatbot or coding agent: break this code, as a test file for this codebase."""
    files, _ = _read_tree(workspace)
    briefs = "\n\n".join(stage_section(task, n) for n in range(1, revealed + 1))
    return (
        "# Try to break this code\n\n"
        "Below are a coding task's brief and a candidate's solution. Write tests that try to break the "
        "solution.\n\n"
        "Rules:\n"
        "- Write ONE test file, using the same test framework, style and helpers as the existing tests. "
        f"It will be saved as `{task.attack_dir}/<file name>` in the project, so imports must work from there.\n"
        "- Each test must check behaviour the brief requires. Don't test private details or anything "
        "the brief leaves open: tests that a correct solution fails are thrown away.\n"
        "- Go for what's easy to get wrong: boundary values, invalid input, rounding, timing, ordering, "
        "repeated or concurrent calls, and any performance limits in the brief.\n"
        "- No sleeping and no network. Use the fakes the codebase already provides.\n"
        "- Reply with only the contents of the test file.\n\n"
        f"## The brief\n\n{briefs}\n\n"
        f"## The code\n\n{_files_block(files)}\n\n"
        # Repeated last on purpose: a local model whose context window is smaller than this prompt
        # (Ollama defaults to 2048-4096 tokens) keeps only the end, and without this it sees bare code.
        "## Your task\n\n"
        "Try to break the code above: write ONE test file of new tests that a correct solution to the "
        f"brief passes and this code might fail. It will be saved in `{task.attack_dir}/`. Don't explain "
        "or summarise the code. Reply with only the contents of the test file.\n"
    )


def _place(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(source, destination)


def _cases(task: Task, runner: Runner, app: Path, logs: Path, timeout: int | None) -> dict[str, str | None]:
    """Test case id -> None if it passed, else the first line of its failure."""
    limit = timeout or task.verifier_timeout
    done = runner.run(task, task.candidate_tests, Sandbox(app=app, logs=logs, temp=logs.parent / "temp"), limit)
    junit = logs / "junit.xml"
    if done.timed_out:
        raise RunnerError(f"Tests timed out after {limit}s")
    if not junit.is_file():
        raise RunnerError(f"The tests could not run:\n{_tail(done.output)}")
    cases: dict[str, str | None] = {}
    for case in ET.parse(junit).getroot().iter("testcase"):
        bad = next((c for c in case if c.tag in ("failure", "error", "skipped")), None)
        message = None
        if bad is not None:
            lines = (bad.get("message") or bad.tag).strip().splitlines()
            message = (lines[0] if lines else bad.tag)[:200]
        cases[f"{case.get('classname', '')}::{case.get('name', '?')}"] = message
    return cases
