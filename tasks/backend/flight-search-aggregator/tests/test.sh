#!/usr/bin/env bash
# Verifier shared by every stage. Harbor (and ib) copy this folder, then steps/<stage>/tests/,
# into $TESTS_DIR and run this script. It always writes $LOGS_DIR/reward.txt (Harbor) and
# $LOGS_DIR/junit.xml (ib reads it for per-test results).
set -uo pipefail

APP_DIR="${APP_DIR:-/app}"
TESTS_DIR="${TESTS_DIR:-/tests}"
LOGS_DIR="${LOGS_DIR:-/logs/verifier}"

mkdir -p "$LOGS_DIR"
echo 0 > "$LOGS_DIR/reward.txt"   # never trust a reward file left behind by the agent
rm -f "$LOGS_DIR/junit.xml"
export APP_DIR
unset NODE_OPTIONS

# Run from $TESTS_DIR with its own package.json. The hidden tests import the app by absolute
# path (tests/helpers/app.ts), so nothing in the candidate's folder changes how they run.
cd "$TESTS_DIR"

# Only this stage's hidden tests. If every step uploads into the same /tests, earlier stages'
# files are still there; each stage's tests/ carries a STAGE file with its number, and the
# latest upload overwrites it.
STAGE="$(tr -d '[:space:]' < "$TESTS_DIR/STAGE")"

# Hangs. No --test-force-exit: it loses results at random (see helpers/exit-guard.mjs, which takes
# its place). --test-timeout turns a test that never settles into a failed testcase, and
# exit-guard.mjs ends a file whose code under test leaks a timer or socket. `timeout -k 5 690s`
# is only a last resort, below [verifier].timeout_sec (720) so the reward below is still written.
# (Relative to the cd above: on Windows, --import reads "C:/..." as a URL and refuses it.)
timeout -k 5 690s node --import ./helpers/exit-guard.mjs \
  --no-warnings=ExperimentalWarning --test --test-concurrency=1 --test-timeout=20000 \
  --test-reporter=junit --test-reporter-destination="$LOGS_DIR/junit.xml" \
  --test-reporter=spec --test-reporter-destination=stdout \
  "$TESTS_DIR"/stage"$STAGE"*.test.ts

# Reward = fraction of hidden tests passed, so partial work gets partial credit.
node "$TESTS_DIR/reward.mjs" "$LOGS_DIR/junit.xml" "$LOGS_DIR/reward.txt"
exit 0
