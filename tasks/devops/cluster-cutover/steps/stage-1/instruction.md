# A stranger has our pod list

You've joined the platform team at Quayside, which runs online ordering for independent
restaurants: a public storefront, an orders API and a payments service that charges cards through
Stripe. Three weeks ago everything moved from one Docker Compose host to a self-managed Kubernetes
cluster (`quay-prod-fra1`: kubeadm on four Halyard Cloud VMs). A contractor did most of the cutover
and has since left. This repo is the platform: the cloud firewall, the cluster configuration, every
manifest, the platform Vault's configuration, the pipeline that applies them, and the payments
service's code. Read `README.md` first, then `docs/` and `infra/README.md`.

On Monday this arrived at security@:

> I look for exposed clusters, and certificate transparency logs led me to yours. All I needed
> were your nodes' public addresses. I had no account and no credentials. I listed every pod in
> every namespace, image tags included. I read your payments pods' logs. I ran `id` inside one of
> your storefront containers. I opened your cluster's admin console in a browser and it never asked
> who I was. There is more than one way in: I used four and stopped looking. I changed nothing.
> You have until Friday.

Find every way in and close it, without breaking what depends on the cluster.

## What must hold afterwards

### The firewall

- `infra/firewall/rules.yaml` lets in the flows `docs/network.md` lists and no others: nothing more
  from the internet, and nothing more from the networks we trust either. Keep the file's schema
  (`infra/README.md`).

### No credentials, no answer

- The API server answers a request that carries no credentials on its health and version endpoints
  only (`/healthz`, `/livez`, `/readyz`, `/version`). Nothing else: no resource in any namespace,
  no discovery, no metrics. (The `cluster-info` ConfigMap kubeadm publishes in `kube-public` for
  joining nodes is kubeadm's business and not part of this.)
- A kubelet answers no request that is not both authenticated and authorised by the cluster's
  RBAC, on any port it listens on.
- Nothing lends its own identity to a caller who hasn't logged in. The dashboard asks every user
  for their own credentials, and its service account cannot create, change or delete anything, or
  exec into a pod, outside the `kubernetes-dashboard` namespace.

### What must keep working

- Statusbeat's uptime probe and Prometheus (`docs/monitoring.md`).
- The pipeline's deploys, and every person's access as `docs/access.md` describes it. Nobody in
  that file loses anything it says they need.
- The platform Vault's token reviews against this cluster (`docs/vault.md`).
- The storefront for the public, and the dashboard for support over the VPN, where they are today.
- The API server still authorises with `Node` and `RBAC`.

## How your work is checked

No cluster runs in the tests. They read what the pipeline applies and evaluate it the way the real
components would:

- `infra/firewall/rules.yaml`, by the rules in `infra/README.md`;
- `infra/cluster/kubeadm.yaml`: the API server's flags and the kubelet's configuration. A flag or
  field you leave out has the default it has upstream for this Kubernetes version;
- every YAML file under `deploy/k8s/`, as the objects in the cluster (the pipeline prunes what is
  no longer there), with RBAC evaluated as the API server does it, including the roles and
  bindings every kubeadm cluster comes with.

Keep those paths and formats. Run the repo's own tests with `python -m pytest`.

Write what you found, why each way in existed and what you changed in `NOTES.md`, including how
you used AI assistance and what you checked yourself.
