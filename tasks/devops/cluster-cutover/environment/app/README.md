# Quayside platform

Quayside runs online ordering for independent restaurants. Diners order on the storefront, the
orders API takes the order, and the payments service charges the card through Stripe. Restaurants
see their orders on a tablet.

This repo is the platform all of that runs on: the Halyard Cloud firewall, the cluster's
configuration, every Kubernetes manifest, the platform Vault's configuration for this cluster, the
pipeline that applies them, and the payments service's code. The storefront and orders services
live in their own repos; only their manifests are here.

## The cutover

Until three weeks ago everything ran on one Docker Compose host. It now runs on `quay-prod-fra1`,
a kubeadm cluster on four Halyard VMs (one control plane, three workers). A contractor did most of
the move and has since left.

Cluster add-ons (flannel, CoreDNS, the ingress controller, cert-manager, trust-manager,
metrics-server) were installed with Helm during the cutover and are not managed from this repo.

## Layout

| Path | What |
|---|---|
| `infra/` | Halyard firewall, the node list, the kubeadm configuration (`infra/README.md`) |
| `deploy/k8s/` | Every Kubernetes object we apply, one folder per namespace or area |
| `vault/` | The platform Vault's configuration for this cluster (`vault/README.md`) |
| `ci/` | The pipeline and the scripts it runs |
| `services/payments/` | The payments service (Python, standard library only) |
| `tests/` | This repo's tests |
| `compose/` | The old host's Compose file |
| `docs/network.md` | Addresses and inbound flows |
| `docs/access.md` | Who needs what in the cluster |
| `docs/monitoring.md` | Statusbeat and Prometheus |
| `docs/vault.md` | The platform Vault |
| `docs/standards/` | Platform standards |
| `docs/adr/` | Decisions |
| `docs/cutover-log.md` | The contractor's log from the move |
| `docs/runbooks/` | Deploys, the Stripe key |

## How things are applied

Every push to `main` runs `ci/pipeline.yaml`:

1. `test`: `python -m pytest`.
2. `firewall`: `ci/apply-firewall.sh` applies `infra/firewall/rules.yaml` to Halyard.
3. `vault`: `ci/vault-apply.sh` applies the `vault/` tree to the platform Vault.
4. `deploy`: `ci/deploy.sh` substitutes the pipeline's variables into every YAML file under
   `deploy/k8s/`, `kubectl apply`s them all, and prunes what is no longer in git.

`infra/cluster/kubeadm.yaml` is not applied by the pipeline; it is used on the nodes themselves
(`infra/README.md`).

## Images

Every image comes from `registry.quayside.example`. Our own images are under `quayside/`. Upstream
images are mirrored under `mirror/<upstream path>` (for example `mirror/library/python`) and always
pinned to a tag, never `latest`.

## Priorities

1. Taking payments. A configuration change must never stop card payments.
2. The storefront.
3. Everything else.

## Tests

```bash
python -m pytest
```

Needs Python 3.10 or later with `pytest` and `pyyaml`.

`compose/docker-compose.yml` is the old host's file. It is kept for reference until the host is
wiped and nothing uses it.
