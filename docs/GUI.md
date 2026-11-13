# The local GUI: architecture and API

This document describes how the GUI is built and its HTTP API. It is for people changing the GUI.
To use it, run `ib` or `ib ui` (see the README). Everything a candidate does with `ib` in a
terminal, they can do there. The GUI is a second front end over the same code as the CLI: neither
contains workflow logic of its own.

## Design rules

- **No toolchain.** `http.server.ThreadingHTTPServer` on the Python side; ES modules, Preact and htm
  in the browser. Preact and htm are vendored and pinned in `ui/static/vendor/`. No npm, no bundler,
  no build step, no CDN, no web fonts: it must work offline and from an installed wheel.
- **One service layer.** `src/interviewbench/rounds.py` owns the workflows (start a round, next stage,
  grade, judge, break, validate, new). `cli.py` and `ui/` only translate input and output.
- **The GUI never spoils a stage.** Only revealed stages are sent to the browser. Grading runs every
  stage's hidden tests, but failures for unrevealed stages are withheld and shown as a count. The
  same rules (`report.py`) apply to `ib-report.md`, which the candidate's AI assistant can read.
  The AI judge is shown every stage's brief, hidden tests and reference solution, and its review can
  describe any of them, so in a round it runs only once every stage is revealed (`all_revealed`).
- **Secrets stay out of the workspace and the environment.** API keys typed into the GUI live in the
  server's memory, are passed to the judge as arguments, and are never written to disk, logged,
  returned by the API, or placed in `os.environ` (`LocalRunner` hands its environment to candidate
  code). The judge prompt holds the hidden tests and reference solution, so the GUI keeps it in memory
  and never writes `ib-judge-prompt.md`.
- **Long work runs as jobs.** Anything that can run tests returns `202` and a job. The browser polls
  and can reload at any time without losing the job.

## Files

```
src/interviewbench/
  rounds.py            workflows shared by the CLI and the GUI
  ui/__init__.py
  ui/server.py         HTTP server: routing, auth, static files, `serve()`
  ui/jobs.py           background jobs
  ui/serialize.py      dataclasses -> the JSON shapes below, including spoiler rules
  ui/static/
    index.html  styles.css
    vendor/            Preact and htm, pinned by manifest.json. See its README to update them.
    js/main.js         entry point
    js/preact.js       the only import of vendor/: html, render and the hooks
    js/core/           no framework, so node can test it: API client, routes, formatting, diff, Markdown
    js/hooks/          reusable hooks: useAsync to load data, useAction for short calls, useNow, useApp
    js/components/     shared UI: Button, Dialog, Notice, Async, MarkdownView
    js/app/            the frame: routing, status, theme, top and status bars
    js/views/<screen>/ one folder per screen; a screen's parts stay in its folder
```

Dependencies point one way, and `tests/test_gui_static.py` checks it: `app` uses `views`, which use
`components`, which use `hooks`, which use `core`. A screen imports only from its own folder. Logic
worth testing goes in a pure module, as `views/round/round-state.js` does, with a test in
`tests/gui_js/`.
To add a screen, add it to `core/routes.js` and `app/views.js`. To add a Round panel, add it to
`PANELS` in `views/round/round-view.js`.

## Security

The server can run code, so a web page the candidate visits must not be able to drive it.

- Bind to `127.0.0.1` only. There is no option to bind elsewhere.
- `ib ui` makes a random token per run and opens `http://127.0.0.1:<port>/?token=<token>`. That
  request sets an `HttpOnly`, `SameSite=Strict` cookie named `ib_session_<port>` and redirects to `/`,
  so the token leaves the address bar. The terminal prints the same link.
- Every `/api/*` request needs the cookie; otherwise `401`. The static shell needs no auth and shows
  "open the link `ib ui` printed" on a 401.
- Every request's `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); otherwise
  `403`.
- Mutating requests must have `Content-Type: application/json` and, if an `Origin` header is present,
  an origin of this server; otherwise `403`. Bodies are capped at 2 MB (`413`).
- Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and
  `Content-Security-Policy: default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'`.
  No inline scripts or inline styles.
- Static paths resolve inside `ui/static/` or return `404`. Round ids match `^[A-Za-z0-9._-]+$`,
  aren't `.` or `..`, and must resolve to a direct child of the workspaces folder.
- Candidate output, model output and pasted replies are data. The front end renders them as text
  through htm templates, or through `markdown.js`, which escapes first. Never `innerHTML` with
  unescaped data, and never `dangerouslySetInnerHTML`.

## Rounds

A round is a folder under the workspaces folder (`$IB_WORKSPACES`, else `~/ib-workspaces`) holding
`.interviewbench.json`, so rounds started with `ib start` show up too. The round id is the folder
name. Starting a task that already has a folder creates `<task>-2`, `<task>-3`, ... so the GUI never
overwrites work. Only an explicit delete removes a round, along with its private folder.

`ib-ui.json` stores the latest `test`, `grade` and `break` results as the JSON below, so they survive
a restart. A stored grade keeps every stage's failures, plus the workspace fingerprint; the spoiler
rules are applied each time it is sent, so failures appear once their stage is revealed. Because it
holds unrevealed stages' failures, it lives in ib's private folder for the workspace
(`workspace.private_dir`, under `$IB_DATA_DIR` or the app data folder), never in the workspace; a copy
an earlier version left there is deleted on the next write. The full `ib-report-full.md` goes there
too when the workspace report hides a stage.

## API

JSON in and out. Errors are `{"error": {"code": "<code>", "message": "<for the candidate>"}}` with
status 400 (`bad_request`), 401 (`unauthorized`), 403 (`forbidden`), 404 (`not_found`), 409 (`busy`,
`all_revealed`, `no_editor`), 413 (`too_large`) or 500 (`internal`). A round with a running job
answers `409 busy` to anything that changes it.

### App

| Method and path | Result |
|---|---|
| `GET /api/status` | `{version, now, workspaces_dir, editor, runner: {docker, bash, default}, settings}`. Must answer fast: Docker's state is cached for 30 s and refreshed off the request thread. |
| `GET /api/settings` | `Settings` |
| `PUT /api/settings` | Body `{judge: {backend, model, base_url, api_key?}}`. Omitting `api_key` keeps it; `""` clears it. Returns `Settings`. |

`Settings` is `{judge: {backend: "claude"|"openai", model, base_url, has_api_key, key_source:
"session"|"env"|null, default_model, claude_sdk_installed}}`. Defaults come from the `IB_JUDGE_*`
environment variables; `model` and `base_url` are `""` when unset. The key itself is never returned.

`runner.docker` and `runner.bash` are booleans. `runner.default` is `"docker"`, `"local"`, or `null`
when neither can run tests.

### Tasks

| Method and path | Result |
|---|---|
| `GET /api/tasks` | `{tasks: [Task], categories: [str], templates: [str]}` |
| `POST /api/tasks` | Body `{task_id, category, template?}`: `ib new`. Returns `{path, message}`. |
| `POST /api/validate` | Body `{task_ids?, run, runner?}`: `ib validate`. Job; result `{tasks: [{id, category, ok, errors}]}`. |

`Task` is `{id, title, category, tags, level, difficulty, language, time_limit_minutes, stage_count,
rubric: [{id, type, weight, description}]}`. It never includes stage prompts or titles. An `auto`
criterion's description says what its stage is about, so for an unrevealed stage it reads "Hidden
tests for stage N." That is every stage in `GET /api/tasks`, where nothing is revealed yet.

### Rounds

| Method and path | Result |
|---|---|
| `GET /api/rounds` | `{rounds: [RoundSummary]}`, newest first |
| `POST /api/rounds` | Body `{task_id, git?: true, open_editor?: true}`. `201` with `Round`. |
| `GET /api/rounds/{id}` | `Round` |
| `DELETE /api/rounds/{id}` | Body `{confirm: "<id>"}`. Removes the folder. `{deleted: true}`. |
| `POST /api/rounds/{id}/next` | `ib next`. Returns `Round`, plus `{tagged: "stage-1"|null}`. |
| `POST /api/rounds/{id}/open-editor` | `{editor}` |
| `GET /api/rounds/{id}/changes` | `{files: [{path, status: "added"|"modified"|"deleted", additions, deletions}], diff, truncated}` against the starter, with the grader's ignore rules. Works without git. |
| `POST /api/rounds/{id}/test` | Body `{runner?}`: `ib test`. Job; result `TestResult`. |
| `POST /api/rounds/{id}/grade` | Body `{runner?, judge?: "none"|"api"|"prepare"}`. Job; result `GradeView`. |
| `GET /api/rounds/{id}/judge-prompt` | After `judge: "prepare"`: `{prompt, tokens_estimate}`. In memory only; `404` before that. |
| `POST /api/rounds/{id}/judge-reply` | Body `{reply}`: a chatbot's answer. Job; result `GradeView`. |
| `GET /api/rounds/{id}/attack-prompt` | `{prompt, suggested_filename, attack_dir, tokens_estimate}` |
| `POST /api/rounds/{id}/break` | Body `{filename, content, runner?}`: `ib break`. Job; result `BreakResult`. |

`RoundSummary` is `{id, task_id, title, path, started_at, ends_at, time_limit_minutes, stage,
stage_count, score_percent|null, active_job|null}`.

`active_job` is the id of the round's running job, for `GET /api/jobs/{id}`.

`Round` adds `task: Task`, `git`, `stages: [{number, title, markdown}]` (revealed only; `markdown` is
the brief without its title line), `all_revealed`, and `last: {test, grade, break}` (each a stored
result or null).

`TestResult` is `{passed, total, failures: [{name, message}], error, runner, finished_at}`.

`GradeView` is:

```
{ runner, summary, percent, points, graded_weight, total_weight, pending_weight,
  time_used_minutes, report_path, finished_at, judge_error,
  stages:   [{stage, title|null, revealed, passed, total, failures, withheld_failures, error}],
  criteria: [{id, type, weight, score|null, evidence, description, stage|null}],
  review:   null | {model, summary, candidate_tests: TestResult, missed_edge_cases,
                    issues: [{severity, category, location, description}]},
  judge_prepared }
```

For an unrevealed stage, `title` is null, `failures` is `[]`, `withheld_failures` is how many there
are, and `error`, if the stage couldn't run, is a fixed sentence rather than test output. The stage's
`auto` criterion follows suit: its `description` as in `Task`, and its `evidence` if that quoted an
error.

Any judge (`judge: "api"` or `"prepare"`, `judge-reply`, `judge-prompt`) answers `400 bad_request`
while stages remain hidden, before anything runs: "The AI judge reviews the whole round, so it runs
once every stage is revealed (you are on stage 1 of 3). ..." The *Grade* panel says so instead of
offering the judge. `ib grade --all-stages` and a hand-back folder without a round marker aren't limited.

`judge: "api"` needs a working setting, and when it fails the hidden-test scores still come back with
`judge_error` set, as in the CLI. `judge-reply` and repeat judge runs reuse the stored grade when the
workspace is unchanged (a fingerprint of the graded files) and the runner is the same, so they don't
rerun the hidden tests. A plain `judge: "none"` always runs them. The prompt doesn't survive a
restart: `judge-prompt` answers `404` again, and `judge-reply` rebuilds the prompt it needs.

`BreakResult` is `{attacks: [{name, verdict: "real break"|"survived"|"bad test", detail}], counts:
{real_break, survived, bad_test}, runner, finished_at}`. `filename` is a bare file name (letters,
digits, `.`, `_` and `-`); the attack file is written to a temp folder, never to the workspace.

### Jobs

`POST` routes marked Job answer `202` with `Job`. `GET /api/jobs/{id}` returns the latest `Job`.
Finished jobs are kept for an hour.

```
{ id, kind: "test"|"grade"|"judge-reply"|"break"|"validate", round_id|null,
  state: "running"|"succeeded"|"failed", phase, log: [str],
  started_at, finished_at|null, result|null, error|null }
```

`phase` is a sentence for the candidate ("Running hidden tests for stage 2 of 3"). `grade()` and the
other long calls report phases through an optional `progress` callback. Jobs can't be cancelled in
this version.

## Screens

- **Tasks**: cards with filters by category, tag and level. Starting one goes straight to the round.
- **Rounds**: every round with its stage, time and score. Resume or delete.
- **Round**: header with the task, the countdown, a stage stepper, *Open in editor* and the folder;
  the brief on the left; *Tests*, *Changes*, *Grade* and *Break it* on the right.
- **Author**: `ib new` and `ib validate`, for people writing tasks.
- **Settings**: the judge model, with presets for Claude, OpenRouter, Gemini, Groq and Ollama.

The *Grade* and *Break it* panels explain themselves in plain words: what runs, what it costs, what
the results mean. A first-time candidate shouldn't need this document or the README.
