"""The Halyard cloud firewall (SPEC sections 2.2 and 3.1) and the flows docs/network.md lists.

A node gets every firewall whose `apply_to.role` is its role. Inbound traffic is dropped unless a
rule of one of those firewalls has the same protocol, a `ports` value (a port or "low-high")
that covers the destination port, and a source CIDR that contains the sender. A malformed rule
allows nothing; an IPv6 source never matches an IPv4 sender.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .k8s import as_dict, as_list
from .repo import RepoError, load_yaml_documents

RULES_FILE = Path("infra") / "firewall" / "rules.yaml"
ROLES = ("control-plane", "worker")

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


@dataclass(frozen=True)
class InboundRule:
    protocol: str
    low: int
    high: int
    sources: tuple[Network, ...]

    def allows(self, source: ipaddress.IPv4Address, protocol: str, port: int) -> bool:
        return (
            self.protocol == protocol
            and self.low <= port <= self.high
            and any(net.version == 4 and source in net for net in self.sources)
        )


def _ports(value: Any) -> tuple[int, int] | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        low = high = value
    elif isinstance(value, str):
        low_text, _, high_text = value.strip().partition("-")
        if not low_text.strip().isdigit() or (high_text and not high_text.strip().isdigit()):
            return None
        low = int(low_text)
        high = int(high_text) if high_text else low
    else:
        return None
    return (low, high) if 0 <= low <= high <= 65535 else None


def parse_rule(raw: Any) -> InboundRule | None:
    """The rule, or None when it is malformed (a malformed rule allows nothing)."""
    raw = as_dict(raw)
    protocol = raw.get("protocol")
    ports = _ports(raw.get("ports"))
    sources = raw.get("sources")
    if not isinstance(protocol, str) or protocol.lower() not in ("tcp", "udp") or ports is None:
        return None
    if not isinstance(sources, list):
        return None
    networks = []
    for source in sources:
        try:
            networks.append(ipaddress.ip_network(str(source).strip(), strict=False))
        except ValueError:
            return None
    return InboundRule(protocol.lower(), ports[0], ports[1], tuple(networks))


class Firewall:
    """Inbound rules per node role."""

    def __init__(self, rules: dict[str, list[InboundRule]]) -> None:
        self._rules = rules

    @classmethod
    def load(cls, root: Path) -> Firewall:
        firewalls: list[Any] = []
        found = False
        for document in load_yaml_documents(root / RULES_FILE, root):
            if isinstance(document, dict) and isinstance(document.get("firewalls"), list):
                found = True
                firewalls.extend(document["firewalls"])
        if not found:
            raise RepoError(f"{RULES_FILE.as_posix()}: has no `firewalls` list")
        rules: dict[str, list[InboundRule]] = {}
        for firewall in firewalls:
            role = as_dict(as_dict(firewall).get("apply_to")).get("role")
            parsed = [parse_rule(raw) for raw in as_list(as_dict(firewall).get("inbound"))]
            rules.setdefault(str(role), []).extend(r for r in parsed if r is not None)
        return cls(rules)

    def allows(self, source: str, role: str, protocol: str, port: int) -> bool:
        address = ipaddress.ip_address(source)
        return any(rule.allows(address, protocol, port) for rule in self._rules.get(role, []))


# The six inbound flows of docs/network.md (SPEC section 1).
VPN = "203.0.113.17/32"
CI_RUNNERS = "203.0.113.40/32"
STATUSBEAT = "192.0.2.64/28"
VAULT = "203.0.113.60/32"
NODE_NETWORK = "10.20.0.0/24"
ANYWHERE = "0.0.0.0/0"


@dataclass(frozen=True)
class Flow:
    name: str
    sources: tuple[str, ...]
    roles: tuple[str, ...]
    protocol: str
    ports: tuple[int, ...]

    def covers(self, source: str, role: str, protocol: str, port: int) -> bool:
        address = ipaddress.ip_address(source)
        return (
            role in self.roles
            and protocol == self.protocol
            and port in self.ports
            and any(address in ipaddress.ip_network(net) for net in self.sources)
        )


FLOWS = (
    Flow("storefront", (ANYWHERE,), ("worker",), "tcp", (80, 443)),
    Flow("Kubernetes API", (VPN, CI_RUNNERS, STATUSBEAT, VAULT, NODE_NETWORK), ("control-plane",),
         "tcp", (6443,)),
    Flow("kubelet", (NODE_NETWORK,), ROLES, "tcp", (10250,)),
    Flow("flannel VXLAN", (NODE_NETWORK,), ROLES, "udp", (8472,)),
    Flow("ssh", (VPN,), ROLES, "tcp", (22,)),
    Flow("dashboard", (VPN,), ("worker",), "tcp", (30443,)),
)

# Probe sets (SPEC section 3.1).
INTERNET = ("1.1.1.1", "93.184.216.34", "198.51.100.200", "203.0.113.99", "192.0.2.10", "192.0.2.90")
TRUSTED = {
    "the VPN": ("203.0.113.17",),
    "the CI runners": ("203.0.113.40",),
    "the platform Vault": ("203.0.113.60",),
    "Statusbeat": ("192.0.2.64", "192.0.2.79"),
    "the node network": ("10.20.0.10", "10.20.0.22", "10.20.0.200"),
}
TRUSTED_ADDRESSES = tuple(ip for ips in TRUSTED.values() for ip in ips)
TCP_PORTS = (22, 80, 443, 2379, 2380, 6443, 8001, 8443, 9100, 10250, 10255, 10256, 30000, 30080,
             30443, 32767)
PROBE_PORTS = tuple(("tcp", p) for p in TCP_PORTS) + (("udp", 53), ("udp", 8472))


def expected_open(source: str, role: str, protocol: str, port: int) -> bool:
    """Whether one of the six flows lets this traffic in."""
    return any(flow.covers(source, role, protocol, port) for flow in FLOWS)


def openings_beyond_flows(firewall: Firewall, sources: tuple[str, ...],
                          ports: tuple[tuple[str, int], ...]) -> list[str]:
    """Every probe the firewall lets in although no listed flow needs it."""
    found = []
    for role in ROLES:
        for protocol, port in ports:
            open_to = [ip for ip in sources if firewall.allows(ip, role, protocol, port)
                       and not expected_open(ip, role, protocol, port)]
            if open_to:
                found.append(f"{protocol} {port} on {role} nodes is open to {', '.join(open_to)}")
    return found


def blocked_flows(firewall: Firewall) -> list[str]:
    """Every probe that a listed flow needs and the firewall drops."""
    found = []
    for flow in FLOWS:
        senders = [ip for ip in INTERNET + TRUSTED_ADDRESSES
                   if any(ipaddress.ip_address(ip) in ipaddress.ip_network(n) for n in flow.sources)]
        for role in flow.roles:
            for port in flow.ports:
                dropped = [ip for ip in senders if not firewall.allows(ip, role, flow.protocol, port)]
                if dropped:
                    found.append(f"{flow.name}: {flow.protocol} {port} to {role} nodes is dropped "
                                 f"from {', '.join(dropped)}")
    return found
