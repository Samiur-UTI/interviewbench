#!/usr/bin/env bash
# Reference solution for stage 2: the Stripe values move to Vault. Copies the files it adds or
# changes over the working copy and removes what it replaces: the Secret, the smoke-test role and
# its kv-read-all policy, and the binding that gave every authenticated caller read access.
set -euo pipefail
SOLUTION_DIR="${SOLUTION_DIR:-/solution}"
APP_DIR="${APP_DIR:-/app}"
cp -R "$SOLUTION_DIR/files/." "$APP_DIR/"
rm -f "$APP_DIR/deploy/k8s/payments/secret.yaml" \
      "$APP_DIR/deploy/k8s/access/workloads.yaml" \
      "$APP_DIR/vault/auth/k8s-quay-prod-fra1/role/smoke-test.json" \
      "$APP_DIR/vault/sys/policies/acl/kv-read-all.hcl"
