# interviewbench — instructions for AI coding agents

Shared by every agent working in this repo (Qoder, Claude Code, others). Keep it short and current.

## What this is
Open-source kit of realistic "AI-enabled" coding interview tasks. Each task is a small multi-file repo with
three stages (fix a bug → add a feature → optimize), hidden tests per stage, and a weighted rubric.
The CLI grades a candidate's (or an LLM's) solution against the rubric.

## Layout
- `src/interviewbench/` — CLI (`cli.py`), task/rubric loading (`tasks.py`), grading (`grader.py`), reports (`report.py`)
- `tasks/<task-id>/` — `task.yaml`, `rubric.yaml`, `repo/` (starter code), `tests/stageN/` (hidden tests), `solution/`
- `tests/` — tests for the interviewbench package itself

## Commands
- Install: `python -m venv .venv && .venv/Scripts/pip install -e .` (Windows) or `.venv/bin/pip install -e .`
- Package tests: `.venv/Scripts/python -m pytest`
- Try a task: `ib list`, `ib start rate-limiter`, `ib grade --dir ib-workspace/rate-limiter`

## Rules
- Tasks must be original. Never copy real company interview questions or NDA'd material.
- Every task: starter `repo/` must FAIL stage1 hidden tests; `solution/` must PASS all stages. `tests/test_tasks.py` enforces this.
- Hidden tests import from the repo root (PYTHONPATH is set to the workspace copy).
- Keep dependencies minimal; no web UI in v1.
- Coordinate via git: one agent per branch/file area at a time; commit small.
