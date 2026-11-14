"""Stage 2: the payments pods, and nobody else, can read payments/stripe; their token can do
nothing more, and the role and policy meet the platform's standard for Vault clients."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

import pytest  # noqa: E402

from sim import checks  # noqa: E402
from sim.containers import DEFAULT_AUDIENCE  # noqa: E402
from sim.vault import ServiceAccountJwt  # noqa: E402
from sim.world import SEEDED_SECRETS, STRIPE_PATH  # noqa: E402

pytest_plugins = ("sim.fixtures",)

TWENTY_MINUTES, FOUR_HOURS = 20 * 60, 4 * 3600
NOTHING_MORE_ON_STRIPE = (
    ("kv/metadata/payments/stripe", "the secret's metadata"),
    ("kv/delete/payments/stripe", "deleting versions"),
    ("kv/destroy/payments/stripe", "destroying versions"),
    ("kv/undelete/payments/stripe", "undeleting versions"),
    ("kv/metadata/payments/", "listing payments/"),
    ("kv/metadata/", "listing kv/"),
)
# Secrets nobody seeded but a policy wider than payments/stripe would cover.
OTHER_SECRET_PATHS = ("kv/data/payments/stripe-v2", "kv/data/payments/stripe/old",
                      "kv/data/orders/stripe", "kv/data/storefront/stripe", "kv/data/payments/db")
CONFIGURATION_PATHS = (
    "sys/policies/acl", "sys/policies/acl/payments-api", "sys/policies/acl/stg-read",
    "auth/k8s-quay-prod-fra1/role", "auth/k8s-quay-prod-fra1/role/payments-api",
    "auth/k8s-quay-prod-fra1/config", "auth/k8s-quay-stg-fra1/role/stg-services",
    "auth/oidc/role/platform", "auth/token/create", "auth/token/lookup", "auth/token/accessors",
    "sys/auth", "sys/mounts", "sys/quotas/rate-limit/kv-payments",
    "kv-stg/data/payments/stripe", "kv-stg/metadata/payments/", "kv-stg/metadata/",
)


@pytest.fixture
def role(pod):
    """(mount, role) the payments pod's Vault Agent logs in with."""
    for agent in pod.agents:
        auth = agent.config.auto_auth if agent.config else None
        if auth is not None and auth.role:
            return auth.mount, auth.role
    pytest.fail(f"no Vault Agent in the payments pod names a role to log in with: {pod.describe()}",
                pytrace=False)


def login(world, vault, role, namespace, account, audience):
    jwt = ServiceAccountJwt(world.cluster.cluster_name, namespace, account, (audience,), 600)
    return vault.login(role[0], role[1], jwt)


@pytest.fixture
def token(world, vault, pod, role):
    """The token a payments pod gets."""
    result = login(world, vault, role, "payments", pod.service_account, "vault")
    if result.token is None:
        pytest.fail(f"payments/{pod.service_account} cannot log in through auth/{role[0]} as role "
                    f"{role[1]}: {result.reason}", pytrace=False)
    return result.token


def test_the_payments_role_refuses_other_service_accounts(world, vault, pod, role):
    others = [("payments", "default"), ("orders", pod.service_account),
              ("storefront", pod.service_account), ("payments", "payments-ledger")]
    found = [f"{namespace}/{account} logs in as role {role[1]}" for namespace, account in others
             if login(world, vault, role, namespace, account, "vault").token is not None]
    assert not found, "\n".join(found)


def test_the_payments_role_refuses_a_token_not_meant_for_vault(world, vault, pod, role):
    result = login(world, vault, role, "payments", pod.service_account, DEFAULT_AUDIENCE)
    assert result.token is None, (
        f"a payments/{pod.service_account} token for audience {DEFAULT_AUDIENCE} logs in as role {role[1]}")


def test_the_payments_vault_token_is_short_lived(vault, role):
    found = vault.config.roles[role]
    problems = []
    if not 0 < found.ttl <= TWENTY_MINUTES:
        problems.append(f"role {role[1]} gives tokens a ttl of {found.ttl:.0f} s")
    if not 0 < found.max_ttl <= FOUR_HOURS:
        problems.append(f"role {role[1]} gives tokens a max ttl of {found.max_ttl:.0f} s")
    assert not problems, "\n".join(problems)


def test_the_payments_token_reads_payments_stripe(vault, token):
    path = vault.data_path(STRIPE_PATH)
    assert "read" in vault.capabilities(token, path), f"the payments token cannot read {path}"
    assert vault.read_secret(token, STRIPE_PATH)["data"]["data"] == SEEDED_SECRETS[STRIPE_PATH]


def test_the_payments_token_reads_no_other_secret(vault, token):
    paths = [vault.data_path(p) for p in SEEDED_SECRETS if p != STRIPE_PATH] + list(OTHER_SECRET_PATHS)
    found = [f"the payments token can read {path}" for path in paths
             if "read" in vault.capabilities(token, path)]
    assert not found, "\n".join(found)


def test_the_payments_token_can_do_nothing_with_payments_stripe_but_read_it(vault, token):
    data = vault.data_path(STRIPE_PATH)
    found = []
    extra = checks.beyond_default(vault, token, data) - {"read"}
    if extra:
        found.append(f"on {data} the payments token also has {', '.join(sorted(extra))}")
    for path, what in NOTHING_MORE_ON_STRIPE:
        caps = checks.beyond_default(vault, token, path)
        if caps:
            found.append(f"{what}: the payments token has {', '.join(sorted(caps))} on {path}")
    assert not found, "\n".join(found)


def test_the_payments_token_cannot_reach_vault_configuration_or_staging(vault, token):
    found = []
    for path in CONFIGURATION_PATHS:
        caps = checks.beyond_default(vault, token, path)
        if caps:
            found.append(f"the payments token has {', '.join(sorted(caps))} on {path}")
    assert not found, "\n".join(found)


def test_nobody_else_can_read_payments_stripe(world, vault):
    found = checks.others_reading_stripe(world, vault)
    assert not found, "\n".join(found)
