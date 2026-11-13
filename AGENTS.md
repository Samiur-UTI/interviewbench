# interviewbench — instructions for AI coding agents

Shared by every agent working in this repo (Qoder, Claude Code, others). Keep it short and current.

## What this is
Open-source kit of realistic tasks for AI-assisted coding interviews. Each task is a small multi-file repo with
three stages (fix a bug → add a feature → optimize), hidden tests per stage, and a weighted rubric.
The CLI grades a candidate's (or an LLM's) solution against the rubric.

## Layout
- `src/interviewbench/` — CLI (`cli.py`), task/rubric loading + validation (`tasks.py`), candidate workspaces: TASK.md, git, editor tasks (`workspace.py`), running task scripts in Docker or local bash (`runner.py`), grading (`grader.py`), AI judge with claude/openai-compatible/pasted backends (`judge.py`), `ib break` (`breaker.py`), reports (`report.py`)
- `src/interviewbench/rounds.py` holds the workflows shared by the CLI and `ui/` (the local GUI); keep logic there, not in either front end
- `tasks/<category>/<task-id>/` — a Harbor multi-step task: `task.toml`, `environment/` (Dockerfile + `app/` starter), `tests/test.sh` (shared verifier), `steps/stage-N/` (instruction.md, hidden tests, solution/solve.sh), plus ib-only `rubric.yaml`
- `rubrics/` — `base.yaml` + one file per category (a category exists iff its rubric file does)
- `templates/` — task skeletons for `ib new`
- `docs/TASK_FORMAT.md` — the task contract; keep it in sync with `tasks.py` validation
- `tests/` — tests for the interviewbench package itself
- CONTRIBUTING.md, SECURITY.md, CHANGELOG.md — contributor guide, threat model and how to report problems, release notes

## Commands
- Install: `python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"` (Windows) or `.venv/bin/pip install -e ".[dev]"`
- The harbor extra only installs on Python 3.12+; on older versions the Harbor checks are skipped
- Package tests: `.venv/Scripts/python -m pytest`
- Package tests in containers: `IB_TEST_RUNNER=docker .venv/Scripts/python -m pytest`
- Try a task: `ib start rate-limiter` (workspace goes to ~/ib-workspaces/, never inside the repo), then `ib test` / `ib next` / `ib grade [--judge]` / `ib break` in that folder
- The same in a browser: `ib ui`
- Check tasks: `ib validate --run`; Harbor's own check: `harbor run -p tasks/backend -a oracle`

## Rules
- Tasks must be original. Never copy real company interview questions or NDA'd material.
- Every task: starter `environment/app/` must FAIL stage 1 hidden tests; after solutions 1..N, stage N must PASS. `tests/test_tasks.py` enforces this.
- Follow `docs/TASK_FORMAT.md`. Scripts use `$APP_DIR`/`$TESTS_DIR`/`$SOLUTION_DIR`/`$LOGS_DIR`, never hard-coded paths, and keep LF line endings.
- Never add language-specific logic to the grader; it belongs in the task's `test.sh` and Dockerfile.
- Keep dependencies minimal. The local GUI (`ib ui`, see `docs/GUI.md`) uses the standard library on the server, and Preact and htm vendored in `ui/static/vendor/` in the browser: no npm, no build step, and no new vendored library without a reason.
- Coordinate via git: one agent per branch/file area at a time; commit small.
