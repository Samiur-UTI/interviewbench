# interviewbench

A framework for realistic AI-assisted coding interview tasks: small multi-file repos with three
stages, hidden tests, a weighted rubric, and a grader (`ib`) that scores a solution, optionally
with an AI judge. The same task folders are [Harbor](https://harborframework.com) tasks, so you can
also use them to evaluate AI coding agents.

Early release: 3 tasks (see [Status and limitations](#status-and-limitations)).

**Who it's for**

- **Engineers practising for AI-assisted interviews.** Work through a task with your own AI tools,
  then grade yourself.
- **Hiring teams.** Write your own private tasks in the same format and grade candidates with `ib`.
  Don't use the shipped tasks to vet real candidates: see [About the shipped tasks](#about-the-shipped-tasks).
- **People evaluating LLMs.** Run any task under Harbor with the agent and model of your choice.

## Prerequisites

- **Python 3.10+** and **git**.
- Somewhere to run the tests, one of:
  - **Docker** (the default when it's running). Each task's toolchain comes in its image, so you
    need nothing else.
  - **bash**, for the local runner (`--runner local`). On Windows, install
    [Git for Windows](https://gitforwindows.org/); `ib` finds its bash. With this runner the task's
    toolchain must be on your machine: the Python task uses the Python running `ib`, and the
    TypeScript tasks need **Node.js 24.11 or later** on your PATH.
- For Harbor only: Python 3.12+ and Docker.

## Install

With [uv](https://docs.astral.sh/uv/) or [pipx](https://pipx.pypa.io/), so `ib` works in every
terminal, including your editor's:

```bash
git clone https://github.com/Samiur-UTI/interviewbench.git && cd interviewbench
uv tool install --editable .          # or: pipx install --editable .
```

With plain pip, in a virtual environment:

```bash
git clone https://github.com/Samiur-UTI/interviewbench.git && cd interviewbench
python -m venv .venv
.venv/bin/pip install -e .            # Windows: .venv\Scripts\pip install -e .
```

Then activate the environment (`source .venv/bin/activate`, or `.venv\Scripts\activate` on
Windows) or call `.venv/bin/ib` directly.

Only want to practise? You can skip the clone, since the package bundles the tasks:
`pip install git+https://github.com/Samiur-UTI/interviewbench.git`. Writing tasks (`ib new`) needs a
clone with an editable install.

## Practise a round

```bash
ib
```

That's it: `ib` on its own opens the GUI in your browser. Pick a task, read the brief, run the
tests, grade, and try to break your code. It listens on 127.0.0.1 only and needs no extra install
(`ib ui --port <n> --no-open` if you want control over that). See [docs/GUI.md](docs/GUI.md).

Prefer the terminal? Every step is also a command (`ib --help` lists them all):

```bash
ib list                               # or: ib list --category backend --tag python
ib start rate-limiter                 # your round starts here
```

Both front ends share the same rounds: one started in the GUI shows up for `ib` in its folder, and
one started with `ib start` (without `--dir`) appears in the GUI's *Rounds* screen.

| Task | Category | Language | Level | Time |
|---|---|---|---|---|
| `rate-limiter` | backend | Python | mid | 60 min |
| `flight-search-aggregator` | backend | TypeScript (Node.js) | senior | 180 min |
| `campaign-console` | frontend | TypeScript (Node.js, Preact) | senior | 240 min |

`ib start` sets the round up the way a real AI-enabled interview feels:

- Copies the starter code to `~/ib-workspaces/<task>` (or `$IB_WORKSPACES/<task>`, or `--dir`).
  It refuses folders inside this repo, because the repo holds the hidden tests and reference
  solutions, which an AI assistant working there could read. The folder must be new or empty;
  `--force` replaces only an earlier round's workspace, never any other folder.
- Opens that folder in your editor: `$IB_EDITOR` if set, else VS Code, Cursor or Windsurf
  (`--no-open` to skip). Point `IB_EDITOR` at any other editor.
- Writes the stage 1 brief, the time limit and the commands to `TASK.md`, and starts the clock.
- Makes the workspace a git repo with the starter as its first commit (`--no-git` to skip), so
  you can branch, diff and revert like in any project.
- Adds the commands as editor tasks (*Terminal > Run Task*: run my tests, next stage, grade,
  judge). They work even when `ib` isn't on the editor terminal's PATH.

Then, in the workspace:

```bash
ib test      # run your own tests (no hidden tests, no spoilers)
ib next      # commit and tag your work (stage-1, ...), then reveal the next stage in TASK.md
ib grade     # run the hidden tests, score the rubric, show time used; writes ib-report.md
ib grade --judge          # ...and have an AI model review what tests can't measure
ib break ../attack_test.py   # check tests an LLM wrote to break your code (see below)
```

`ib test`, `ib grade` and `ib break` take `--runner docker` or `--runner local`; the default uses
Docker when it's running, else bash on your machine.

## How a task works

Each task is a small multi-file codebase with three stages:

1. **Fix the bug**: diagnose a realistic defect.
2. **Add a feature**: extend the code cleanly.
3. **Optimize**: make it scale.

Hidden tests check each stage, and a weighted rubric scores the result. The rubric mixes `auto`
criteria (the fraction of a stage's hidden tests passed) with `judge` criteria such as root
cause, code quality and communication, which the AI judge scores.

Tasks are grouped by category (`tasks/backend/`, `tasks/frontend/`, `tasks/devops/`) and follow
the Harbor task format. Each task brings its own Dockerfile and test script, so any language or
stack works without changes to `ib`.

## About the shipped tasks

The hidden tests and reference solutions of every task are public in this repo, and will likely
end up in LLM training data. The shipped tasks are for practice and for evaluating models.

To interview real candidates, keep a private copy of the repo and write your own tasks with the
framework:

```bash
ib new my-task --category backend      # skeleton from templates/
ib validate my-task --run              # starter fails stage 1, each stage's solution passes
```

The full contract is in [docs/TASK_FORMAT.md](docs/TASK_FORMAT.md). Anyone with the repo (or the
installed package) can read every task's hidden tests, so keep private tasks off candidates'
machines: give them the starter code and grade what they hand back with
`ib grade --dir <their workspace> --task <task-id>`.

## AI judge

Some rubric criteria (correctness beyond the tests, missed edge cases, code quality, root cause,
fit with the task's business rules, communication) need a reviewer. `ib grade --judge` asks a
model to score them and lists any other issues it finds. Three ways to run it:

**Paste into any chatbot**, no API key needed:

```bash
ib grade --judge-export                    # writes a prompt file (~10-15k tokens) and prints its path
# paste it into a chat and save the reply to a file next to the prompt
ib grade --judge-reply reply.txt
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

**Local models need a bigger context window.** The judge prompt is ~10-15k tokens and an attack
prompt can pass 8k, but Ollama runs models with 2048-4096 tokens by default (it depends on the
version and your memory) and silently drops the *start* of a longer prompt, so the model never sees
the rules or the brief. Raise it to 32768:
start the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` (or use the context length
setting in the Ollama app), or type `/set parameter num_ctx 32768` in `ollama run` when pasting.
In LM Studio, set the context length when you load the model.

**Claude API** (the default backend; the API enforces the answer's JSON schema):

```bash
uv tool install --editable ".[judge]" --force   # or: pipx install --editable ".[judge]" --force
                                                # or, in a venv: pip install -e ".[judge]"
export ANTHROPIC_API_KEY=...                     # from platform.claude.com/settings/keys
ib grade --judge                                 # model: claude-opus-5-5, or --judge-model / IB_JUDGE_MODEL
```

Prefer a judge from a different model family than the one that helped you solve the task: LLM
judges tend to favour their own family's work. The judge prompt contains the hidden tests and
the reference solution, so don't share it. That's why `--judge-export` writes it outside the
workspace, to ib's data folder (`%LOCALAPPDATA%\interviewbench` on Windows,
`~/Library/Application Support/interviewbench` on macOS, `~/.local/state/interviewbench` on Linux,
or `$IB_DATA_DIR`).

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
works for any language. If a local model only describes your code instead of writing tests, its
context window is too small for the prompt: see the note on local models under [AI judge](#ai-judge).

## Evaluate AI agents with Harbor

There is no published leaderboard. Because every task folder is a Harbor multi-step task, you can
score agents and models yourself (Harbor needs Python 3.12+ and Docker):

```bash
pip install -e ".[harbor]"
harbor run -p tasks/backend -a oracle        # reference solutions: should score 1.0
harbor run -p tasks/backend -a claude-code   # an AI agent, one category at a time
```

`-p` is a category folder, `-a` picks the agent (`oracle` applies the reference solutions; others
include `claude-code`, `codex`, `gemini-cli`, `aider` and `openhands`), and `-m` picks the model.
A trial's score is the mean of the three stages' fraction of hidden tests passed. See
`harbor run --help`.

## Status and limitations

- **3 tasks**: one Python, two TypeScript. No `devops` tasks yet.
- **One template.** `ib new` only has `templates/backend-python`, although two of the three tasks
  are TypeScript. Other stacks need a template written by hand (see
  [docs/TASK_FORMAT.md](docs/TASK_FORMAT.md)).
- **No CI yet.** The package's tests run locally: `pytest` (add `IB_TEST_RUNNER=docker` to run
  the task checks in containers).
- **No proctoring.** `ib` shows the time limit and the time used but doesn't enforce it, and it
  doesn't watch or record the candidate.
- The hidden tests and reference solutions of the shipped tasks are public (see above).

## Contributing

Tasks must be original: never copy real company interview questions or NDA'd material. Start with
`ib new`, follow [docs/TASK_FORMAT.md](docs/TASK_FORMAT.md), and check your task with
`ib validate <task-id> --run` before opening a pull request. [AGENTS.md](AGENTS.md) has the repo
layout and rules.

## License

MIT. See [LICENSE](LICENSE).
