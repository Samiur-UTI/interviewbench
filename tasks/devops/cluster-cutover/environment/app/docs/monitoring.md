# Monitoring

## Statusbeat

Statusbeat is our uptime service (SaaS). For the cluster it sends a plain HTTPS `GET /readyz` to
the API endpoint every minute, from its probe range (`docs/network.md`). It cannot present a token
or a client certificate. When the check fails twice in a row it pages platform on-call.

It also checks the storefront's home page; that one goes through the ingress like any visitor.

## Prometheus

`monitoring/prometheus`, one replica, data on an emptyDir (15 days, lost on restart).

- Discovers pods, services, endpoints and nodes through the API server.
- Scrapes every kubelet's `/metrics` and `/metrics/cadvisor` on port 10250, over the node network,
  authenticating with its service account token.
- Scrapes pods that carry the `prometheus.io/scrape: "true"` annotation.
