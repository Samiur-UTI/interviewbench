#!/usr/bin/env bash
# Verifier shared by every stage. Harbor (and ib) copy this folder, then steps/<stage>/tests/,
# into $TESTS_DIR and run this script. It always writes $LOGS_DIR/reward.txt (Harbor) and
# $LOGS_DIR/junit.xml (ib reads it for per-test results).
#
# Hangs. The app under test opens sockets and timers; a solution that leaks one must cost the tests
# it breaks, not the whole report. Measured on Node 24.13 (Windows host and Linux container):
# - Without --test-force-exit, one leaked setInterval keeps the runner alive after the last test;
#   when the outer `timeout` kills it, the junit reporter (which buffers until the run ends) has
#   written nothing, so every <testcase> is lost and the stage scores 0.
# - With --test-force-exit the runner exits once the last test finishes, leaked handles or not.
#   Writing junit to a file destination has dropped testcases at random under force-exit, so junit
#   goes to stdout, redirected to the file (file-backed stdout writes are synchronous).
# - --test-timeout turns a test body that never settles into a failed testcase.
# - `timeout -k 5 540s` is only a last-resort guard below [verifier].timeout_sec (600).
# - --single-threaded (a V8 flag, passed on to each test file's process): on Windows, a forced
#   exit while V8's background threads still post tasks to the event loop aborts the process
#   (libuv "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" in async.c), and the runner
#   then reports the whole file as failed although every test in it passed. Measured with the
#   stage 1 full-stack file: aborted in 5 of 5 runs as is, 5 of 5 with --single-threaded-gc, 0 of
#   10 with --single-threaded. The tests are small: V8's background threads buy nothing here.
set -uo pipefail

APP_DIR="${APP_DIR:-/app}"
TESTS_DIR="${TESTS_DIR:-/tests}"
LOGS_DIR="${LOGS_DIR:-/logs/verifier}"

mkdir -p "$LOGS_DIR"
echo 0 > "$LOGS_DIR/reward.txt"   # never trust a reward file left behind by the agent
rm -f "$LOGS_DIR/junit.xml"
export APP_DIR
unset NODE_OPTIONS

# Run from $TESTS_DIR with its own package.json. The hidden tests import the app by absolute path
# (tests/helpers/app.ts), so nothing in the candidate's folder changes how they run.
cd "$TESTS_DIR"

# Only this stage's hidden tests. If every step uploads into the same /tests, earlier stages'
# files are still there; each stage's tests/ carries a STAGE file with its number, and the latest
# upload overwrites it.
STAGE="$(tr -d '[:space:]' < "$TESTS_DIR/STAGE")"
timeout -k 5 540s node --single-threaded --no-warnings=ExperimentalWarning --test --test-force-exit --test-concurrency=1 \
  --test-timeout=30000 \
  --test-reporter=junit --test-reporter-destination=stdout \
  --test-reporter=spec --test-reporter-destination=stderr \
  "$TESTS_DIR"/stage"$STAGE"*.test.ts > "$LOGS_DIR/junit.xml"

# Reward = fraction of hidden tests passed, so partial work gets partial credit.
node "$TESTS_DIR/reward.mjs" "$LOGS_DIR/junit.xml" "$LOGS_DIR/reward.txt"
exit 0
