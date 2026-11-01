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
  (`--no-open` to skip). Point `IB_EDITOR` at any other editor, e.g. Qoder.
- Writes the stage 1 brief, the time limit and the commands to `TASK.md`, and starts the clock.
- Makes the workspace a git repo with the starter as its first commit (`--no-git` to skip), so
  you can branch, diff and revert like in any project.
- Adds the commands as editor tasks (*Terminal > Run Task*: run my tests, next stage, grade,
  judge). They work even when `ib` isn't on the editor terminal's PATH.

Then, in the workspace:

```bash
ib test      # run your own tests (no hidden tests, no spoilers)
ib next      # commit and tag your work (stage-1, ...), then reveal the next stage in TASK.md
ib grade     # run the hidden tests, score the rubric, show time used
ib grade --judge          # ...and have an AI model review what tests can't measure
ib break attack_test.py   # check tests an LLM wrote to break your code (see below)
```

Prefer a browser? `ib ui` does all of this in a local web app: pick a task, read the brief, run the
tests, grade, and try to break your code. It runs on your computer only, and needs no extra install.

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
fit with the task's business rules, communication) need a reviewer. `ib grade --judge` asks Claude to score them and lists any other
issues it finds:

```bash
ib grade --judge-export                    # writes ib-judge-prompt.md (~10-15k tokens)
# paste it into a chat, save the reply as ib-judge-reply.txt in the workspace
ib grade --judge-reply ib-judge-reply.txt
```

**Any OpenAI-compatible API**: OpenRouter, Google AI Studio (Gemini), Groq, Mistral, or a local
model with Ollama, LM Studio or vLLM. No extra packages needed.

```bash
export IB_JUDGE_BASE_URL=https://openrouter.ai/api/v1          # or http://localhost:11434/v1 for Ollama
export IB_JUDGE_API_KEY=...                                    # not needed for local models
ib grade --judge --judge-backend openai --judge-model <model id>
```

Set `IB_JUDGE_BACKEND=openai` and `IB_JUDGE_MODEL` to make that the default for `ib grade --judge`.
Other OpenAI-compatible base URLs: `https://generativelanguage.googleapis.com/v1beta/openai`
(Gemini), `https://api.groq.com/openai/v1` (Groq).

**Claude API** (the default backend; the API enforces the answer's JSON schema):

```bash
uv tool install --editable ".[judge]" --force   # or: pipx install --editable ".[judge]" --force
export ANTHROPIC_API_KEY=...                     # from platform.claude.com/settings/keys
ib grade --judge                                 # model: claude-opus-5-5, or --judge-model / IB_JUDGE_MODEL
```

Prefer a judge from a different model family than the one that helped you solve the task: LLM
judges tend to favour their own family's work. The exported prompt contains the hidden tests and
the reference solution, so don't share it.

## Try to break your code

`ib break` checks attack tests written by any LLM. Each test runs on your code and on the task's
reference solution, and only counts when the reference passes it, so a model that misreads the
brief can't invent bugs:

```bash
ib break --prompt              # writes ib-attack-prompt.md: give it to any chatbot or coding agent
# save the test file it writes OUTSIDE the workspace, e.g. ../attack_test.py
ib break ../attack_test.py     # real break / survived / bad test, for each attack test
```

Your workspace isn't changed. The attack file runs with the task's own test command, so this
works for any language.

## License

MIT
