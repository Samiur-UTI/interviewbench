# The AI judge

Hidden tests can't measure everything. Some rubric criteria, such as root cause, code quality,
missed edge cases, fit with the task's business rules, and the notes in `NOTES.md`, need a
reviewer. The AI judge is a language model that scores those `judge` criteria and lists any other
issues it finds. In `rate-limiter`, they are worth 55 of the 100 rubric points.

This page has the details. The [README](../README.md#the-ai-judge) has the short version.

## When it runs

The judge is shown every stage's brief, the hidden tests and the reference solution, so its review
could spoil a stage you haven't reached. In a round it therefore runs only once every stage is
revealed. Before that, ib refuses:

```text
Error: The AI judge reviews the whole round, so it runs once every stage is revealed (you are on
stage 2 of 3). Reveal the remaining stages first (`ib next`), or grade without the judge.
```

This applies to `--judge`, `--judge-export`, `--judge-reply` and the judge in the GUI's *Grade*
panel. Two cases aren't limited: a hand-back folder without a round marker (`.interviewbench.json`),
and `ib grade --all-stages`.

Before it asks the model, ib runs your own tests and builds the reference solution, both with the
same runner as the hidden tests.

## Three ways to run it

| Backend | What you need | Command |
|---|---|---|
| Paste into a chatbot | Nothing installed; a chatbot with a large enough context window | `ib grade --judge-export`, then `ib grade --judge-reply <file>` |
| Any OpenAI-compatible API | A base URL, a model id, and usually an API key | `ib grade --judge --judge-backend openai --judge-model <id>` |
| Claude API (the default) | The `[judge]` extra and `ANTHROPIC_API_KEY` | `ib grade --judge` |

In the GUI, the *Grade* panel offers the same choices, and the *Settings* screen picks the model,
with presets for Claude, OpenRouter, Gemini, Groq and Ollama. An API key typed there stays in the
server's memory: it isn't written to disk or put in the environment.

### Paste into a chatbot

```bash
ib grade --judge-export
```

ib writes the prompt to its data folder, outside the workspace, and prints what to do next:

```text
Judge prompt written to ...\interviewbench\judge\rate-limiter-73307ab2a7\ib-judge-prompt.md (~10,948
tokens), outside the workspace: it contains the hidden tests and the reference solution, so don't share
it or copy it into the workspace. Paste all of it into any chatbot (ChatGPT, Gemini, Claude.ai,
DeepSeek...), save its reply as ...\rate-limiter-73307ab2a7\ib-judge-reply.txt, then run
ib grade --judge-reply "...\rate-limiter-73307ab2a7\ib-judge-reply.txt".
```

Paste the whole file into a chat, save the answer at the path ib printed, and run the
`ib grade --judge-reply "<full path>"` command it printed. The reply may wrap the JSON in prose or a
code block; ib finds it.

### Any OpenAI-compatible API

OpenRouter, Google AI Studio (Gemini), Groq, Mistral, or a model on your computer with Ollama,
LM Studio or vLLM. No extra packages are needed.

```bash
export IB_JUDGE_BASE_URL=https://openrouter.ai/api/v1
export IB_JUDGE_API_KEY=...
ib grade --judge --judge-backend openai --judge-model <model id>
```

Other base URLs: `https://generativelanguage.googleapis.com/v1beta/openai` (Gemini),
`https://api.groq.com/openai/v1` (Groq), `http://localhost:11434/v1` (Ollama, no key needed).
`OPENAI_API_KEY` works in place of `IB_JUDGE_API_KEY`. Set `IB_JUDGE_BACKEND=openai` and
`IB_JUDGE_MODEL` to make this the default for `ib grade --judge`. Not every provider enforces a JSON
schema, so ib puts the schema in the prompt and reads the reply leniently. A request times out after
10 minutes.

### Claude API

```bash
uv tool install --force "interviewbench[judge] @ git+https://github.com/Samiur-UTI/interviewbench.git"
export ANTHROPIC_API_KEY=...
ib grade --judge
```

From a clone, install the extra with `uv tool install --editable ".[judge]" --force`, or
`pip install -e ".[judge]"` in a virtual environment. The default model is `claude-opus-5-5`;
change it with `--judge-model` or `IB_JUDGE_MODEL`. The API enforces the answer's JSON schema, and
the task part of the prompt is cached, so grading the same task again costs less.

## Prompt size and cost

The prompt holds the task's briefs, hidden tests, reference solution and your changed files. Measured
after a full round with the reference solutions:

| Task | Judge prompt |
|---|---|
| `rate-limiter` | about 11,000 tokens |
| `flight-search-aggregator` | about 120,000 tokens |
| `campaign-console` | about 250,000 tokens |

- Pasting into a chatbot is practical for `rate-limiter`. For the other two, use a model with a very
  large context window, or an API.
- With an API, every judge run sends the whole prompt. Check your provider's prices before you
  grade the large tasks repeatedly.
- `ib grade --judge-export` prints the size of the prompt it wrote.

## Models on your computer

Ollama runs models with a small context window by default (2048 to 4096 tokens, depending on the
version and your memory) and silently drops the start of a longer prompt, so the model never sees
the rules or the brief. Raise it: start the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`
(or use the context length setting in the Ollama app), or type `/set parameter num_ctx 32768` in
`ollama run` before you paste. In LM Studio, set the context length when you load the model. 32768
tokens is enough for `rate-limiter` only. The same applies to the attack prompt of `ib break`: if a
local model only describes your code instead of writing tests, its context window is too small.

## Good practice

- Prefer a judge from a different model family than the one that helped you solve the task: LLM
  judges tend to favour their own family's work.
- Don't share the exported prompt or copy it into the workspace. It contains the hidden tests and
  the reference solution.
- Treat the judge's scores as a second opinion. Read its rationale for each criterion in
  `ib-report.md`.

## Where the files go

ib keeps the exported prompt, the reply, the full grade report and the GUI's stored results in a
per-workspace folder under its data folder, never in the workspace:

| System | Data folder |
|---|---|
| Windows | `%LOCALAPPDATA%\interviewbench` |
| macOS | `~/Library/Application Support/interviewbench` |
| Linux and others | `$XDG_STATE_HOME/interviewbench`, by default `~/.local/state/interviewbench` |

Set `IB_DATA_DIR` to use another folder. Code run by the local runner runs as you and can read this
folder too; see [SECURITY.md](../SECURITY.md).
