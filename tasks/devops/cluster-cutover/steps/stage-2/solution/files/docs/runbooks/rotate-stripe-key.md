# Runbook: rolling the Stripe keys

Payments on-call, with Finance (they hold the Stripe dashboard and write the values to Vault).

The two values live in the platform Vault and nowhere else: `kv/payments/stripe`, fields
`secret_key` and `webhook_secret`. Each payments pod reads them once, when it starts (Vault Agent
renders them into a file in the pod's memory). A running pod does not see a change until it is
replaced. Nothing in CI holds them: there is nothing to change in the pipeline.

1. Finance rolls the secret key in the Stripe dashboard, and the webhook signing secret if that is
   being rolled too. Unless the old key is known to be exposed, give it an expiry that leaves time
   for the steps below (an hour is plenty).
2. Finance writes the new value to Vault, keeping the other field as it is. Reading the value
   from standard input keeps it out of the shell history:

   ```bash
   vault login -method=oidc
   vault kv patch -mount=kv payments/stripe secret_key=-       # paste the key, Enter, Ctrl-D
   vault kv patch -mount=kv payments/stripe webhook_secret=-   # only if it was rolled
   ```

   Never put either value in a file in git, a ticket or chat.
3. Replace the payments pods so they read it:

   ```bash
   kubectl -n payments rollout restart deployment/payments-api
   kubectl -n payments rollout status deployment/payments-api
   ```

   A new pod starts only once it has read the values from Vault; the old pods keep serving until
   their replacements are ready. If the rollout hangs with pods in `Init`, look at the init
   container's log (`kubectl -n payments logs <pod> -c vault-agent-init`): usually Vault is
   unreachable or the secret is missing a field. Nothing is lost while it hangs.
4. Make a test charge with the staff test card and check it in the Stripe dashboard. Check that
   the next webhook delivery shows 200 in Stripe's webhook log.
5. If the old key was given an expiry, expire it now at Stripe.
