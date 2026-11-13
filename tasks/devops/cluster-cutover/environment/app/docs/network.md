# Network

## Addresses

| What | Address |
|---|---|
| Node network (Halyard private network) | `10.20.0.0/24` |
| Pod network | `10.244.0.0/16` |
| Service network | `10.96.0.0/12` |
| API endpoint | `api.quay-prod.quayside.example:6443` |
| Office VPN egress | `203.0.113.17/32` |
| CI runners' egress | `203.0.113.40/32` |
| Statusbeat probes | `192.0.2.64/28` |
| Platform Vault egress | `203.0.113.60/32` |

| Node | Role | Private | Public |
|---|---|---|---|
| `cp-1` | control-plane | `10.20.0.10` | `198.51.100.10` |
| `w-1` | worker | `10.20.0.21` | `198.51.100.21` |
| `w-2` | worker | `10.20.0.22` | `198.51.100.22` |
| `w-3` | worker | `10.20.0.23` | `198.51.100.23` |

The API endpoint resolves to `198.51.100.10` from outside and to `10.20.0.10` inside the node
network (Halyard private DNS).

## Inbound

This is the complete list. Anything not listed here should not get through the Halyard firewall.

| # | From | To | Port | Why |
|---|---|---|---|---|
| 1 | anyone | workers | tcp 80, 443 | The storefront, through the ingress controller. |
| 2 | VPN, CI runners, Statusbeat, platform Vault, node network | control plane | tcp 6443 | The API server: kubectl, deploys, the uptime probe, Vault's token reviews, kubelets and pods. |
| 3 | node network | every node | tcp 10250 | Kubelet API: the API server (logs, exec) and Prometheus. |
| 4 | node network | every node | udp 8472 | Flannel VXLAN, pod traffic between nodes. |
| 5 | VPN | every node | tcp 22 | ssh. |
| 6 | VPN | workers | tcp 30443 | The dashboard (NodePort) for support. |

Nothing reaches etcd (2379-2380) from outside cp-1: etcd is local to cp-1 and backups run on it.
