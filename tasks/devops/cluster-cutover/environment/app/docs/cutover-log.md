# Cutover log

Kept during the move off the Compose host. Newest at the bottom.

**2026-10-12.** Four VMs up on Halyard. Control plane initialised, workers joined, pod network
up. Images pulled through our registry mirror.

**2026-10-13.** Ingress and certificates working. Storefront running on the cluster behind a test
hostname.

**2026-10-14.** CI can deploy from the runners. Pipeline now does firewall, Vault and manifests on
every push to main.

**2026-10-15.** Statusbeat check for the cluster added. Red for a couple of hours, green again.

**2026-10-15.** Orders running on the cluster against the managed Postgres. Dump restored, row
counts match.

**2026-10-16.** Support has their dashboard. SSO for it comes later.

**2026-10-19.** Prometheus is scraping the kubelets again. Node graphs are back.

**2026-10-19.** etcd snapshot pulled to the old host as an off-box copy. Restore tested on a
scratch VM.

**2026-10-20.** Vault set up for the cluster with the platform team. Smoke test reads a secret
from Vault from a pod.

**2026-10-21.** Service discovery sidecars can see the API.

**2026-10-22.** DNS switched. Storefront and orders served from the cluster; the old host serves
nothing.

**2026-10-23.** Payments is live on the cluster. Key comes from the pipeline for now. Test charge
went through. Handover done.
