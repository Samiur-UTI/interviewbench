# Task format

Every interviewbench task is a [Harbor](https://harborframework.com/docs/tasks/multi-step)
multi-step task with a few interviewbench-only files. The same folder works with:

- `ib` (candidates grading themselves, and the AI judge)
- `harbor run -p tasks/<category> -a <agent>` (the LLM leaderboard)
- `harbor run -p tasks/<category> -a oracle` (the reference solutions should score 1.0)

`ib validate` checks every rule below. `ib validate --run` also runs the tests. The package's
own test suite (`pytest`) runs both for every task.

## Layout

```
tasks/<category>/<task-id>/
├── task.toml                     # Harbor config + [metadata.interviewbench]
├── rubric.yaml                   # ib only: auto criteria + overrides of the shared rubrics
├── environment/
│   ├── Dockerfile                # toolchain + `COPY app/ /app/`
│   └── app/                      # starter code, what `ib start` copies (becomes /app)
├── tests/                        # shared by every stage, copied to /tests first
│   ├── test.sh                   # the verifier
│   └── ...                       # e.g. pytest.ini, helpers
└── steps/
    ├── stage-1/
    │   ├── instruction.md        # the brief, starting with "# Title"
    │   ├── tests/                # hidden tests, copied over /tests for this stage
    │   └── solution/
    │       ├── solve.sh          # reference solution for this stage only
    │       └── files/            # files solve.sh copies over /app
    ├── stage-2/ ...
    └── stage-3/ ...
```

Shared files live outside the task folder:

```
rubrics/base.yaml                 # criteria every task inherits
rubrics/<category>.yaml           # one per category; its existence defines the category
templates/<category>-<stack>/     # skeletons used by `ib new`
```

## Categories

A category is a folder under `tasks/` plus a rubric file `rubrics/<category>.yaml`. To add one,
create both. Today: `backend`, `frontend`, `devops`.

- `metadata.category` in `task.toml` must equal the folder name.
- Task ids (folder names) must be unique across all categories. Pick the category once; moving
  a task later changes its path and breaks links and leaderboard history. Use `tags` for
  everything else (`ib list --tag nestjs`).
- Harbor looks exactly one folder down, so `harbor run -p tasks/backend` runs one category.

## task.toml

Standard Harbor fields, plus `ib` settings under `[metadata.interviewbench]`.
See `tasks/backend/rate-limiter/task.toml` for a full example.

| Field | Rule |
|---|---|
| `[task].name` | `interviewbench/<task-id>`, where `<task-id>` is the folder name (lowercase, digits, hyphens) |
| `[task].description` | One-line title, shown by `ib list` |
| `[metadata].category` | The folder's category |
| `[metadata].tags` | Stack and topics, e.g. `["typescript", "nestjs", "postgres"]` |
| `[metadata].difficulty` | `easy`, `medium` or `hard` |
| `[metadata.interviewbench].level` | `junior`, `mid` or `senior` |
| `[metadata.interviewbench].language` | Main language |
| `[metadata.interviewbench].time_limit_minutes` | Time limit for candidates |
| `[metadata.interviewbench].candidate_tests` | Optional. Shell command run in `$APP_DIR` that runs the candidate's own tests and writes `$LOGS_DIR/junit.xml` (used by `ib test`, `ib break` and the AI judge) |
| `[metadata.interviewbench].attack_dir` | Optional, default `tests`. Folder (relative to `$APP_DIR`) where `ib break` puts an attack test file so `candidate_tests` collects it |
| `[[steps]]` | One per stage, named `stage-1`, `stage-2`, ... in order |
| `[verifier].timeout_sec` | Per-stage test timeout, used by both Harbor and `ib` |
| `[environment].cpus` / `memory_mb` | Container limits, used by both Harbor and `ib --runner docker` |

Keep `multi_step_reward_strategy = "mean"` so Harbor's score is the average across stages.

## Scripts

Scripts never hard-code paths. They use these variables, whose defaults are Harbor's paths:

| Variable | Default | Contents |
|---|---|---|
| `APP_DIR` | `/app` | The code being graded |
| `TESTS_DIR` | `/tests` | `tests/` with `steps/<stage>/tests/` copied on top |
| `SOLUTION_DIR` | `/solution` | `steps/<stage>/solution/` |
| `LOGS_DIR` | `/logs/verifier` | Where the verifier writes its results |

Harbor runs them in the task container. `ib` runs them in the same container
(`--runner docker`) or with bash on the host (`--runner local`, which also sets `PYTHON` to
the interpreter running `ib`).

### test.sh (the verifier)

- Lives in `tests/` (shared by every stage). A stage can override it with
  `steps/<stage>/tests/test.sh`.
- Must always overwrite `$LOGS_DIR/reward.txt` with a number from 0 to 1. Use the fraction of
  hidden tests passed, so partial work gets partial credit. Never trust a reward file the agent
  may have left behind.
- Must write JUnit XML to `$LOGS_DIR/junit.xml`. `ib` reads it to report each failing test.
  Every common test runner can produce it (pytest `--junitxml`, Jest/Vitest `jest-junit`,
  Go `gotestsum`, JUnit).
- Must not let the candidate's code change how the hidden tests run. For Python, run from
  `$TESTS_DIR` with its own `pytest.ini` and `--noconftest`.
- Must not need network access. Install everything in the Dockerfile.

### solve.sh (the reference solution)

- One per stage. It solves that stage only, starting from the previous stage's solution:
  Harbor's oracle runs `stage-1`, then `stage-2`, then `stage-3` in the same container.
- The default copies `files/` over `$APP_DIR`. Write a custom script when a stage must delete
  or move files.

## Instructions

- `steps/stage-N/instruction.md` is exactly what the candidate or agent sees. Its first line is
  `# Title`.
- Stage 1 sets the scene (what the code is, who uses it), since Harbor agents see nothing else.
  State the business rules a solution must respect here or in the stage that needs them; the
  business-alignment criterion can only grade rules the candidate was shown.
- Use paths relative to the app root (`ratelimiter/bucket.py`), not `/app/...`.
- Describe symptoms, not causes. Give exact contracts for features (signatures, errors).
- Ask for notes in `NOTES.md` in every stage. The communication criterion grades them.

## Rubric

Each task's rubric is three layers merged by criterion id:

1. `rubrics/base.yaml`: correctness, root cause, code quality, verification, business alignment,
   communication
2. `rubrics/<category>.yaml`: category criteria (e.g. backend: API compatibility, error handling)
3. the task's `rubric.yaml`

In a later layer, an entry with an existing id replaces only the fields it sets (e.g. `weight`,
or task-specific `levels`). `exclude: [id, ...]` drops inherited criteria that don't apply.
Each layer's `focus` text goes into the AI judge's prompt.

Rules:

- Each stage has at least one `auto` criterion (`type: auto`, `stage: N`), scored by the fraction
  of its hidden tests passed.
- `judge` criteria have levels numbered `0, 1, 2, ...`.
- Weights are positive and total exactly 100.
- A task that keeps `business-alignment` needs a `business` section in its `rubric.yaml`: who
  uses the code, the business rules, and which rule wins when they conflict. It goes into the
  AI judge's prompt only. Every rule must be stated or clearly implied by the brief or starter
  repo, since candidates can't be held to rules they can't see. Tasks with no real business
  context can `exclude: [business-alignment]` instead.

## Tests that must hold

- The starter code fails stage 1.
- After applying the solutions of stages 1..N, all of stage N's hidden tests pass.
- `harbor run -p tasks/<category> -a oracle` scores 1.0.
- Shell scripts, Dockerfiles and `task.toml` use LF line endings (`.gitattributes` enforces it).
- `environment/app/` doesn't contain the files `ib` writes into a workspace: `TASK.md`,
  `.interviewbench.json`, `ib-report.md`, `ib-judge-prompt.md`, `ib-judge-reply.txt` and
  `ib-attack-prompt.md`. The grader and judge ignore them, and `.vscode/`.

## Adding a task

```bash
ib new order-api --category backend          # copies templates/backend-python
# fill in every TODO: starter code, instructions, hidden tests, solutions, rubric
ib validate order-api --run                  # local check
ib validate order-api --run --runner docker  # the same check in the task container
harbor run -p tasks/backend -a oracle        # optional: Harbor's own check
```

A new stack (e.g. TypeScript) needs a new template in `templates/` with a Dockerfile, a
`test.sh` that produces JUnit XML, and a `candidate_tests` command. Nothing in `ib` changes.
