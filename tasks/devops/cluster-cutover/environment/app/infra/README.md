# infra

What sits underneath the cluster.

## `nodes.yaml`

The cluster's VMs on Halyard Cloud: name, role, private and public address, size. Each VM is
tagged in Halyard with its `role`; firewalls attach to VMs by role.

## `firewall/rules.yaml`

The Halyard firewalls, applied by `ci/apply-firewall.sh` (`halyard firewall apply`).

```yaml
firewalls:
  - name: <firewall name>
    apply_to: {role: <node role>}
    inbound:
      - description: <free text>
        protocol: tcp            # tcp or udp
        ports: "6443"            # one port, or an inclusive range "low-high"
        sources: ["<CIDR>", ...]
```

How Halyard evaluates it:

- A node gets every firewall whose `apply_to.role` equals the node's role in `nodes.yaml`.
- Inbound traffic to a node is dropped unless one rule of one of its firewalls allows it. A rule
  allows a packet when the `protocol` is the same (`tcp` or `udp`), the destination port equals
  `ports` or is inside its `"low-high"` range, and the source address is inside one of the
  `sources` CIDRs.
- Outbound traffic, and replies to it, are always allowed.
- There are no deny rules and no ordering.

## `cluster/kubeadm.yaml`

The configuration `kubeadm init`, `kubeadm join` and `kubeadm upgrade` are run with, on every node:
the cluster configuration (API server, networking) and the kubelet configuration every node's
kubelet runs with. It is applied by hand on the nodes, not by the pipeline.
