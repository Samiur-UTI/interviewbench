#!/usr/bin/env bash
# Applies the vault/ tree to the platform Vault. Format: vault/README.md.
set -euo pipefail

: "${VAULT_ADDR:?}"
: "${VAULT_TOKEN:?}"
: "${PLATFORM_CA_FILE:?}"

cd "$(dirname "$0")/../vault"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# api METHOD PATH [BODY_FILE]
api() {
  local args=(--silent --show-error --fail-with-body --cacert "$PLATFORM_CA_FILE"
              --header "X-Vault-Token: $VAULT_TOKEN" --request "$1")
  if [[ $# -ge 3 ]]; then
    args+=(--header 'Content-Type: application/json' --data-binary "@$3")
  fi
  curl "${args[@]}" "$VAULT_ADDR/v1/$2"
}

# render FILE: the request body, with "@platform-ca" replaced by the CA bundle.
render() {
  jq --rawfile ca "$PLATFORM_CA_FILE" 'walk(if . == "@platform-ca" then $ca else . end)' "$1"
}

# list PATH: the keys under PATH, nothing when there are none.
list() {
  { api LIST "$1" 2>/dev/null || echo '{}'; } | jq -r '.data.keys[]?'
}

name_of() {
  local base="${1##*/}"
  echo "${base%.*}"
}

# Mounts are created once; they are never disabled or re-mounted from here.
mounted="$(api GET sys/mounts | jq -r '.data | keys[]')"
for file in sys/mounts/*.json; do
  path="$(name_of "$file")"
  grep -qxF "$path/" <<<"$mounted" || api POST "sys/mounts/$path" "$file" >/dev/null
done

enabled="$(api GET sys/auth | jq -r '.data | keys[]')"
for file in sys/auth/*.json; do
  path="$(name_of "$file")"
  grep -qxF "$path/" <<<"$enabled" || api POST "sys/auth/$path" "$file" >/dev/null
done

for file in sys/policies/acl/*.hcl; do
  jq --raw-input --slurp '{policy: .}' "$file" > "$tmp/body.json"
  api PUT "sys/policies/acl/$(name_of "$file")" "$tmp/body.json" >/dev/null
done

for file in auth/*/config.json; do
  mount="${file#auth/}"
  mount="${mount%/config.json}"
  var="REVIEWER_JWT_$(tr 'a-z-' 'A-Z_' <<<"$mount")"
  render "$file" | jq --arg jwt "${!var:?$var is not set}" '. + {token_reviewer_jwt: $jwt}' \
    > "$tmp/body.json"
  api POST "auth/$mount/config" "$tmp/body.json" >/dev/null

  for role_file in "auth/$mount"/role/*.json; do
    [[ -e $role_file ]] || continue
    render "$role_file" > "$tmp/body.json"
    api POST "${role_file%.json}" "$tmp/body.json" >/dev/null
  done
  for role in $(list "auth/$mount/role"); do
    [[ -f "auth/$mount/role/$role.json" ]] || api DELETE "auth/$mount/role/$role" >/dev/null
  done
done

for file in sys/quotas/rate-limit/*.json; do
  api POST "sys/quotas/rate-limit/$(name_of "$file")" "$file" >/dev/null
done
for quota in $(list sys/quotas/rate-limit); do
  [[ -f "sys/quotas/rate-limit/$quota.json" ]] || api DELETE "sys/quotas/rate-limit/$quota" >/dev/null
done

# People's policies live in the same Vault, so a policy is only deleted when its file was deleted
# from git since the last pipeline.
if [[ -n ${CI_COMMIT_BEFORE_SHA:-} && ${CI_COMMIT_BEFORE_SHA} != 0000000000000000000000000000000000000000 ]]; then
  git diff --name-only --diff-filter=D "$CI_COMMIT_BEFORE_SHA" HEAD -- sys/policies/acl |
    while read -r file; do
      if [[ $file == *.hcl ]]; then
        api DELETE "sys/policies/acl/$(name_of "$file")" >/dev/null
      fi
    done
fi
