#!/usr/bin/env bash
# Verifier shared by every stage. Harbor (and ib) copy this folder, then steps/<stage>/tests/,
# into $TESTS_DIR and run this script. It must always write $LOGS_DIR/reward.txt (Harbor) and
# should write $LOGS_DIR/junit.xml (ib reads it for per-test results).
set -uo pipefail

APP_DIR="${APP_DIR:-/app}"
TESTS_DIR="${TESTS_DIR:-/tests}"
LOGS_DIR="${LOGS_DIR:-/logs/verifier}"
PYTHON="${PYTHON:-$(command -v python || command -v python3)}"

mkdir -p "$LOGS_DIR"
echo 0 > "$LOGS_DIR/reward.txt"   # never trust a reward file left behind by the agent
rm -f "$LOGS_DIR/junit.xml"
unset PYTHONPATH
export PYTHONDONTWRITEBYTECODE=1

# Run from $TESTS_DIR with our own pytest.ini, so files in the candidate's code (conftest.py,
# pytest.ini, a shadowing pytest.py) can't change how the hidden tests run.
cd "$TESTS_DIR"
"$PYTHON" -m pytest "$TESTS_DIR" -c "$TESTS_DIR/pytest.ini" --rootdir "$TESTS_DIR" \
  -o "pythonpath=$APP_DIR" --junitxml="$LOGS_DIR/junit.xml"

# Reward = fraction of hidden tests passed, so partial work gets partial credit.
"$PYTHON" - "$LOGS_DIR/junit.xml" "$LOGS_DIR/reward.txt" <<'EOF'
import sys
import xml.etree.ElementTree as ET

try:
    cases = list(ET.parse(sys.argv[1]).getroot().iter("testcase"))
except (OSError, ET.ParseError):
    cases = []
bad = sum(1 for c in cases if any(e.tag in ("failure", "error", "skipped") for e in c))
reward = (len(cases) - bad) / len(cases) if cases else 0.0
with open(sys.argv[2], "w") as f:
    f.write(f"{reward:.4f}\n")
EOF
exit 0
