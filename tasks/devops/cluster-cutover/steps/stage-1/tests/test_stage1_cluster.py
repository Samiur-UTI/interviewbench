"""Stage 1: no credentials, no answer, from the API server and the kubelets; the probes and
scrapers that depend on them keep working."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

from sim.checks import anonymous_api_answers, missing  # noqa: E402
from sim.firewall import TRUSTED  # noqa: E402
from sim.kubelet import SECURE_PORT, node_request  # noqa: E402
from sim.personas import DEVELOPER, PROMETHEUS, STOREFRONT_DEFAULT  # noqa: E402
from sim.rbac import NonResourceRequest, ResourceRequest  # noqa: E402

pytest_plugins = ("sim.fixtures",)

KUBELET_PROBES = (
    ("GET", "/pods"), ("GET", "/runningpods/"), ("GET", "/metrics"), ("GET", "/metrics/cadvisor"),
    ("GET", "/stats/summary"), ("GET", "/logs/"), ("GET", "/spec/"), ("GET", "/configz"),
    ("POST", "/exec/storefront/storefront-6d4cf56db6-abcde/storefront?command=id"),
    ("POST", "/run/storefront/storefront-6d4cf56db6-abcde/storefront"),
)
NODE_ROLES = ("control-plane", "worker")


def test_a_request_without_credentials_gets_nothing_but_health_and_version(world):
    found = anonymous_api_answers(world)
    assert not found, "\n".join(found)


def test_statusbeat_still_gets_readyz_without_credentials(world):
    found = [f"tcp 6443 from Statusbeat's {ip} is dropped" for ip in TRUSTED["Statusbeat"]
             if not world.firewall.allows(ip, "control-plane", "tcp", 6443)]
    if not world.apiserver.answers(None, NonResourceRequest("get", "/readyz")):
        found.append("GET /readyz without credentials is refused")
    assert not found, "\n".join(found)


def test_the_api_server_still_authorises_with_node_and_rbac(world):
    modes = world.cluster.apiserver.authorization_modes
    assert "Node" in modes and "RBAC" in modes and "AlwaysAllow" not in modes, (
        f"the API server authorises with {','.join(modes) or 'nothing'}")


def test_a_kubelet_answers_no_request_without_credentials(world):
    answered = [f"{method} {path}" for method, path in KUBELET_PROBES
                if world.kubelet.answers(SECURE_PORT, None, method, path)]
    assert not answered, "without credentials, a kubelet on 10250 answers: " + ", ".join(answered)


def test_a_kubelet_answers_only_what_rbac_allows(world):
    found = []
    for identity in (STOREFRONT_DEFAULT, DEVELOPER):
        for method, path in KUBELET_PROBES:
            allowed = world.apiserver.authorize(identity, node_request(method, path, world.kubelet.node))
            if not allowed and world.kubelet.answers(SECURE_PORT, identity, method, path):
                found.append(f"{identity} gets {method} {path} answered, which RBAC does not allow")
    assert not found, "\n".join(found)


def test_no_kubelet_port_answers_without_authentication(world):
    ports = world.kubelet.unauthenticated_ports()
    assert not ports, f"a kubelet answers anyone, without authentication, on port {ports[0]}"


def test_prometheus_still_scrapes_every_kubelet(world):
    found = [f"GET {path} with Prometheus's token is refused"
             for path in ("/metrics", "/metrics/cadvisor")
             if not world.kubelet.answers(SECURE_PORT, PROMETHEUS, "GET", path)]
    found += [f"tcp 10250 to {role} nodes is dropped from the node network"
              for role in NODE_ROLES if not world.firewall.allows("10.20.0.22", role, "tcp", 10250)]
    assert not found, "\n".join(found)


def test_prometheus_still_discovers_its_targets(world):
    needs = [ResourceRequest(verb, resource) for resource in ("pods", "services", "endpoints", "nodes")
             for verb in ("list", "watch")]
    found = missing(world, PROMETHEUS, needs)
    assert not found, "\n".join(found)
