#!/usr/bin/env bash
# Applies infra/firewall/rules.yaml to Halyard (format and semantics: infra/README.md).
set -euo pipefail

: "${HALYARD_TOKEN:?}"

cd "$(dirname "$0")/.."

halyard firewall apply --file infra/firewall/rules.yaml
