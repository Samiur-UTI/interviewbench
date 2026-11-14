# Runbook: deploying

## How a deploy runs

A merge to `main` runs `ci/pipeline.yaml`: `test`, `firewall`, `vault`, `deploy`, in that order.
A stage that fails stops the ones after it. Merge requests run `test` only.

`deploy` runs `ci/deploy.sh`: it substitutes the pipeline's variables into every YAML file under
`deploy/k8s/`, applies all of it with `kubectl apply`, and prunes objects that were applied before
and are no longer in git. Changes made by hand with `kubectl` last until the next deploy.

Watch it land:

```bash
kubectl -n <namespace> rollout status deployment/<name>
```

Image tags change in the service repos' release jobs, which open a merge request here.

## Rolling back

Revert the commit on `main` and let the pipeline run again. That covers manifests, firewall rules
and Vault configuration alike: whatever the revert puts back is applied again, and whatever it
removes is pruned.

If the pipeline itself is broken, re-run the `deploy` job of the last good pipeline from the CI
UI.
