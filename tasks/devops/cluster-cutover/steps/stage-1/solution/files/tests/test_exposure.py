"""Nothing answers a caller who has not logged in, and the firewall lets in only what
docs/network.md lists. Each check here would have caught one of the ways in found after the
cutover."""

import ipaddress
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]

VPN = "203.0.113.17/32"
NODE_NETWORK = "10.20.0.0/24"
EVERYONE = "0.0.0.0/0"
CONTROL_PLANE, WORKER = "control-plane", "worker"

# docs/network.md, "Inbound": (sources, roles, protocol, ports). The complete list.
FLOWS = (
    ((EVERYONE,), (WORKER,), "tcp", (80, 443)),
    ((VPN, "203.0.113.40/32", "192.0.2.64/28", "203.0.113.60/32", NODE_NETWORK), (CONTROL_PLANE,), "tcp", (6443,)),
    ((NODE_NETWORK,), (CONTROL_PLANE, WORKER), "tcp", (10250,)),
    ((NODE_NETWORK,), (CONTROL_PLANE, WORKER), "udp", (8472,)),
    ((VPN,), (CONTROL_PLANE, WORKER), "tcp", (22,)),
    ((VPN,), (WORKER,), "tcp", (30443,)),
)

UNAUTHENTICATED = {"system:unauthenticated", "system:anonymous"}


def load_yaml(path):
    with path.open(encoding="utf-8") as handle:
        return [doc for doc in yaml.safe_load_all(handle) if doc is not None]


def k8s_objects():
    for path in sorted((ROOT / "deploy" / "k8s").rglob("*.y*ml")):
        yield from load_yaml(path)


def of_kind(*kinds):
    return [obj for obj in k8s_objects() if obj.get("kind") in kinds]


def kubeadm(kind):
    [doc] = [d for d in load_yaml(ROOT / "infra" / "cluster" / "kubeadm.yaml") if d.get("kind") == kind]
    return doc


# The firewall, evaluated as infra/README.md describes Halyard's rules.

def firewall_rules():
    [doc] = load_yaml(ROOT / "infra" / "firewall" / "rules.yaml")
    for firewall in doc["firewalls"]:
        for rule in firewall["inbound"]:
            low, _, high = str(rule["ports"]).partition("-")
            ports = range(int(low), int(high or low) + 1)
            networks = [ipaddress.ip_network(source) for source in rule["sources"]]
            yield firewall["apply_to"]["role"], rule["protocol"], ports, networks, rule["description"]


def allows(source, role, protocol, port):
    address = ipaddress.ip_address(source)
    return any(r == role and p == protocol and port in ports and any(address in n for n in networks)
               for r, p, ports, networks, _ in firewall_rules())


def a_flow_needs(network, role, protocol, port):
    return any(role in roles and protocol == proto and port in ports
               and any(network.subnet_of(ipaddress.ip_network(s)) for s in sources)
               for sources, roles, proto, ports in FLOWS)


def test_every_rule_is_part_of_a_documented_flow():
    found = []
    for role, protocol, ports, networks, description in firewall_rules():
        for network in networks:
            extra = [port for port in ports if not a_flow_needs(network, role, protocol, port)]
            if extra:
                found.append(f"{role} '{description}': {protocol} {extra[0]} from {network}")
    assert not found, "not in docs/network.md:\n" + "\n".join(found)


@pytest.mark.parametrize("sources, roles, protocol, ports", FLOWS)
def test_every_documented_flow_gets_through(sources, roles, protocol, ports):
    for source in sources:
        sender = str(ipaddress.ip_network(source)[-2 if source == EVERYONE else 0])
        for role in roles:
            for port in ports:
                assert allows(sender, role, protocol, port), f"{protocol} {port} from {source} to {role}"


@pytest.mark.parametrize("port", [22, 2379, 2380, 6443, 10250, 10255, 30000, 30443, 32767])
def test_the_internet_reaches_nothing_but_the_storefront(port):
    for role in (CONTROL_PLANE, WORKER):
        assert not allows("93.184.216.34", role, "tcp", port), f"tcp {port} on {role} nodes"


# The API server and the kubelets.

def test_the_api_server_authorises_with_node_and_rbac():
    args = kubeadm("ClusterConfiguration")["apiServer"]["extraArgs"]
    modes = args.get("authorization-mode", "Node,RBAC").split(",")
    assert "Node" in modes and "RBAC" in modes and "AlwaysAllow" not in modes


def test_kubelets_authenticate_and_authorise_every_request():
    kubelet = kubeadm("KubeletConfiguration")
    authentication = kubelet.get("authentication", {})
    assert authentication.get("anonymous", {}).get("enabled", False) is False
    assert authentication.get("webhook", {}).get("enabled", True) is True
    assert kubelet.get("authorization", {}).get("mode", "Webhook") == "Webhook"
    assert kubelet.get("readOnlyPort", 0) == 0, "the read-only port answers without authentication"


def test_nothing_is_granted_to_callers_who_have_not_logged_in():
    found = [binding["metadata"]["name"] for binding in of_kind("ClusterRoleBinding", "RoleBinding")
             if any(s.get("name") in UNAUTHENTICATED for s in binding.get("subjects") or [])]
    assert not found, f"bound to callers without credentials: {found}"


# The dashboard.

def dashboard_containers():
    [deployment] = [d for d in of_kind("Deployment") if d["metadata"]["name"] == "kubernetes-dashboard"]
    return deployment["spec"]["template"]["spec"]["containers"]


def test_the_dashboard_asks_everyone_to_log_in():
    for container in dashboard_containers():
        arguments = [str(a) for a in container.get("command", []) + container.get("args", [])]
        assert not any(a.startswith("--enable-skip-login") for a in arguments)


def test_the_dashboard_account_has_no_cluster_wide_role():
    found = [b["metadata"]["name"] for b in of_kind("ClusterRoleBinding")
             if any(s.get("kind") == "ServiceAccount" and s.get("namespace") == "kubernetes-dashboard"
                    for s in b.get("subjects") or [])]
    assert not found, f"cluster-wide bindings for the dashboard: {found}"


def test_support_still_reaches_the_dashboard_over_the_vpn_only():
    [service] = [s for s in of_kind("Service") if s["metadata"]["name"] == "kubernetes-dashboard"]
    assert [p.get("nodePort") for p in service["spec"]["ports"]] == [30443]
    assert allows("203.0.113.17", WORKER, "tcp", 30443)
    assert not allows("93.184.216.34", WORKER, "tcp", 30443)
