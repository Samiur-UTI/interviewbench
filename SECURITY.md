# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: on
[Samiur-UTI/interviewbench](https://github.com/Samiur-UTI/interviewbench), open the **Security** tab
and choose **Report a vulnerability**. Please don't open a public issue for a security problem.

## What ib is, and what it isn't

interviewbench is a practice and interviewing aid. It is not a proctoring or anti-cheating system,
and it can't tell you whether a candidate worked alone.

## Grades are not tamper-proof

The hidden tests import and run the candidate's code in the same sandbox as the test runner (for
the Python tasks, in the same process), and ib reads the result from a JUnit file in a folder that
code can reach. Hostile code can therefore fake a perfect score, for example by writing its own
results when the process exits. Treat a score from a submission you don't trust as a first signal,
and read the code.

## Grading someone else's code runs it

`ib grade --dir <their workspace>` and `ib test` run the code in that workspace, and
`ib validate --run` runs a task's own scripts and solutions, so only validate tasks you trust.

- `--runner docker` runs it in a fresh container with no network, built from the task's Dockerfile,
  and removes the container afterwards. Use it for anything you didn't write.
- `--runner local` runs it with bash on your machine, as your user, with your network access and
  your files.
- `--runner auto`, the default, uses Docker when Docker is running and otherwise falls back to the
  local runner without asking. Pass `--runner docker` explicitly if you want a failure instead.

The local runner leaves secret-looking variables out of the environment it gives the tests: any
name (case-insensitive) containing `API_KEY`, `APIKEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`,
`CREDENTIAL`, `PRIVATE_KEY`, `ASKPASS` or `CONNECTION_STRING`; names ending in `_PWD`, `_AUTH` or
`_DSN`; database and broker URLs such as `DATABASE_URL`, `REDIS_URL` and `MONGODB_URI`; every
variable starting with `AWS_`, `AZURE_`, `ANTHROPIC_`, `OPENAI_`, `IB_JUDGE_`, `GH_`, `GITHUB_` or
`VSCODE_GIT_`; and `SSH_AUTH_SOCK`. It also drops `PYTHONPATH`. Everything else, such as `PATH`,
`HOME` and the toolchain's own variables, is passed on. This is a mitigation, not a sandbox: code
run this way can still read your files, including credential files in your home folder, and use
the network. The Docker runner passes none of your environment into the container.

## `ib break`

`ib break` runs test files written by an LLM against the candidate's code and the reference
solution, with the same runner and the same exposure as grading. Read an attack file before you
run it with the local runner.

## The local GUI (`ib ui`)

The GUI's server binds to `127.0.0.1` only. `ib ui` prints a link with a random token made for that
run; opening it swaps the token for an `HttpOnly`, `SameSite=Strict` cookie, and every `/api/`
request without that cookie is refused. Requests whose `Host` isn't `127.0.0.1:<port>` or
`localhost:<port>` are refused, and so are requests that change something unless they are sent as
JSON and any `Origin` header they carry is the server's own. An API key typed into the GUI stays in
the server's memory: it isn't written to disk or put in the environment. See [docs/GUI.md](docs/GUI.md).

## The shipped tasks are public

The hidden tests and reference solutions of the tasks in `tasks/` are in this repository and in the
installed package. That is fine for practice, but anyone can look them up, so don't use them to vet
candidates. Write private tasks for that (`ib new`).

## Where ib keeps spoilers

An AI assistant working in a workspace can read anything in it. So the full grade results (the
GUI's stored results and `ib-report-full.md`) and the judge prompt exported with `--judge-export`
are written outside the workspace, to a per-workspace folder under ib's data folder: `IB_DATA_DIR`
if set, else `%LOCALAPPDATA%\interviewbench` on Windows, `~/Library/Application Support/interviewbench`
on macOS, and `$XDG_STATE_HOME/interviewbench` (default `~/.local/state/interviewbench`) elsewhere.
Code run by the local runner runs as you and can read that folder too.

## Known limits

- Hostile code can forge the JUnit results and so its score.
- The local runner is not isolated: it filters the environment, nothing more.
- If `ib` is killed outright during a Docker run (not stopped with Ctrl-C), its container is not
  removed and keeps running until its script finishes. Remove leftover `ib-*` containers with
  `docker rm -f`. The container limits CPU and memory only when the task sets them.
