"""Stage 3: running payments pods follow Vault within a minute, without restarts, inside the
platform's Vault quota."""

import os
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

import pytest  # noqa: E402

from sim import checks  # noqa: E402
from sim.k8s import as_dict  # noqa: E402
from sim.payments_app import KEY_A, KEY_B, WEBHOOK_A, WEBHOOK_B, signature_header, webhook_event  # noqa: E402
from sim.pod import RUNNING  # noqa: E402
from sim.world import STRIPE_PATH  # noqa: E402

pytest_plugins = ("sim.fixtures",)

WITHIN = 60
AUTOSCALER_MAX, AUTOSCALER_MIN, QUOTA_PER_SECOND = 40, 3, 2


def just_after_a_render(pod):
    """Half a second after the first re-render past pod age 500 s (500.5 s if nothing re-renders)."""
    renders = []
    for agent in pod.running_agents():
        moment = agent.next_render
        while moment <= 500:
            moment += agent.render_interval
        renders.append(moment)
    return min(renders, default=500) + 0.5


MOMENTS = {"at-start": lambda pod: 1.0, "mid-life": lambda pod: 1000.0,
           "just-after-a-render": just_after_a_render}


def roll_the_key(pod, moment):
    """Finance rolls both values at `moment` (pod age) and expires the old key at Stripe; the
    clock then moves on 60 s."""
    pod.advance(moment - pod.age)
    pod.vault.write_secret(STRIPE_PATH, {"secret_key": KEY_B, "webhook_secret": WEBHOOK_B})
    pod.stripe.valid_keys = {KEY_B}
    pod.advance(WITHIN)


def running_service(pod):
    if pod.service is None:
        pytest.fail(f"the payments service is not running: {pod.describe()}", pytrace=False)
    return pod.service


def described(authorization):
    names = {f"Bearer {KEY_A}": "the old key", f"Bearer {KEY_B}": "the new key"}
    return names.get(authorization, repr(authorization))


@pytest.mark.parametrize("moment", list(MOMENTS))
def test_charges_use_a_rolled_secret_key_within_a_minute(pod, payments, moment):
    service = running_service(pod)
    rolled_at = MOMENTS[moment](pod)
    roll_the_key(pod, rolled_at)
    try:
        service.charge("ord-2002", 1800, "eur")
    except payments.StripeError:
        pass
    sent = pod.stripe.last_authorization
    assert sent == f"Bearer {KEY_B}", (
        f"{WITHIN} s after the key was rolled at pod age {rolled_at:.0f} s, a charge was sent with "
        f"{described(sent)}")


@pytest.mark.parametrize("moment", list(MOMENTS))
def test_webhooks_are_verified_with_a_rolled_signing_secret_within_a_minute(pod, payments, moment):
    service = running_service(pod)
    rolled_at = MOMENTS[moment](pod)
    roll_the_key(pod, rolled_at)
    payload = webhook_event()
    try:
        service.handle_webhook(payload, signature_header(payload, WEBHOOK_B, pod.clock()))
    except payments.SignatureError:
        pytest.fail(f"{WITHIN} s after the signing secret was rolled at pod age {rolled_at:.0f} s, "
                    "a webhook signed with it was rejected", pytrace=False)


def test_every_container_keeps_running_through_rotations(pod):
    running_service(pod)
    roll_the_key(pod, 1.0)
    pod.vault.write_secret(STRIPE_PATH, {"secret_key": KEY_A, "webhook_secret": WEBHOOK_A})
    pod.advance(3600)
    stopped = [f"{c.name} is {pod.states.get(c.name, 'not started')}" for c in pod.containers
               if pod.states.get(c.name) != RUNNING]
    assert not stopped, f"after an hour of rotations: {', '.join(stopped)} ({pod.describe()})"


def test_the_payments_pod_still_cold_starts(pod):
    found = checks.cold_start_problems(pod)
    assert not found, "\n".join(found)


def payments_autoscaler(world):
    for hpa in world.manifests.of_kind("HorizontalPodAutoscaler"):
        target = as_dict(hpa.spec.get("scaleTargetRef"))
        if hpa.namespace == "payments" and target.get("kind") == "Deployment" \
                and target.get("name") == "payments-api":
            return hpa
    return None


def test_vault_reads_at_the_largest_deployment_size_stay_inside_the_quota(world, pod):
    hpa = payments_autoscaler(world)
    largest = hpa.spec.get("maxReplicas") if hpa is not None else None
    largest = largest if isinstance(largest, int) else AUTOSCALER_MAX
    quota = pod.vault.quota_for(pod.vault.data_path(STRIPE_PATH))
    assert quota is not None, "no rate-limit quota in vault/ covers payments/stripe"
    rate = pod.request_rate()
    assert largest * rate <= quota.per_second + 1e-9, (
        f"each pod reads Vault {rate:.3f} times a second; {largest} pods read {largest * rate:.2f} "
        f"times a second, over the quota of {quota.per_second:g}")


def test_the_payments_quota_still_allows_at_most_two_reads_a_second(vault):
    quota = vault.quota_for(vault.data_path(STRIPE_PATH))
    assert quota is not None, "no rate-limit quota in vault/ covers payments/stripe"
    assert quota.per_second <= QUOTA_PER_SECOND, (
        f"quota {quota.name} allows {quota.per_second:g} requests a second")


def test_the_payments_autoscaler_limits_are_unchanged(world):
    hpa = payments_autoscaler(world)
    assert hpa is not None, "no HorizontalPodAutoscaler scales payments-api"
    low, high = hpa.spec.get("minReplicas"), hpa.spec.get("maxReplicas")
    assert isinstance(low, int) and low >= AUTOSCALER_MIN and isinstance(high, int) \
        and high >= AUTOSCALER_MAX, f"the autoscaler scales payments-api between {low} and {high}"
