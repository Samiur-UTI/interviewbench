"""Stage 2: the payments pod fetches the Stripe values from Vault with Vault Agent when it
starts, as the platform's standard for Vault clients requires."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

import pytest  # noqa: E402

from sim import checks  # noqa: E402
from sim.payments_app import KEY_A, WEBHOOK_A, signature_header, webhook_event  # noqa: E402

pytest_plugins = ("sim.fixtures",)

OTHER_WEBHOOK_SECRET = "whsec_fake-Z9-interviewbench"


def running_service(pod):
    if pod.service is None:
        pytest.fail(f"the payments service is not running: {pod.describe()}", pytrace=False)
    return pod.service


def test_the_payments_pod_cold_starts_with_its_credentials_in_place(pod):
    found = checks.cold_start_problems(pod)
    assert not found, "\n".join(found)


def test_no_container_in_the_payments_pod_crash_loops(pod):
    found = checks.crash_loops(pod)
    assert not found, "\n".join(found)


def test_charges_are_sent_with_the_secret_key_from_vault(pod, payments):
    service = running_service(pod)
    try:
        service.charge("ord-1001", 2500, "eur")
    except payments.StripeError:
        pass
    sent = pod.stripe.last_authorization
    assert sent == f"Bearer {KEY_A}", (
        f"Stripe received Authorization {sent!r}, not the secret key stored in Vault")


def test_webhooks_are_verified_with_the_signing_secret_from_vault(pod, payments):
    service = running_service(pod)
    payload = webhook_event()
    try:
        service.handle_webhook(payload, signature_header(payload, WEBHOOK_A, pod.clock()))
    except payments.SignatureError:
        pytest.fail("a webhook signed with the signing secret stored in Vault was rejected",
                    pytrace=False)
    with pytest.raises(payments.SignatureError):
        service.handle_webhook(payload, signature_header(payload, OTHER_WEBHOOK_SECRET, pod.clock()))


def test_vault_agent_reaches_the_platform_vault_and_verifies_its_certificate(pod):
    found = checks.transport_problems(pod)
    assert not found, "\n".join(found)


def test_vault_agent_logs_in_with_a_short_lived_token_meant_for_vault(pod):
    found = checks.login_problems(pod)
    assert not found, "\n".join(found)


def test_payments_pods_run_as_their_own_declared_service_account(world):
    account = checks.pod_service_account(world)
    assert account != "default", "the payments pods run as the default service account"
    assert world.manifests.has_service_account("payments", account), (
        f"the payments pods run as payments/{account}, which deploy/k8s/ does not declare")


def test_only_the_containers_that_log_in_to_vault_carry_a_service_account_token(pod):
    found = checks.tokens_outside_agents(pod)
    assert not found, "\n".join(found)


def test_the_rendered_credentials_are_only_ever_in_memory(pod):
    found = checks.rendered_outside_memory(pod)
    assert not found, "\n".join(found)


def test_the_rendered_credentials_are_private_to_the_payments_user(pod):
    found = checks.rendered_open_to_others(pod) + checks.credentials_unreadable(pod)
    assert not found, "\n".join(found)


def test_a_vault_token_written_to_a_file_stays_with_its_agent(pod):
    found = checks.exposed_token_sinks(pod)
    assert not found, "\n".join(found)


def test_vault_agent_runs_the_mirrored_vault_image_pinned_to_a_version(pod):
    found = checks.unpinned_agent_images(pod)
    assert not found, "\n".join(found)
