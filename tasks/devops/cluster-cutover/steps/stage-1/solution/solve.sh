#!/usr/bin/env bash
# Reference solution for stage 1: the firewall, the kubelets and the dashboard. Copies the files
# it changes over the working copy and removes the binding nothing needed.
set -euo pipefail
SOLUTION_DIR="${SOLUTION_DIR:-/solution}"
APP_DIR="${APP_DIR:-/app}"
cp -R "$SOLUTION_DIR/files/." "$APP_DIR/"
rm -f "$APP_DIR/deploy/k8s/monitoring/statusbeat.yaml"
