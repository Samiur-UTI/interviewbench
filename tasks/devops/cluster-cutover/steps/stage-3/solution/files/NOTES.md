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

The two Stripe values now live only in Vault at `kv/payments/stripe`. A Vault Agent init container
in each payments pod logs in with the pod's own service account and writes them to a file in the
pod's memory before the `payments` container starts; the service reads that file. The Secret, the
pipeline variables and every path that let someone else read the key through Kubernetes or Vault
are gone.

### Vault (`vault/`)

- `auth/k8s-quay-prod-fra1/role/payments-api.json`: bound to the service account `payments-api` in
  `payments` and nothing else, `audience: vault`, `token_ttl: 20m`, `token_max_ttl: 4h`, policy
  `payments-api`. The mount is this cluster's (`k8s-<clusterName>`), not Vault's default
  `kubernetes`.
- `sys/policies/acl/payments-api.hcl`: `read` on `kv/data/payments/stripe`, nothing else. `kv/` is
  KV version 2, so the API path of the secret has `data/` in it; `kv/payments/stripe` in a policy
  matches nothing a client reads, and `kv/data/payments/*` would also read `payments/stripe-connect`
  and anything payments stores later. The token can do nothing else beyond Vault's `default`
  policy: no list, no metadata, no write or delete.
- Deleted the `smoke-test` role and its `kv-read-all` policy. The role let the `default` service
  account of any namespace log in, with any audience, for 24 hours, and read and list all of `kv/`:
  every pod in the cluster that runs as `default` (the storefront does) could read the Stripe key
  and every other team's secrets. It was the contractor's "smoke test reads a secret from Vault
  from a pod" and had no other user. `ci/vault-apply.sh` deletes roles that are no longer in the
  tree and policies whose file was deleted.
- Left alone: the staging mount's `stg-services` role. It only accepts tokens from the staging
  cluster and only reads `kv-stg/`, so it cannot reach `payments/stripe`; it predates the standard
  (any service account name, 768 h tokens) and I've raised it with platform separately.

### The payments pod (`deploy/k8s/payments/`)

- `ServiceAccount payments-api` with `automountServiceAccountToken: false`, set again on the pod.
  The `payments` container carries no service account token of any kind.
- Init container `vault-agent-init`: `registry.quayside.example/mirror/hashicorp/vault:1.15.6`, run
  as `vault agent -config=/vault/config/agent.hcl -exit-after-auth` (it logs in, renders once and
  exits 0). Non-root as the image's `vault` user (100:1000), no privilege escalation, read-only root
  filesystem, all capabilities dropped, RuntimeDefault seccomp, small requests and a memory limit.
  The command bypasses the image's entrypoint script, which only matters when starting as root.
  The agent needs no writable path of its own: no pid file, no sink, and the template is written
  through a temporary file next to its destination.
- Its mounts: the agent config (ConfigMap `payments-vault-agent`), the platform CA (ConfigMap
  `platform-ca`, which trust-manager publishes; I don't create it), a projected service account
  token with audience `vault` and a 600 s lifetime (only this container mounts it), and the
  credentials volume.
- `agent.hcl`: the address from `docs/vault.md`, `ca_cert` pointing at the platform CA (TLS
  verification on), kubernetes auto-auth on `auth/k8s-quay-prod-fra1` as role `payments-api`
  with the projected token, no sink (the Vault token never leaves the agent's memory), one template.
- The template writes `/vault/secrets/stripe.json` with each field passed through `toJSON`, so the
  file is valid JSON whatever the values contain (a quote or a backslash in a value would break a
  hand-quoted `"{{ .Data.data.secret_key }}"`), and only the two fields land in the pod. A missing
  field renders as `null`, which the service refuses.
- `stripe-credentials` is an `emptyDir` with `medium: Memory` (tmpfs, never on the node's disk).
  The file is created by uid 100 with mode `0440`; the pod's `fsGroup: 10001` makes its group the
  payments user's group, so `payments` (10001:10001) reads it through the group bit and nobody gets
  "other" bits. `payments` mounts the volume read-only.
- `STRIPE_CREDENTIALS_FILE=/vault/secrets/stripe.json`; the two `secretKeyRef` variables are gone,
  and so is `secret.yaml`.
- `strategy.rollingUpdate.maxUnavailable: 0`: a new pod now depends on Vault to start, so a rollout
  must never take an old pod away before its replacement is ready. If Vault is down during a
  rollout, the rollout stalls instead of shrinking payments.

### The service

- `load_settings` reads `STRIPE_CREDENTIALS_FILE`, the absolute path of a UTF-8 JSON object with
  non-empty string fields `secret_key` and `webhook_secret`; other fields are ignored. It raises
  `ConfigError` when the variable is unset, empty or relative, the file is missing or unreadable
  (a directory too), its content is not UTF-8 JSON or not an object, or a field is missing, not a
  string, empty or only whitespace. It no longer reads either value from the environment, even as
  a fallback: a fallback is how the values would creep back into manifests.
- The leaks are fixed where they were written. `build_service` logged the whole `Settings`, whose
  default dataclass repr printed both values; it now logs the API base and the file's path.
  `StripeClient` logged the request headers on every Stripe error, `Authorization: Bearer <key>`
  included; it now logs method, URL and status. As a second line, the two secret fields of
  `Settings` are `repr=False`. `ConfigError` messages name the path and the field, never the
  content, and parser exceptions are not chained into them.
- Public names and signatures are unchanged; `Settings` gained `credentials_file`.

### Kubernetes access to the workload (`deploy/k8s/access/`)

- Deleted `workloads.yaml`: `system:authenticated` (every person and every pod's token) bound to
  `cluster-reader`, Secrets included. Per `docs/access.md` no workload needs it; the cutover log's
  "service discovery sidecars" don't exist in any manifest.
- Developers: `edit` through RoleBindings in `storefront` and `orders` only, and the built-in `view`
  cluster-wide for looking at pods, logs and events elsewhere. `view` is read-only, has no Secrets,
  no exec, attach or port-forward and no token requests; it shows somewhat more than pods, logs and
  events (Deployments, Services, ConfigMaps), all read-only, and I preferred the maintained
  built-in to a hand-written list. Before, `edit` cluster-wide let any developer exec into a
  payments pod, read its Secrets, start a pod as `payments-api` or mint its token.
- Support: `cluster-reader` (everything, Secrets included: the auditor's one command) is replaced
  by `support-reader`: get/list/watch on pods, `pods/log`, events, deployments and services, which
  is exactly `docs/access.md`. The binding has a new name, `support-readers`, because a binding's
  `roleRef` cannot be changed; `kubectl apply` would fail on the old name, and the pipeline prunes
  the old binding instead.
- In `payments` only `platform/ci-deployer`, `quayside:platform` and `quayside:payments-oncall` can
  now read Secrets, exec/attach/port-forward, change pods or workloads, create tokens,
  impersonate or change RBAC. Prometheus can still list pods there; the dashboard only touches its
  own namespace.

### One home

`ci/pipeline.yaml` no longer maps `PROD_STRIPE_*` into the deploy job, and `ci/deploy.sh` applies
`deploy/k8s/` as it is in git (no `envsubst`, nothing to substitute). README and the deploy
runbook say so, and the Stripe runbook now goes through Vault.

### Choices a reviewer might question, and what I rejected

- **Init container, not a sidecar.** The file must exist before `payments` starts. Native sidecars
  (`restartPolicy: Always` on an init container) are alpha and off on 1.28, so an ordinary sidecar
  would start together with `payments`, which would crash until the file appears. Stage 2 needs
  the values at start only.
- **No Agent Injector** (ADR 0004: no mutating webhooks; the pod spec in git is the pod that runs).
- **Rejected:** the Secrets Store CSI driver and External Secrets Operator (ESO writes the value
  back into a Kubernetes Secret, which is the finding; the CSI driver adds a privileged DaemonSet
  for one secret); the service calling Vault itself (a Vault client and token handling inside a
  stdlib-only payments process); rendering into environment variables through an exec wrapper
  (rule 6); encrypting Secrets at rest in etcd (the finding is read access through the API, not
  etcd's disk).
- **Agent as `vault` (100) plus `fsGroup`, not as 10001.** The standard names the image's user;
  sharing the file through a group keeps the agent and the app separate users.
- **Token lifetime 600 s**, the API server's minimum. It is only used to log in; the kubelet
  rewrites it before it expires.
- **Policy name `payments-api`.** Vault policies are global across clusters; nothing else in Vault
  is named that (staging uses `stg-read`), and the standard wants it named like the role.
- **A relative `STRIPE_CREDENTIALS_FILE` is an error**: the contract says absolute, and a relative
  path would depend on the working directory.

### Go-live: what Finance and on-call do

1. Before merging, Finance confirms `kv/payments/stripe` has both fields
   (`vault kv metadata get -mount=kv payments/stripe` shows the version; the first new payments pod
   refuses to start if a field is missing, and the old pods keep serving).
2. Merge. The pipeline applies Vault first (role and policy created, `smoke-test` and
   `kv-read-all` removed), then the manifests: payments rolls (each new pod reads Vault before it
   starts; old pods stay until the new ones are ready), and the Secret, the old bindings and
   `cluster-reader` are pruned.
3. On-call watches `kubectl -n payments rollout status deployment/payments-api`, makes a test
   charge and checks a webhook delivery shows 200.
4. Platform deletes the masked CI variables `PROD_STRIPE_SECRET_KEY` and
   `PROD_STRIPE_WEBHOOK_SECRET` from the CI settings.
5. Finance rolls **both** values at Stripe and writes them to Vault, and on-call replaces the pods
   (`docs/runbooks/rotate-stripe-key.md`). The current ones must be treated as known: support (the
   auditor), every developer, every pod token and, until stage 1, anyone on the internet could read
   the Secret; any pod on a `default` service account could read it through `smoke-test`; it went
   through every pipeline run; and copies exist outside the cluster (the old Compose host's
   environment, and the etcd snapshot copied to the old host, where Secrets are stored in
   plain text). Platform should wipe the old host and that snapshot copy.
6. Rolling back: once the CI variables are gone, reverting this change fails at the old
   `deploy.sh`'s variable check. Fix forward instead; Vault keeps the values.

### Tests added

- `tests/test_config.py`, rewritten for the file: both fields read, other fields ignored, values
  with `"` and `\`, every fail-closed case of the brief, the environment never supplying a value,
  error messages never quoting the file, settings' repr.
- `tests/test_service.py`: the existing service tests on a credentials file, `build_service`
  failing without one even with the old variables set, and no value in any log record, repr or
  exception message after a Stripe 401 and a bad signature.
- `tests/test_vault_clients.py`: the standard as checks over `vault/` and the manifests (role
  binding and audience, token lifetimes, one exact read-only policy per role, no automounted
  token, the Vault token only in the agents, verified TLS and no sink, a private file on memory,
  pinned image and hardened agents, the init agent exits), and the variable names absent from
  `ci/` and `deploy/`.
- `tests/test_access.py`: nothing bound to everyone, and in `payments` only the pipeline, platform
  and on-call hold anything beyond read access.

## Stage 3

A rolled key now reaches every running pod within about 30 seconds, without a restart, and the
payments pods' reads stay well inside the Vault quota at 40 pods.

### What changed

- **A Vault Agent sidecar**, `vault-agent`, in `containers`: the same pinned image, the same
  config file, the same mounts (projected `vault` token, platform CA, the credentials volume) and
  the same hardening as the init container, but without `-exit-after-auth`, so it keeps running.
  The init container stays: it still renders the file before `payments` starts (native sidecars
  are not available on 1.28), and the sidecar takes over from there. `exit_after_auth` is only on
  the init container's command line, never in the shared config, so the sidecar cannot crash-loop
  by inheriting it.
- **One config for both**, now with `template_config { static_secret_render_interval = "30s" }`.
  A KV v2 secret has no lease, so Vault Agent re-reads it on that interval (consul-template waits a
  random 85% to 95% of it, 25.5 s to 28.5 s, so pods don't read in step) and rewrites the file
  only when the content changed, through a temporary file renamed over the old one.
- **The service follows the file** (`LiveSettings` in `config.py`, one small class). On every
  charge and webhook it stats the file and compares device, inode, size and nanosecond mtime with
  the last file it read; only when they differ does it read the file again, by stage 2's rules. A
  valid file replaces the settings in one step (one immutable `Settings`, so a charge never uses the
  new key with the old signing secret); a missing or invalid file keeps the last valid values and
  logs one warning naming the path and the problem, never a value. There is no timer and no
  thread: the first call after the rename uses the new file. A lock makes the check-and-swap safe
  under `ThreadingHTTPServer`. `PaymentsService` now holds the `LiveSettings` and builds its
  `StripeClient` from the current settings on each charge; `build_service` still fails closed
  through `load_settings`, and the public names and signatures are unchanged.
- The runbook says: write to Vault, wait a minute, check, no restart.

### The numbers

| | Before (stage 2) | After |
|---|---|---|
| Longest a running pod uses a rolled key | until someone replaces the pod: unbounded (11 minutes on Thursday) | one re-read: at most 28.5 s, used from the next request after it |
| Steady Vault reads/s from payments, 3 pods | 0 | 3 / 30 = 0.10 (at most 3 / 25.5 = 0.12) |
| Steady Vault reads/s from payments, 40 pods | 0 | 40 / 30 = 1.33 (at most 40 / 25.5 = 1.57) |
| Reads per pod start | 1 | 2 (init and the sidecar's first render) |

Before, the reads all came at once: the restart on Thursday started 30 pods together, 30 logins
and 30 reads within seconds against a quota of 2 a second, which is the 429s in Vault's audit log.
Logins and token renewals go to `auth/...` and `auth/token/...`, outside the quota's
`kv/data/payments/` path, and are not counted.

Where 30 s comes from. One secret per pod, 40 pods at most (`hpa.yaml`), quota 2 per second
(`kv-payments.json`):

- the quota needs 40 / (0.85 x T) <= 2, so T >= 23.5 s (20 s if Vault Agent read exactly every T);
- the minute needs 0.95 x T well under 60 s, so that a rotation is in use within a minute even
  when one read fails and is retried.

30 s sits between them with room on both sides: the peak is 1.57 reads a second, leaving about
0.4 a second for the two reads every new pod makes during a scale-up or rollout, and the worst
case of 28.5 s leaves a second read inside the minute. 20 s would be at the quota already, and
5 s (an assistant's first suggestion) would be 8 a second at 40 pods.

What it costs: a second Vault Agent per pod (10m CPU and 64 Mi requested; the pod's CPU request,
which the autoscaler's 70% target is measured against, goes from 260m to 270m, which is
negligible); a Vault token per pod kept alive (renewed in the background, a new login at the
4-hour maximum); a steady 1.3 reads a second against the shared Vault at 40 pods; one `stat()` per
request in the service.

### While Vault is unreachable

- **Running pods keep taking payments.** The sidecar's reads fail; it logs them, retries with
  backoff and keeps trying, and it never touches the file, so the service keeps the values it has.
  A key rolled during the outage reaches the pods within about 30 s of Vault answering again, so
  Finance must not expire the old key at Stripe while Vault is down (it is in the runbook). If the
  outage outlasts the agent's token (20 minutes without a renewal), the agent logs in again when
  Vault is back, with the projected token the kubelet keeps fresh. A `payments` container that
  restarts inside a running pod still finds the file: an emptyDir lives as long as the pod.
- **New pods wait.** Their init agent cannot log in or read, keeps retrying, and the pod stays in
  `Init`, not ready and without traffic: it never starts with no key or a stale one. With
  `maxUnavailable: 0` a rollout during the outage stalls rather than replacing serving pods, but
  autoscaler scale-ups add no capacity and a pod lost with its node is not replaced until Vault is
  back. Vault also needs this cluster's API server for logins (token reviews from `203.0.113.60`),
  which stage 1 kept open.

### What I rejected

- A shorter interval for freshness: over the quota (see above). A longer one: over the minute.
- Restarting or signalling the service from the agent (a template `command`): that is a restart,
  and signalling across containers needs a shared process namespace, which would let the agent see
  the payments process.
- Re-reading the file on a timer in the service (stale for up to the timer, and a thread), or on
  every request without the stat (a file read per charge); inotify (not in the standard library,
  not on Windows).
- `exit_on_retry_failure` in the agent: it would turn a Vault outage into a sidecar crash loop.
- Changing the quota or the autoscaler's limits: not ours, and the interval fits.

### Tests added

- `tests/test_reload.py`: after the file is replaced (temp file and rename, as Vault Agent does)
  the next charge uses the new key and the next webhook the new secret; removed, empty, cut-off,
  non-JSON, a list, an empty or missing field all keep the last values until a valid file comes
  back; no old or new value in any log record or repr through all of it; a bad file still stops
  the service at start.
- `tests/test_vault_clients.py`: a sidecar agent without `-exit-after-auth` and no
  `exit_after_auth` in the shared config; the render interval checked against both limits, computed
  from the autoscaler's maximum, the quota file and the agent's 85% stagger.

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

For stage 2 the assistant drafted the Vault files, the agent config and the pod, and most of the
review was correcting it against `docs/vault.md` and the standard. It wrote the policy for
`kv/payments/stripe` (the KV v1 path: on a KV v2 mount it grants nothing a client uses), and when
that failed it reached for `kv/data/payments/*`, which also reads `payments/stripe-connect`. It used
`mount_path = "auth/kubernetes"` (Vault's default, not our `k8s-quay-prod-fra1`), left `audience`
off the role, and proposed the Agent Injector's annotations, which ADR 0004 rules out and which
nothing in the cluster would act on. Its template quoted the values by hand inside JSON, which
breaks on a quote or a backslash; I switched to `toJSON` per field and added a test with both
characters. It suggested a native sidecar (`restartPolicy: Always` on an init container), which
1.28 doesn't enable, and changed the `roleRef` of the existing `support` binding in place, which
the API server refuses, so the deploy would have failed. I checked the KV v2 paths, the role
fields and the agent's `-exit-after-auth`, `ca_cert` and template options against the Vault 1.15
documentation, the projected token's minimum lifetime and `fsGroup` ownership of emptyDir files
against the Kubernetes 1.28 documentation, and went through every binding by hand with
`docs/access.md` open. The leak fixes I found by grepping every logger call and exception message
in the service, not by trusting a summary.

For stage 3 the assistant's first proposal was a 5 s render interval "so rotation is instant",
which at 40 pods is 8 reads a second against a quota of 2; it also put `exit_after_auth = true`
in the shared agent config, which would have made the new sidecar exit after its first render and
crash-loop. Its first reload compared `st_mtime` as a float, which can miss two writes in the same
clock tick on some filesystems, and re-read the file on a background timer; I replaced it with the
identity check on each call (inode, size and nanosecond mtime) and wrote the reload tests by
replacing the file the way Vault Agent does. I worked out the request rates and the bounds on the
interval myself from `hpa.yaml` and `kv-payments.json`, and checked in consul-template's source how
long it waits between reads of a lease-less secret (85% to 95% of the interval), which is why the
quota check in the tests uses 85%.
