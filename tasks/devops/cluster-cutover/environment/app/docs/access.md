# Access to the cluster

What people and systems need. People log in with SSO; their OIDC groups are below.

## People

- `quayside:platform` (two engineers): cluster-admin.
- `quayside:developers`: deploy and debug `storefront` and `orders` (the built-in `edit` role
  there). In every other namespace, look at pods, their logs and events.
- `quayside:support`: read-only everywhere: pods, their logs, events, deployments, services.
  Support has no kubectl. They use the dashboard at `https://<any worker>:30443` over the VPN and
  log in there with their own token.
- `quayside:payments-oncall`: the built-in `admin` role in `payments`.

## Systems

- `platform/ci-deployer`, the pipeline's service account, used from the CI runners: applies
  everything in this repo, so cluster-admin.
- Statusbeat: `GET /readyz` on the API server, without credentials (it cannot send any).

## Workloads

None talks to the Kubernetes API except:

- Prometheus (`monitoring/prometheus`): service discovery, and each kubelet's metrics with its
  service account token.
- The dashboard: its own namespace's settings.
- `platform/vault-auth`: token reviews for the platform Vault.
