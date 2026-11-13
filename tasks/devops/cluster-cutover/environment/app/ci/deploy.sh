#!/usr/bin/env bash
# Renders deploy/k8s with the pipeline's variables and applies it to the cluster. Objects applied
# by an earlier run that are no longer in git are pruned.
set -euo pipefail

: "${STRIPE_SECRET_KEY:?}"
: "${STRIPE_WEBHOOK_SECRET:?}"

cd "$(dirname "$0")/.."

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

# Only these are substituted; any other ${...} in a manifest is left as it is.
substitute='${STRIPE_SECRET_KEY} ${STRIPE_WEBHOOK_SECRET}'

while IFS= read -r -d '' file; do
  mkdir -p "$out/$(dirname "$file")"
  envsubst "$substitute" < "$file" > "$out/$file"
done < <(find deploy/k8s -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)

# kubectl only prunes the kinds it is told about.
prune_kinds=(
  core/v1/Namespace
  core/v1/ServiceAccount
  core/v1/ConfigMap
  core/v1/Secret
  core/v1/Service
  apps/v1/Deployment
  apps/v1/StatefulSet
  apps/v1/DaemonSet
  batch/v1/Job
  batch/v1/CronJob
  autoscaling/v2/HorizontalPodAutoscaler
  networking.k8s.io/v1/Ingress
  networking.k8s.io/v1/NetworkPolicy
  policy/v1/PodDisruptionBudget
  rbac.authorization.k8s.io/v1/Role
  rbac.authorization.k8s.io/v1/RoleBinding
  rbac.authorization.k8s.io/v1/ClusterRole
  rbac.authorization.k8s.io/v1/ClusterRoleBinding
)

# Namespaces first, so the objects in them can be created in the same run.
kubectl apply -f "$out/deploy/k8s/namespaces.yaml"

kubectl apply --recursive -f "$out/deploy/k8s" \
  --prune --all "${prune_kinds[@]/#/--prune-allowlist=}"
