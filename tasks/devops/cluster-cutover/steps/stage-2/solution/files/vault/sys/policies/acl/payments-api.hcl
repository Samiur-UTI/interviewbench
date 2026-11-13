# The payments pods (role payments-api on auth/k8s-quay-prod-fra1): the Stripe secret key and
# webhook signing secret, read only. kv/ is KV version 2, so a read of payments/stripe is a read
# of kv/data/payments/stripe.
path "kv/data/payments/stripe" {
  capabilities = ["read"]
}
