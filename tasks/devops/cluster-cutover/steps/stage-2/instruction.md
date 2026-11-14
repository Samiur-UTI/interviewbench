# The Stripe key leaves Kubernetes

The auditor we hired after last week's incident sent one more finding. Logged in with a support
agent's account, they ran one command:

```
kubectl -n payments get secret payments-stripe -o jsonpath='{.data.STRIPE_SECRET_KEY}' | base64 -d
```

and had our live Stripe key. A Kubernetes Secret is encoded, not encrypted: whoever can read
Secrets in the namespace has the key, and so does whoever can get into a payments pod or start
one. The same value also passes through the pipeline on every deploy.

Security's decision: the two Stripe values (the secret key and the webhook signing secret) live in
the platform Vault and nowhere else. The payments pods fetch them from Vault with Vault Agent when
they start. Finance has already stored both in Vault's KV store as `payments/stripe`, fields
`secret_key` and `webhook_secret`, and will roll both at Stripe once your change is live. Build it:
Vault's configuration, the manifests, the pipeline and the payments service.

## What must hold afterwards

### One home for the two values

- Neither value is in a Kubernetes Secret, a ConfigMap, an environment variable, a manifest or the
  pipeline. The names `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` no longer appear in `ci/` or
  `deploy/` (comments aside).

### Vault

- The payments pods can read `payments/stripe` from Vault. No other identity that can log in to
  Vault through any auth mount configured in `vault/` can.
- The token a payments pod gets can read that one secret and do nothing else in Vault beyond what
  Vault's `default` policy gives every token.
- The role, the policy and the pod meet the platform's standard for Vault clients
  (`docs/standards/vault-clients.md`), and use the platform Vault as `docs/vault.md` describes it.
- Your Vault changes are files in `vault/`, in the format `vault/README.md` describes.

### The payments pod

- The Deployment stays `payments-api` in the `payments` namespace and its application container
  stays `payments`. Its pods run under a service account of their own, declared in the manifests.
- On a cold start the credentials are in place before the `payments` container starts: no crash
  loop while something else catches up, and no pod that hangs before it starts.
- The service reads `STRIPE_CREDENTIALS_FILE`: the absolute path of a UTF-8 JSON file holding an
  object with the string fields `secret_key` and `webhook_secret` (other fields are ignored). It no
  longer reads either value from the environment.
- It fails closed. `load_settings` (and so `build_service`) raises `ConfigError` when the variable
  is unset or empty, the file is missing or unreadable, its content is not a JSON object, or
  either field is missing, not a string, or empty.
- Neither value ever appears in a log record at any level, in the `repr()` or `str()` of the
  settings or the service, or in the message of an exception the service raises.

### Who can get at it through Kubernetes

- In the `payments` namespace only the deploy pipeline (`platform/ci-deployer`), the platform
  admins and `quayside:payments-oncall` may do anything that yields the workload's identity or its
  memory: read Secrets; exec, attach or port-forward into pods; create, change or delete pods or
  the workloads that create them; create service account tokens; impersonate service accounts;
  create or change roles and role bindings.
- Everyone and everything else (developers, support, every other workload's service account,
  including the `default` one in `payments`) is read-only there at most, and keeps the read
  access `docs/access.md` says they need there (pods, their logs, events; for support also
  deployments and services). Outside `payments` they keep what `docs/access.md` says they need.
- Everything stage 1 closed stays closed, and everything it kept working still works.

## How your work is checked

Still without a cluster or a Vault. The hidden tests:

- build a Vault from the `vault/` tree: mounts, auth mounts, roles, quotas and ACL policies, with
  Vault's rules for matching policy paths. They store `payments/stripe` and other teams' secrets in
  it themselves;
- build a payments pod from your manifests on the cluster `infra/cluster/kubeadm.yaml` describes
  (a Kubernetes feature that is not on by default in that version does not exist), with its
  volumes, its service account tokens and each container's user;
- run every container whose command line (`command`, `args` or both) is
  `vault agent -config=<file>` with a model of Vault Agent: it reads the HCL config from the files
  mounted into that container, connects to Vault with the address and CA it is given, logs in with
  the `kubernetes` auto-auth method using the token file it is pointed at (Vault reviews that
  token against the cluster, as in stage 1), and renders each `template` block to its
  `destination` with its `perms`. A rendered file belongs to the agent container's user, and to
  the pod's `fsGroup` when it has one, otherwise to that user's group. The template renderer
  knows `{{ with secret "<path>" }}`, `{{ end }}`, field access (`.Data.data.<field>`,
  `index .Data.data "<field>"`), `toJSON` as a pipe or a call (`<value> | toJSON`,
  `toJSON <value>`), and the `{{-` / `-}}` trim markers. Keep templates to those;
- then start the payments service the way the container would: `build_service` with the
  container's environment and a fake Stripe transport, reading the file the agent rendered as the
  container's user. They make a charge, deliver a signed webhook, and look at what Stripe was sent;
- try to log in to Vault as other service accounts, and with other tokens, through every role in
  `vault/`;
- evaluate RBAC for the people and workloads in `docs/access.md`.

The HCL reader handles blocks, attributes, strings, numbers, booleans, lists, objects, heredocs
and comments. It has no functions and no interpolation.

The hidden tests import `payments.config` (`load_settings`, `ConfigError`), `payments.service`
(`build_service`), `payments.webhooks` (`SignatureError`) and `payments.stripe_api`
(`StripeError`) from `services/payments/`. Keep those names and signatures, and the `Transport`
call shape.

Run the repo's own tests with `python -m pytest`. In `NOTES.md`, explain the design, each choice a
reviewer might question and what you rejected, what Finance and on-call have to do when this goes
live, and how you used AI assistance and what you checked yourself.
