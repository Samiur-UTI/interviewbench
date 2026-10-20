# interviewbench

Realistic AI-era coding interview tasks with rubrics, a grader that scores your solution,
and a leaderboard of how LLMs do on the same tasks.

> Work in progress — v0.1 launching soon.

## Quickstart

Install `ib` as a tool, so it works in every terminal, including your editor's:

```bash
git clone <repo-url> && cd interviewbench
uv tool install --editable .          # or: pipx install --editable .

ib list                               # or: ib list --category backend --tag python
ib start rate-limiter                 # your round starts here
```

`ib start` sets the round up the way a real AI-enabled interview feels:

- Copies the starter code to `~/ib-workspaces/rate-limiter` (or `$IB_WORKSPACES/<task>`, or
  `--dir`). It refuses folders inside this repo, because the repo holds the hidden tests and
  reference solutions, which an AI assistant working there could read.
- Opens that folder in your editor: `$IB_EDITOR` if set, else VS Code, Cursor or Windsurf
  (`--no-open` to skip).
- Writes the stage 1 brief, the time limit and the commands to `TASK.md` in the workspace,
  and starts the clock.

Then, in the workspace:

```bash
ib next      # reveal the next stage (added to TASK.md)
ib grade     # run the hidden tests, score the rubric, show time used
```

## How a task works

Each task mirrors the new AI-enabled interview format: a small multi-file codebase and three stages.

1. **Fix the bug** — diagnose a realistic defect.
2. **Add a feature** — extend the code cleanly.
3. **Optimize** — make it scale.

Hidden tests check each stage; a weighted rubric scores the result.

Tasks are grouped by category (`tasks/backend/`, `tasks/frontend/`, `tasks/devops/`) and
follow the [Harbor](https://harborframework.com) task format, so any language or stack works.
Hidden tests run inside the task's own Docker container when Docker is running
(`--runner docker`), or directly on your machine with bash (`--runner local`, needs the task's
toolchain installed).

## LLM leaderboard

The same task folders run with [Harbor](https://harborframework.com):

```bash
pip install -e ".[harbor]"
harbor run -p tasks/backend -a oracle        # reference solutions: should score 1.0
harbor run -p tasks/backend -a claude-code   # an AI agent, one category at a time
```

## Contributing a task

```bash
ib new my-task --category backend      # skeleton from templates/
ib validate my-task --run              # starter fails stage 1, each stage's solution passes
```

The full contract is in [docs/TASK_FORMAT.md](docs/TASK_FORMAT.md).

## AI judge

Some rubric criteria (correctness beyond the tests, missed edge cases, code quality, root cause,
communication) need a reviewer. `ib grade --judge` asks Claude to score them and lists any other
issues it finds:

```bash
uv tool install --editable ".[judge]" --force   # or: pipx install --editable ".[judge]" --force
export ANTHROPIC_API_KEY=...        # or: ant auth login
ib grade --judge                    # inside the workspace
```

The model defaults to `claude-opus-5-5`; override it with `--judge-model` or `IB_JUDGE_MODEL`.

## License

MIT
