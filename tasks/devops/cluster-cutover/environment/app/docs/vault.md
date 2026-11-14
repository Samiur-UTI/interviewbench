# The platform Vault

One Vault for all Quayside clusters, run by the platform team.

- Address: `https://vault.platform.quayside.example:8200`.
- Its certificate is signed by the Quayside platform CA. trust-manager publishes that CA into every
  namespace as the ConfigMap `platform-ca` (key `ca.crt`). Do not create that ConfigMap yourself.

## Secrets

- `kv/`: KV version 2, production. Layout `kv/<namespace>/<name>`.
- `kv-stg/`: KV version 2, staging.

Secret values are written by the team that owns them, with the Vault CLI. They are never in git.

Each namespace that keeps secrets in `kv/` has a rate-limit quota on its subtree, in
`vault/sys/quotas/`. A client over its quota gets HTTP 429.

## Authentication

- Workloads: one kubernetes auth mount per cluster, named `k8s-<clusterName>`. To validate a
  service account token, Vault calls that cluster's API server, from `203.0.113.60`, as the
  service account `platform/vault-auth`.
- People: `oidc`. Their policies live in the identity repo, not here.

## Configuration

The `vault/` tree in this repo, applied by the pipeline. Format: `vault/README.md`.
