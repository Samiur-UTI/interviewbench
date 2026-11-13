# Runbook: rolling the Stripe keys

Payments on-call, with Finance (they hold the Stripe dashboard).

1. Finance rolls the secret key in the Stripe dashboard, and the webhook signing secret if that is
   being rolled too. Stripe lets the old key live on for a while; pick an expiry that leaves time
   for the steps below.
2. In the CI settings, set the masked variables `PROD_STRIPE_SECRET_KEY` and
   `PROD_STRIPE_WEBHOOK_SECRET` to the new values.
3. Re-run the `deploy` job of the latest `main` pipeline.
4. Restart the service so it reads the new values:

   ```bash
   kubectl -n payments rollout restart deployment/payments-api
   kubectl -n payments rollout status deployment/payments-api
   ```

5. Make a test charge with the staff test card and check it in the Stripe dashboard. Check that
   the next webhook delivery shows 200 in Stripe's webhook log.
