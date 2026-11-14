"""Stage 1: the Halyard firewall lets in the flows docs/network.md lists and no others."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

import pytest  # noqa: E402

from sim.firewall import INTERNET, PROBE_PORTS, TRUSTED_ADDRESSES, blocked_flows  # noqa: E402
from sim.firewall import openings_beyond_flows  # noqa: E402

pytest_plugins = ("sim.fixtures",)

PORT_FAMILIES = {
    "api": (("tcp", 6443),),
    "kubelet-ports": (("tcp", 10250), ("tcp", 10255), ("tcp", 10256)),
    "etcd": (("tcp", 2379), ("tcp", 2380)),
    "ssh": (("tcp", 22),),
    "nodeport-range": (("tcp", 30000), ("tcp", 30080), ("tcp", 30443), ("tcp", 32767)),
}
PORT_FAMILIES["everything-else"] = tuple(
    p for p in PROBE_PORTS if not any(p in family for family in PORT_FAMILIES.values()))


@pytest.mark.parametrize("family", list(PORT_FAMILIES))
def test_the_internet_gets_nothing_beyond_the_storefront(world, family):
    found = openings_beyond_flows(world.firewall, INTERNET, PORT_FAMILIES[family])
    assert not found, "\n".join(found)


def test_trusted_networks_get_nothing_beyond_their_listed_flows(world):
    found = openings_beyond_flows(world.firewall, TRUSTED_ADDRESSES, PROBE_PORTS)
    assert not found, "\n".join(found)


def test_every_listed_flow_still_gets_through(world):
    found = blocked_flows(world.firewall)
    assert not found, "\n".join(found)
