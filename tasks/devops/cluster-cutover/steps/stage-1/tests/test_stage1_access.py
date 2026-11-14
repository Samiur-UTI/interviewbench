"""Stage 1: nothing lends its identity to a caller who hasn't logged in, and everyone in
docs/access.md keeps what they have."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

from sim.checks import developer_access_problems, granted, missing  # noqa: E402
from sim.checks import support_access_problems  # noqa: E402
from sim.dashboard import NAMESPACE as DASHBOARD_NAMESPACE  # noqa: E402
from sim.firewall import INTERNET, TRUSTED  # noqa: E402
from sim.personas import CI_DEPLOYER, ONCALL, PLATFORM, ci_deployer_needs, cluster_changes  # noqa: E402
from sim.personas import oncall_needs, outside_namespace_changes, platform_needs  # noqa: E402

pytest_plugins = ("sim.fixtures",)

DASHBOARD_PORT = 30443


def test_a_dashboard_visitor_who_has_not_logged_in_acts_as_nobody(world):
    visitor = world.dashboard.visitor_identity()
    assert visitor is None, f"a dashboard visitor who skips login acts as {visitor}"


def test_the_dashboard_cannot_change_anything_outside_its_namespace(world):
    account = world.dashboard.service_account()
    found = []
    if account is not None:
        found += granted(world, account, cluster_changes())
        for namespace in world.manifests.namespaces():
            if namespace != DASHBOARD_NAMESPACE:
                found += granted(world, account, outside_namespace_changes(namespace))
    assert not found, "\n".join(found)


def test_support_still_reaches_the_dashboard_over_the_vpn_only(world):
    found = []
    if world.dashboard.deployment is None:
        found.append("there is no Deployment kubernetes-dashboard in kubernetes-dashboard")
    if DASHBOARD_PORT not in world.dashboard.node_ports():
        found.append(f"no NodePort Service exposes the dashboard on {DASHBOARD_PORT}")
    vpn = TRUSTED["the VPN"][0]
    if not world.firewall.allows(vpn, "worker", "tcp", DASHBOARD_PORT):
        found.append(f"tcp {DASHBOARD_PORT} to the workers is dropped from the VPN")
    found += [f"tcp {DASHBOARD_PORT} on the workers is open to {ip}" for ip in INTERNET
              if world.firewall.allows(ip, "worker", "tcp", DASHBOARD_PORT)]
    assert not found, "\n".join(found)


def test_the_pipeline_can_still_deploy(world):
    found = missing(world, CI_DEPLOYER, ci_deployer_needs())
    assert not found, "\n".join(found)


def test_developers_keep_their_access(world):
    found = developer_access_problems(world)
    assert not found, "\n".join(found)


def test_support_keeps_read_access_everywhere(world):
    found = support_access_problems(world)
    assert not found, "\n".join(found)


def test_payments_oncall_keeps_admin_in_payments(world):
    found = missing(world, ONCALL, oncall_needs())
    assert not found, "\n".join(found)


def test_platform_keeps_cluster_admin(world):
    found = missing(world, PLATFORM, platform_needs())
    assert not found, "\n".join(found)


def test_vault_can_still_review_tokens_against_the_cluster(world):
    problem = world.token_review_problem(world.cluster.cluster_name)
    assert problem is None, f"Vault cannot review this cluster's tokens: {problem}"
