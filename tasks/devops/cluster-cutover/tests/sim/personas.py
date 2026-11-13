"""The people and workloads of docs/access.md, and the requests that stand for what each needs
or must not have (SPEC sections 1 and 4)."""

from __future__ import annotations

from .rbac import NonResourceRequest, Request, ResourceRequest, person, service_account

PLATFORM = person("platform-engineer@quayside.example", "quayside:platform")
DEVELOPER = person("developer@quayside.example", "quayside:developers")
SUPPORT = person("support-agent@quayside.example", "quayside:support")
ONCALL = person("payments-oncall@quayside.example", "quayside:payments-oncall")
CI_DEPLOYER = service_account("platform", "ci-deployer")
PROMETHEUS = service_account("monitoring", "prometheus")
STOREFRONT_DEFAULT = service_account("storefront", "default")

APP_NAMESPACES = ("storefront", "orders", "payments", "monitoring", "platform", "kubernetes-dashboard")
DEVELOPER_NAMESPACES = ("storefront", "orders")
POD = "payments-api-7d9c5b8f4-x2x9q"
WORKLOADS = (("", "pods"), ("apps", "deployments"), ("apps", "replicasets"), ("apps", "statefulsets"),
             ("apps", "daemonsets"), ("batch", "jobs"), ("batch", "cronjobs"))


def _r(verb: str, resource: str, namespace: str | None = None, group: str = "",
       sub: str | None = None, name: str | None = None) -> ResourceRequest:
    return ResourceRequest(verb, resource, namespace, group, sub, name)


def pod_reading(namespace: str) -> list[Request]:
    """Look at pods, their logs and events."""
    return [_r("get", "pods", namespace, name=POD), _r("list", "pods", namespace),
            _r("get", "pods", namespace, sub="log", name=POD), _r("list", "events", namespace)]


def support_reading(namespace: str) -> list[Request]:
    """Read-only: pods, their logs, events, deployments, services."""
    return pod_reading(namespace) + [
        _r("list", "deployments", namespace, "apps"), _r("get", "deployments", namespace, "apps", name="web"),
        _r("list", "services", namespace), _r("get", "services", namespace, name="web"),
    ]


def edit_level(namespace: str) -> list[Request]:
    """What the built-in `edit` role gives in a namespace: deploy and debug."""
    return [
        _r("create", "deployments", namespace, "apps"), _r("patch", "deployments", namespace, "apps", name="web"),
        _r("delete", "deployments", namespace, "apps", name="web"), _r("delete", "pods", namespace, name="web-1"),
        _r("create", "pods", namespace, sub="exec", name="web-1"),
        _r("create", "pods", namespace, sub="portforward", name="web-1"),
        _r("get", "secrets", namespace, name="web"), _r("create", "secrets", namespace),
        _r("create", "configmaps", namespace), _r("update", "configmaps", namespace, name="web"),
        _r("create", "services", namespace), _r("create", "jobs", namespace, "batch"),
    ]


def ci_deployer_needs() -> list[Request]:
    """Apply everything in deploy/k8s/."""
    needs: list[Request] = []
    for namespace in APP_NAMESPACES:
        needs += [_r("create", "deployments", namespace, "apps"),
                  _r("patch", "deployments", namespace, "apps", name="web"),
                  _r("create", "services", namespace), _r("patch", "services", namespace, name="web"),
                  _r("create", "configmaps", namespace), _r("create", "serviceaccounts", namespace)]
    return needs + [_r("create", "clusterrolebindings", group="rbac.authorization.k8s.io"),
                    _r("create", "namespaces")]


def oncall_needs() -> list[Request]:
    """The built-in `admin` role in payments."""
    return [_r("get", "secrets", "payments", name="payments-stripe"), _r("list", "secrets", "payments"),
            _r("create", "pods", "payments", sub="exec", name=POD),
            _r("delete", "pods", "payments", name=POD),
            _r("update", "deployments", "payments", "apps", name="payments-api"),
            _r("create", "roles", "payments", "rbac.authorization.k8s.io"),
            _r("create", "rolebindings", "payments", "rbac.authorization.k8s.io"),
            _r("create", "localsubjectaccessreviews", "payments", "authorization.k8s.io")]


def platform_needs() -> list[Request]:
    """cluster-admin."""
    return [_r("create", "clusterrolebindings", group="rbac.authorization.k8s.io"),
            _r("escalate", "clusterroles", group="rbac.authorization.k8s.io", name="admin"),
            _r("delete", "nodes", name="w-1"), _r("get", "secrets", "kube-system", name="bootstrap"),
            _r("create", "pods", "kube-system", sub="exec", name="etcd-cp-1"),
            _r("list", "secrets"), NonResourceRequest("get", "/metrics")]


def identity_yielding_in_payments() -> list[Request]:
    """Anything in payments that yields the workload's identity or its memory (stage 2 brief)."""
    requests: list[Request] = [
        _r("get", "secrets", "payments", name="payments-stripe"), _r("list", "secrets", "payments"),
        *(_r("create", "pods", "payments", sub=sub, name=POD) for sub in ("exec", "attach", "portforward")),
        _r("create", "serviceaccounts", "payments", sub="token", name="payments-api"),
        _r("impersonate", "serviceaccounts", "payments", name="payments-api"),
    ]
    for group, resource in WORKLOADS:
        requests += [_r("create", resource, "payments", group)]
        requests += [_r(verb, resource, "payments", group, name="payments-api")
                     for verb in ("update", "patch", "delete")]
    for resource in ("roles", "rolebindings"):
        requests += [_r("create", resource, "payments", "rbac.authorization.k8s.io")]
        requests += [_r(verb, resource, "payments", "rbac.authorization.k8s.io", name="payments")
                     for verb in ("update", "patch")]
    return requests


def outside_namespace_changes(namespace: str) -> list[Request]:
    """Creating, changing, deleting or exec-ing in another namespace, and cluster-wide changes."""
    requests: list[Request] = [_r("create", "pods", namespace, sub="exec", name="web-1")]
    for group, resource in (("", "pods"), ("", "secrets"), ("", "configmaps"), ("", "services"),
                            ("apps", "deployments"), ("rbac.authorization.k8s.io", "rolebindings")):
        requests += [_r("create", resource, namespace, group)]
        requests += [_r(v, resource, namespace, group, name="web") for v in ("update", "patch", "delete")]
    return requests


def cluster_changes() -> list[Request]:
    rbac = "rbac.authorization.k8s.io"
    return [_r("create", "namespaces"), _r("delete", "namespaces", name="payments"),
            _r("create", "clusterrolebindings", group=rbac), _r("create", "clusterroles", group=rbac),
            _r("patch", "nodes", name="w-1"), _r("delete", "nodes", name="w-1")]
