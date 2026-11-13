# Contributing

Thanks for helping. This file says how.

## Ways to help

New tasks are the most useful contribution. Bug reports and fixes to the CLI and the GUI are also
welcome.

## Setup

1. Clone the repo.
2. Create a virtual environment: `python -m venv .venv`.
3. Install with the dev extra: `.venv/bin/pip install -e ".[dev]"` (Windows: `.venv\Scripts\pip install -e ".[dev]"`).

The `harbor` extra only installs on Python 3.12 or later. On 3.10 and 3.11 the Harbor checks are
skipped.

The tests need bash (on Windows, Git for Windows provides it). The two TypeScript tasks also need
Node.js 24.11 or later on your PATH.

## Running the tests

- `python -m pytest` takes about 5 minutes. It runs every task's starter and reference solutions
  with the local runner.
- `IB_TEST_RUNNER=docker python -m pytest` runs the same checks in containers. Docker must be running.
- `ib validate --run` checks the tasks only.
- `ruff check src tests` runs the linter. The rules are in `pyproject.toml`.

## Writing a task

`docs/TASK_FORMAT.md` is the contract. `ib new <id> --category <category>` creates a skeleton from
`templates/`. There is only a Python template for now. It needs an editable install of a clone.

Every task must meet this rule: the starter fails stage 1's hidden tests, and after the solutions of
stages 1..N, stage N's hidden tests pass.

Scripts use `$APP_DIR`, `$TESTS_DIR`, `$SOLUTION_DIR` and `$LOGS_DIR`, never fixed paths, and keep
LF line endings. Tests must not use the network.

## Fair hidden tests

- Every rule a hidden test enforces must be stated in the brief for that stage, or in the starter's docs.
- State what must hold, not how to do it.
- Nothing visible at stage 1 may say what later stages ask for.
- Before you submit, have someone (or an AI agent) attempt the task blind. They start with `ib start`
  and see only the briefs. Fix any failure caused by a rule that was not stated.

## Originality

Tasks must be original. Do not submit real interview questions from any company, anything under
NDA, or code copied from a product. Use fictional companies and services, and reserved domains such
as `.example`. Credentials in fixtures must be obviously fake: they must contain the word `fake`.

## Code changes

- Keep logic shared by the CLI and the GUI in `src/interviewbench/rounds.py`.
- Put no language-specific logic in the grader. It belongs in the task's `test.sh` and Dockerfile.
- The GUI server uses only the standard library, and the browser side has no build step. See `docs/GUI.md`.
- Keep dependencies minimal.
- Add a test that fails without your change.

## Commits and pull requests

Make small commits with a conventional prefix (`feat`, `fix`, `docs`, `test`, `refactor`, `perf`,
`chore`, `build`, `ci`, `revert`) and an optional scope, for example `fix(grade): ...`. Keep one
topic per pull request. Say what you ran.

Nobody pushes to `main`. Open a pull request from a branch or a fork. It can merge when:

| Check | What it needs from you |
|---|---|
| Tests | `python -m pytest` passes on Linux and Windows, on Python 3.10 and 3.12. |
| Tasks in containers | Every task's starter fails stage 1 and every reference solution passes in Docker. |
| Lint | `ruff check src tests` reports nothing. |
| Commit messages | Every commit subject looks like `type(scope): subject`. |
| Tests with code changes | A change under `src/` comes with a change under `tests/`. If no test makes sense, say why and a maintainer can waive the check. |
| Review | A maintainer approves, and every review comment is resolved. |

A push to your branch re-runs the checks, and a new push after an approval needs a new approval.
How the rules are set up is in [docs/MAINTAINING.md](docs/MAINTAINING.md).

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).
