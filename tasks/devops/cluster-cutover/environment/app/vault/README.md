# vault/

The platform Vault's configuration for this cluster and the services on it. `ci/vault-apply.sh`
applies it on every pipeline run on `main`.

## Format

A file's path under `vault/` is its API path under `/v1/`. A `.json` file is the request body
written to that path.

| File | What it is |
|---|---|
| `sys/mounts/<path>.json` | A secrets engine mounted at `<path>/`. The mount exists when the file does. |
| `sys/auth/<path>.json` | An auth method enabled at `auth/<path>/`. The mount exists when the file does. |
| `sys/policies/acl/<name>.hcl` | An ACL policy. The file is the policy text (HCL). |
| `auth/<mount>/config.json` | The configuration of an auth mount. |
| `auth/<mount>/role/<name>.json` | A role on a kubernetes auth mount, with the fields of Vault's kubernetes auth role API. |
| `sys/quotas/rate-limit/<name>.json` | A rate-limit quota. |

`ci/vault-apply.sh` writes every file, and removes roles, policies and quotas that are no longer
in the tree. It never disables a mount.

## Values filled in at apply time

- `"@platform-ca"` stands for the platform CA bundle (the clusters' CAs are issued from it). The
  script reads it from the pipeline.
- `token_reviewer_jwt` of each kubernetes auth mount is not in git. The script adds it from a
  masked pipeline variable when it writes the mount's `config.json`.

## Not here

Secret values (written by the owning team with the Vault CLI) and people's policies (identity
repo).
