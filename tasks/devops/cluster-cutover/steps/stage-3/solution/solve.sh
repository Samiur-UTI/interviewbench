#!/usr/bin/env bash
# Reference solution for stage 3: rotation without restarts (a Vault Agent sidecar with a 30 s
# render interval, and a service that follows its credentials file). Copies the files it changes
# over the working copy; it removes nothing.
set -euo pipefail
SOLUTION_DIR="${SOLUTION_DIR:-/solution}"
APP_DIR="${APP_DIR:-/app}"
cp -R "$SOLUTION_DIR/files/." "$APP_DIR/"
