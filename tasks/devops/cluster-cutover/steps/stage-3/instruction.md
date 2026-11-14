# Rotate without restarts

Finance rolled the Stripe key on Thursday and, because the old one had been exposed, expired it
at once. Vault had the new key within the minute. Every payments pod kept using the old one, and
every card payment failed for eleven minutes, until someone found the runbook and restarted the
Deployment. Restarting 30 pods at once also made all of them read the secret within the same few
seconds, and Vault's audit log shows the platform's rate limit rejecting some of those reads.

Product's requirement: a rolled key is in use everywhere within a minute, and nobody restarts
anything. The platform team's requirement: stay inside the Vault quota they have set, at any size
the Deployment can scale to.

## What must hold afterwards

### Running pods follow Vault

- After `payments/stripe` changes in Vault, every running payments pod uses the new values within
  60 seconds, whenever in a pod's life the change happens. No container restarts and no pod is
  replaced.
- That goes for both fields: charges are sent with the new secret key and webhooks are verified
  with the new signing secret.
- The pod stays healthy: every container in it keeps running. A container that exits and is
  restarted by the kubelet is a crash loop, not a design.

### Inside the quota

- With the Deployment at the largest size its autoscaler allows, the payments pods' periodic reads
  of the secret together stay at or under the rate-limit quota for `payments` in `vault/`. Count
  one read per secret an agent's templates use, per agent, per render interval; logins and token
  renewals are not counted.
- The quota and the autoscaler's limits are not yours to change.

### The service

- `build_service` still fails closed at start, exactly as in stage 2.
- Once running, the service follows the file. The first `charge` or `handle_webhook` after the
  credentials file has been replaced (the agent writes a new file and renames it over the old one)
  uses the new values: no timer to wait for, no restart.
- If the file is missing, unreadable or invalid by stage 2's rules when the service looks at it,
  the service keeps the last valid values and keeps serving; it picks up the next valid file. It
  never sends Stripe an empty or half-read key.
- Stage 2's rule on logs, `repr()` and exception messages covers the old values as much as the
  new ones.

### Nothing given back

- Everything stages 1 and 2 established still holds, for every container that talks to Vault:
  the standard for Vault clients, the cold start, who can reach what.

## How your work is checked

As in stage 2, with a clock. The hidden tests start a payments pod, change `payments/stripe` in
their Vault, move the clock forward and make charges and deliver webhooks through the running
service, at several points in the pod's life. The agent model now also runs over time: an agent
that keeps running reads each static secret its templates use again every
`static_secret_render_interval` of its `template_config` (Vault Agent's default when it is not
set), and when the content has changed it writes the new file and renames it into place. An agent
with `exit_after_auth` exits after its first render, wherever it runs.

They also drive the service on its own: they replace, remove and corrupt the credentials file
between calls.

Run the repo's own tests with `python -m pytest`. In `NOTES.md`, give the numbers before and
after: the longest a pod can keep using a rolled key, and Vault requests per second from payments
at the smallest and the largest Deployment size. Explain what you chose and what it costs, what
happens to running pods and to new pods while Vault is unreachable, and how you used AI
assistance and what you checked yourself. Update `docs/runbooks/rotate-stripe-key.md` to match.
