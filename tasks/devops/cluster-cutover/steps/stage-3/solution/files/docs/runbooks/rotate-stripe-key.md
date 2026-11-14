# Runbook: rolling the Stripe keys

Payments on-call, with Finance (they hold the Stripe dashboard and write the values to Vault).

The two values live in the platform Vault and nowhere else: `kv/payments/stripe`, fields
`secret_key` and `webhook_secret`. Every payments pod has a Vault Agent next to it that reads the
secret again every 30 seconds and rewrites the pod's credentials file when it changed; the service
uses the new file from the next charge or webhook on. Nobody restarts anything. Nothing in CI
holds the values: there is nothing to change in the pipeline.

1. Finance rolls the secret key in the Stripe dashboard, and the webhook signing secret if that is
   being rolled too. If the old key is exposed, expire it at once: payments fail for at most
   about 30 seconds, until every pod has read the new key. Otherwise give it a short expiry (15
   minutes) so that no charge fails at all.
2. Finance writes the new value to Vault, keeping the other field as it is. Reading the value
   from standard input keeps it out of the shell history:

   ```bash
   vault login -method=oidc
   vault kv patch -mount=kv payments/stripe secret_key=-       # paste the key, Enter, Ctrl-D
   vault kv patch -mount=kv payments/stripe webhook_secret=-   # only if it was rolled
   ```

   Never put either value in a file in git, a ticket or chat.
3. Wait one minute. Do not restart the Deployment: it gains nothing, and 30 or 40 pods starting
   together read Vault at once and run into the payments rate limit.
4. Make a test charge with the staff test card and check it in the Stripe dashboard. Check that
   the next webhook delivery shows 200 in Stripe's webhook log. Each pod logs
   `new Stripe credentials read from /vault/secrets/stripe.json` when it switches:

   ```bash
   kubectl -n payments logs -l app=payments-api -c payments --since=5m --tail=-1 | grep 'new Stripe credentials'
   ```

5. If the old key was given an expiry, expire it now at Stripe.

## If the pods do not pick it up

- The agents log every failed read (`kubectl -n payments logs <pod> -c vault-agent`). While Vault
  cannot be reached, running pods keep charging with the values they have; they switch within 30
  seconds of Vault answering again. So do not expire the old key at Stripe while Vault is down.
- A credentials file that is missing or invalid (a field left empty in Vault, say) is ignored: the
  pods keep the last valid values and log `keeping the last valid Stripe credentials`. Fix the
  secret in Vault; the next valid file is used at once.
- New pods cannot start while Vault is unreachable (they wait in `Init` until they have the
  values); the running ones keep serving.
