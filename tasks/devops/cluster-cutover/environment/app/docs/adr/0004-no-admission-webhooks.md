# 4. No mutating admission webhooks in production

- Status: accepted
- Date: 2026-09-08
- Deciders: platform

## Context

The old staging cluster ran mutating admission webhooks that injected sidecars into pods. In
June the webhook's own pods went down during a node drain. Its failure policy blocked every pod
creation in the cluster, including the replacements for the webhook itself, and staging was stuck
until someone removed the webhook configuration by hand. Nothing in the pod specs in git said what
would actually run.

## Decision

The production cluster runs no mutating admission webhooks.

## Consequences

- No Vault Agent Injector and no service mesh sidecar injection.
- Anything that needs a sidecar writes it out in its manifests, so the pod spec in git is the pod
  that runs.
- Validating webhooks are not covered by this decision; bring them to platform first.
