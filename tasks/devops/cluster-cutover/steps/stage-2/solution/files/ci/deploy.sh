#!/usr/bin/env bash
# Applies deploy/k8s to the cluster as it is in git. Objects applied by an earlier run that are no
# longer in git are pruned.
set -euo pipefail

cd "$(dirname "$0")/.."

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
kubectl apply -f deploy/k8s/namespaces.yaml

kubectl apply --recursive -f deploy/k8s \
  --prune --all "${prune_kinds[@]/#/--prune-allowlist=}"
