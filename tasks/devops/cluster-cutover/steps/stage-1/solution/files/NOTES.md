# Notes

## Stage 1: what was wrong, why, and how I fixed it

The reporter's four ways in are real, and there was a fifth. Each had at least two layers: the
Halyard firewall let the internet reach the port, and the component behind it answered without
asking who was calling. I closed both layers of every door, because the cluster layer is what
protects us from the VPN, from any pod (pod traffic reaches the nodes from the node network), and
from the next firewall mistake, and the firewall layer is what protects ports that should never
have been reachable at all.

### The ways in

**1. The API server answered anyone** ("I listed every pod in every namespace... I read your
payments pods' logs"). `deploy/k8s/monitoring/statusbeat.yaml` bound the group
`system:unauthenticated`, which is every request without credentials, to `cluster-reader`
(`*` get/list/watch, Secrets and `pods/log` included, plus every non-resource URL). Port 6443 was
open to `0.0.0.0/0`. So anyone on the internet could list pods, read logs and read every Secret,
the Stripe key in `payments-stripe` included.

Why it existed: the cutover log has Statusbeat "red for a couple of hours, green again" on the day
this binding appeared. The probe cannot send credentials, and the contractor bound the
unauthenticated group to a reader role to make it pass. It never needed that: every kubeadm
cluster binds `system:public-info-viewer` (GET `/healthz`, `/livez`, `/readyz`, `/version`) to
`system:unauthenticated`, so an anonymous `GET /readyz` is answered by default. What Statusbeat
did need is a firewall opening from its probe range, `192.0.2.64/28`, which had been "solved" by
opening 6443 to the world.

Fix: deleted `statusbeat.yaml` (the pipeline prunes the binding). `anonymous-auth` stays `true`:
turning it off would make every anonymous request a 401, `/readyz` included, and page platform
on-call every minute. With the binding gone, an anonymous caller gets the four health and version
endpoints and nothing else (no discovery: `system:discovery` is bound to authenticated users only).
6443 is now open only to the sources `docs/network.md` lists: VPN, CI runners, Statusbeat, the
platform Vault (token reviews) and the node network (kubelets, and pods, whose traffic to node
addresses is masqueraded to the node's address by flannel).

**2. The kubelets answered anyone on 10250** ("I ran `id` inside one of your storefront
containers"). `infra/cluster/kubeadm.yaml` set the kubelet to `anonymous.enabled: true`,
`webhook.enabled: false` and `authorization.mode: AlwaysAllow`, and 10250 was open to `0.0.0.0/0`
on every node. `POST /exec/<namespace>/<pod>/<container>?command=id` on a worker's public address
ran a command in any container, no credentials needed; `/pods` lists every pod on the node,
`/containerLogs` reads logs. The API server's RBAC never sees these requests.

Why it existed: "Prometheus is scraping the kubelets again". Prometheus scrapes `/metrics` and
`/metrics/cadvisor` on 10250 with its service account token. With webhook authentication off, the
kubelet cannot validate that token at all, so the scrape failed; the contractor made the kubelet
let everyone in instead of turning token authentication on. Prometheus never needed that either:
its ClusterRole already grants `get` on `nodes/metrics`, which is exactly what the kubelet asks the
API server about for `/metrics*` in `Webhook` mode.

Fix: anonymous off, webhook authentication on, `authorization.mode: Webhook` (these are also
kubeadm's defaults; I wrote them out so nobody has to know that). Every request to a kubelet now
needs a token or client certificate the API server accepts, and is authorised through RBAC on
`nodes/<subresource>`. The API server's own calls to kubelets (`kubectl logs/exec`) use its kubelet
client certificate, which the `x509.clientCAFile` already trusts. 10250 is open to the node
network only (the API server on cp-1 and Prometheus in a pod).

**3. The kubelets' read-only port** (`readOnlyPort: 10255`, open to the world on every node).
It serves `/pods`, `/stats` and `/metrics` over plain HTTP with no authentication at all, whatever
the settings above say. Probably the contractor's first attempt at node metrics. Fix:
`readOnlyPort: 0`, and the firewall rule is gone. This is the fifth door; the reporter may have
used it to list pods.

**4. The dashboard was an open cluster-admin console** ("I opened your cluster's admin console in
a browser and it never asked who I was"). The dashboard ran with `--enable-skip-login`, its
service account was bound to `cluster-admin`, and NodePort 30443 was reachable from the internet
because the whole NodePort range (30000-32767) was open on the workers. Skipping the login makes
the dashboard act as its own service account: anyone could read Secrets, exec and delete anything.

Why it existed: "Support has their dashboard. SSO for it comes later." The contractor made it
usable without a login until SSO arrived. It never needed to be: `docs/access.md` says support log
in with their own token, and the dashboard then makes every request with that token, so support see
exactly what their own role allows.

Fix: removed `--enable-skip-login` (login is the dashboard's default). The cluster-admin binding is
replaced by a Role in `kubernetes-dashboard` that lets the dashboard read and update only its own
Secrets (`kubernetes-dashboard-key-holder`, `-certs`, `-csrf`, by name) and its settings ConfigMap,
the upstream v2.7.0 rules minus the metrics scraper we don't run. The Service stays a NodePort on
30443, and the firewall opens 30443 on the workers to the VPN only.

### The firewall

Rewritten from `docs/network.md`'s six flows, nothing else, keeping the schema in
`infra/README.md`:

| Port | Control plane | Workers |
|---|---|---|
| tcp 80, 443 | - | anyone |
| tcp 6443 | VPN, CI runners, Statusbeat (`/28`), Vault, node network | - |
| tcp 10250 | node network | node network |
| udp 8472 | node network | node network |
| tcp 22 | VPN | VPN |
| tcp 30443 | - | VPN |

Removed beyond the doors above: etcd (2379-2380) from anywhere (etcd is local to cp-1 and backups
run there; kubeadm's etcd requires client certificates, so it was not a way in, but it had no
reason to face the internet: the cutover log's snapshot copy to the old host is the likely
reason it was opened), ssh from anywhere (VPN only now), and the rest of the NodePort range.

### What the firewall alone would not have closed

From the VPN, from the node network, and so from any pod in the cluster, every door above was
still open: anonymous `cluster-reader` on the API server (pods reach 6443 through the node
network), anonymous exec on every kubelet's 10250, the read-only port, and a login-free
cluster-admin dashboard for anyone on the VPN. A compromised storefront pod would have owned the
cluster. That is why the cluster-side fixes matter more than the firewall.

### What I did not change, and why

- `anonymous-auth` stays on (Statusbeat, see above), and `authorization-mode` stays `Node,RBAC`.
- `access/workloads.yaml` binds `system:authenticated` (every logged-in person and every pod's
  service account token) to `cluster-reader`, which includes Secrets. It is not a no-credentials
  door, but it means any pod can read the Stripe key. The cutover log says "service discovery
  sidecars can see the API", while `docs/access.md` says no workload except Prometheus, the
  dashboard and vault-auth talks to the API. I want to confirm nothing still depends on it before
  removing it, so it is the first item for the next change, not part of this incident fix.
- In the same vein, for the next change: developers have `edit` cluster-wide (exec and Secrets in
  `payments`), and support's `cluster-reader` reads Secrets. Both go beyond `docs/access.md`.
- The Vault side (`smoke-test` role) and the Stripe Secret: same.
- Nobody loses access: platform, CI, developers, support, on-call bindings are untouched; the
  dashboard and its NodePort stay; Vault can still reach 6443 and `vault-auth` keeps
  `system:auth-delegator`.

### Rolling it out

The pipeline applies the firewall and the manifests. The kubelet configuration is applied by
hand: update the `kubelet-config` ConfigMap in `kube-system` from `kubeadm.yaml`, then on each node
in turn `kubeadm upgrade node phase kubelet-config` and `systemctl restart kubelet`. Check after
each node: `curl -k https://<node>:10250/pods` gives 401, `curl http://<node>:10255/pods` is
refused, Prometheus's kubelet and cadvisor targets are up, `kubectl logs` and `kubectl exec` still
work, and `kubectl top nodes` (metrics-server) still answers.

### Tests added

`tests/test_exposure.py`, each test failing on the repo as the contractor left it:

- the firewall, evaluated with `infra/README.md`'s rules: every rule is part of a flow in
  `docs/network.md`, every flow gets through, and the internet reaches nothing but 80/443 on the
  workers;
- the API server still authorises with `Node,RBAC`; the kubelet authenticates with webhooks and
  authorises with `Webhook`, with no read-only port;
- no binding names `system:unauthenticated` or `system:anonymous`;
- the dashboard requires a login, its service account has no cluster-wide binding, and it is on
  NodePort 30443 for the VPN only.

## Stage 2

## Stage 3

## How I used AI assistance (and what I checked myself)

I used an assistant to read the repo with me and to draft the firewall rules and the tests. It
got three things wrong that I caught by checking against the docs: its first fix for the API
server was `anonymous-auth: "false"`, which would have broken Statusbeat (I checked that
`system:public-info-viewer` is bound to `system:unauthenticated` by default on 1.28 and covers
`/readyz`); it proposed turning the kubelet's webhook authentication off "since anonymous is
disabled anyway", which would have left Prometheus's token unverifiable and its scrapes failing;
and its first firewall draft widened the VPN to a `/24` and allowed ssh and etcd from the node
network, none of which `docs/network.md` lists. I wrote the flow table from `docs/network.md`
myself and made the tests derive their expectations from it, and I traced each of the reporter's
four claims to the setting that allowed it before deciding the fix.
