"""Stage 2: the Stripe values have one home, and in payments only the pipeline, the platform
admins and payments on-call can get at the workload's identity through Kubernetes."""

import os
import re
import sys

sys.path.insert(0, os.environ["TESTS_DIR"])

from sim import checks  # noqa: E402
from sim.k8s import as_dict, as_list  # noqa: E402
from sim.personas import (CI_DEPLOYER, DEVELOPER, ONCALL, PLATFORM, SUPPORT,  # noqa: E402
                          identity_yielding_in_payments, pod_reading)
from sim.rbac import service_account  # noqa: E402

pytest_plugins = ("sim.fixtures",)

NAMES = ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET")
PLACEHOLDER = re.compile(r"\$\{?\w*STRIPE_(SECRET_KEY|WEBHOOK_SECRET)\b")
COMMENT = re.compile(r"(^|\s)#.*$")


def test_the_stripe_variable_names_appear_nowhere_in_ci_or_deploy(world):
    found = []
    for folder in ("ci", "deploy"):
        for path in sorted((world.root / folder).rglob("*")):
            if not path.is_file():
                continue
            text = path.read_bytes().decode("utf-8", errors="replace").replace("\r\n", "\n")
            for number, line in enumerate(text.split("\n"), start=1):
                code = COMMENT.sub("", line)
                found += [f"{path.relative_to(world.root).as_posix()} line {number} names {name}"
                          for name in NAMES if name in code]
    assert not found, "\n".join(found)


def test_no_workload_has_a_stripe_environment_variable(world):
    found = []
    for workload, spec in world.manifests.pod_specs():
        for container in map(as_dict, as_list(spec.get("initContainers")) + as_list(spec.get("containers"))):
            names = {str(as_dict(v).get("name")) for v in as_list(container.get("env"))}
            for source in map(as_dict, as_list(container.get("envFrom"))):
                for key, getter in (("configMapRef", world.manifests.config_map),
                                    ("secretRef", world.manifests.secret)):
                    ref = as_dict(source.get(key))
                    keys = getter(workload.namespace or "default", str(ref.get("name"))) if ref else None
                    names |= {str(source.get("prefix") or "") + k for k in keys or {}}
            found += [f"container {container.get('name')} of {workload.describe()} has {name}"
                      for name in NAMES if name in names]
    assert not found, "\n".join(found)


def test_no_secret_or_configmap_carries_the_stripe_values(world):
    found = []
    for obj in world.manifests.of_kind("Secret", "ConfigMap"):
        values = world.manifests.secret(obj.namespace, obj.name) if obj.kind == "Secret" \
            else world.manifests.config_map(obj.namespace, obj.name)
        for key, value in (values or {}).items():
            if PLACEHOLDER.search(value.decode("utf-8", errors="replace")) or key in NAMES:
                found.append(f"{obj.describe()} key {key} carries a Stripe value")
    assert not found, "\n".join(found)


def test_developers_get_nothing_in_payments_that_yields_its_identity(world):
    found = checks.granted(world, DEVELOPER, identity_yielding_in_payments())
    assert not found, "\n".join(found)


def test_support_gets_nothing_in_payments_that_yields_its_identity(world):
    found = checks.granted(world, SUPPORT, identity_yielding_in_payments())
    assert not found, "\n".join(found)


def test_no_other_workload_gets_anything_in_payments_that_yields_its_identity(world):
    found = []
    for namespace, name in world.manifests.service_accounts():
        if (namespace, name) != ("platform", "ci-deployer"):
            found += checks.granted(world, service_account(namespace, name),
                                    identity_yielding_in_payments())
    assert not found, "\n".join(found)


def test_developers_and_support_still_read_pods_logs_and_events_in_payments(world):
    found = checks.missing(world, DEVELOPER, pod_reading("payments"))
    found += checks.missing(world, SUPPORT, pod_reading("payments"))
    assert not found, "\n".join(found)


def test_the_pipeline_platform_and_payments_oncall_keep_full_control_of_payments(world):
    found = []
    for identity in (CI_DEPLOYER, PLATFORM, ONCALL):
        found += checks.missing(world, identity, identity_yielding_in_payments())
    assert not found, "\n".join(found)


def test_developers_keep_edit_in_storefront_and_orders_and_read_access_elsewhere(world):
    found = checks.developer_access_problems(world)
    assert not found, "\n".join(found)


def test_support_keeps_read_access_everywhere(world):
    found = checks.support_access_problems(world)
    assert not found, "\n".join(found)


def test_the_internet_still_gets_nothing_beyond_the_storefront(world):
    found = checks.internet_openings(world)
    assert not found, "\n".join(found)


def test_a_request_without_credentials_still_gets_nothing_but_health_and_version(world):
    found = checks.anonymous_api_answers(world)
    assert not found, "\n".join(found)
