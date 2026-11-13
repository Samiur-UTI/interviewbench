"""Stage 3: nothing given back. Stage 2's rules for Vault clients hold for every container in
the payments pod that talks to Vault, and stage 1's firewall still holds."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

from sim import checks  # noqa: E402

pytest_plugins = ("sim.fixtures",)


def test_every_vault_agent_reaches_the_platform_vault_and_verifies_its_certificate(pod):
    found = checks.transport_problems(pod)
    assert not found, "\n".join(found)


def test_every_vault_agent_logs_in_with_a_short_lived_token_meant_for_vault(pod):
    found = checks.login_problems(pod)
    assert not found, "\n".join(found)


def test_every_vault_agent_keeps_its_token_and_the_credentials_private(pod):
    found = (checks.tokens_outside_agents(pod) + checks.rendered_outside_memory(pod)
             + checks.rendered_open_to_others(pod) + checks.credentials_unreadable(pod)
             + checks.exposed_token_sinks(pod) + checks.unpinned_agent_images(pod))
    assert not found, "\n".join(found)


def test_nobody_else_can_read_payments_stripe(world, vault):
    found = checks.others_reading_stripe(world, vault)
    assert not found, "\n".join(found)


def test_the_internet_still_gets_nothing_beyond_the_storefront(world):
    found = checks.internet_openings(world)
    assert not found, "\n".join(found)
