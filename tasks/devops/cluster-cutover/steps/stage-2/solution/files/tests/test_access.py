"""Who can get at the payments workload through Kubernetes (docs/access.md and the stage 2 rule:
in payments only the pipeline, the platform admins and payments on-call may do anything that
yields the workload's identity or memory)."""

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]

EVERYONE_GROUPS = {"system:authenticated", "system:unauthenticated", "system:anonymous",
                   "system:serviceaccounts"}
TRUSTED = {("Group", "quayside:platform"), ("Group", "quayside:payments-oncall"),
           ("ServiceAccount", "platform/ci-deployer")}
# Built-in roles bound in this repo whose rules are not in it.
BUILTIN_READ_ONLY = {"view", "system:auth-delegator"}
BUILTIN_POWERFUL = {"cluster-admin", "admin", "edit"}
READ_VERBS = {"get", "list", "watch"}
IDENTITY_RESOURCES = {"*", "secrets", "pods/exec", "pods/attach", "pods/portforward",
                      "serviceaccounts/token", "serviceaccounts"}


def objects():
    for path in sorted((ROOT / "deploy" / "k8s").rglob("*.y*ml")):
        with path.open(encoding="utf-8") as handle:
            yield from (doc for doc in yaml.safe_load_all(handle) if doc)


OBJECTS = list(objects())
BINDINGS = [o for o in OBJECTS if o["kind"] in ("ClusterRoleBinding", "RoleBinding")]


def subject(binding, raw):
    if raw["kind"] == "ServiceAccount":
        namespace = raw.get("namespace") or binding["metadata"].get("namespace")
        return "ServiceAccount", f"{namespace}/{raw['name']}"
    return raw["kind"], raw["name"]


def rules_of(binding):
    ref = binding["roleRef"]
    namespace = binding["metadata"].get("namespace") if ref["kind"] == "Role" else None
    for obj in OBJECTS:
        if obj["kind"] == ref["kind"] and obj["metadata"]["name"] == ref["name"] \
                and obj["metadata"].get("namespace") == namespace:
            return obj.get("rules") or []
    return None


def powerful(binding):
    """Whether the bound role can yield a workload's identity or memory, or change workloads."""
    rules = rules_of(binding)
    if rules is None:
        return binding["roleRef"]["name"] not in BUILTIN_READ_ONLY
    return any(set(rule.get("verbs", [])) - READ_VERBS or set(rule.get("resources", [])) & IDENTITY_RESOURCES
               for rule in rules if "resources" in rule)


def reaches_payments(binding):
    return binding["kind"] == "ClusterRoleBinding" or binding["metadata"].get("namespace") == "payments"


def test_nothing_is_bound_to_everyone():
    found = [b["metadata"]["name"] for b in BINDINGS for s in b.get("subjects") or []
             if s["name"] in EVERYONE_GROUPS]
    assert not found, found


def test_in_payments_only_the_pipeline_platform_and_oncall_hold_more_than_read_access():
    found = [f"{b['kind']} {b['metadata']['name']} gives {b['roleRef']['name']} to {subject(b, s)}"
             for b in BINDINGS if reaches_payments(b) and powerful(b)
             for s in b.get("subjects") or [] if subject(b, s) not in TRUSTED]
    assert not found, "\n".join(found)


def test_the_built_in_roles_this_check_relies_on_are_classified():
    unknown = {b["roleRef"]["name"] for b in BINDINGS if rules_of(b) is None} - BUILTIN_READ_ONLY - BUILTIN_POWERFUL
    assert not unknown, f"classify these built-in roles above: {unknown}"


@pytest.mark.parametrize("namespace", ["storefront", "orders"])
def test_developers_keep_edit_where_they_deploy(namespace):
    assert any(b["kind"] == "RoleBinding" and b["metadata"].get("namespace") == namespace
               and b["roleRef"]["name"] == "edit"
               and {"kind": "Group", "name": "quayside:developers"}.items() <= b["subjects"][0].items()
               for b in BINDINGS)
