#!/usr/bin/env bash
# Reference solution for this stage: copy the files it changes over the working copy.
set -euo pipefail
SOLUTION_DIR="${SOLUTION_DIR:-/solution}"
APP_DIR="${APP_DIR:-/app}"
cp -R "$SOLUTION_DIR/files/." "$APP_DIR/"
