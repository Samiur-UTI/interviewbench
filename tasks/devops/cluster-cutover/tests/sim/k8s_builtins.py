"""The ClusterRoles and ClusterRoleBindings every kubeadm cluster has (SPEC section 3.2).

Written as manifests so they go through the same parser as the candidate's objects. `view`,
`edit` and `admin` aggregate as upstream does: `admin` selects roles labelled aggregate-to-admin
(which include `edit`), `edit` selects aggregate-to-edit (which include `view`), `view` selects
aggregate-to-view.
"""

from __future__ import annotations

from typing import Any

READ = ["get", "list", "watch"]
WRITE = ["create", "delete", "deletecollection", "patch", "update"]
AGGREGATE = "rbac.authorization.k8s.io/aggregate-to-"


def _rule(groups: list[str], resources: list[str], verbs: list[str]) -> dict[str, Any]:
    return {"apiGroups": groups, "resources": resources, "verbs": verbs}


def _cluster_role(name: str, rules: list[dict[str, Any]], labels: dict[str, str] | None = None,
                  aggregates: str | None = None) -> dict[str, Any]:
    role: dict[str, Any] = {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "ClusterRole",
        "metadata": {"name": name, "labels": labels or {}},
        "rules": rules,
    }
    if aggregates:
        selector = {"matchLabels": {AGGREGATE + aggregates: "true"}}
        role["aggregationRule"] = {"clusterRoleSelectors": [selector]}
    return role


def _binding(name: str, role: str, groups: list[str]) -> dict[str, Any]:
    return {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "ClusterRoleBinding",
        "metadata": {"name": name},
        "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": role},
        "subjects": [{"kind": "Group", "name": g} for g in groups],
    }


_VIEW_CORE = ["pods", "pods/log", "pods/status", "services", "endpoints", "configmaps", "events",
              "persistentvolumeclaims", "replicationcontrollers", "serviceaccounts", "namespaces",
              "bindings", "limitranges", "resourcequotas"]
_VIEW_APPS = ["deployments", "deployments/scale", "deployments/status", "replicasets",
              "replicasets/scale", "replicasets/status", "statefulsets", "statefulsets/scale",
              "statefulsets/status", "daemonsets", "daemonsets/status"]
_WORKLOADS = [
    (["batch"], ["jobs", "cronjobs"]),
    (["autoscaling"], ["horizontalpodautoscalers"]),
    (["networking.k8s.io"], ["ingresses", "networkpolicies"]),
    (["policy"], ["poddisruptionbudgets"]),
]

_VIEW_RULES = [
    _rule([""], _VIEW_CORE, READ),
    _rule(["apps"], _VIEW_APPS, READ),
    *(_rule(groups, resources, READ) for groups, resources in _WORKLOADS),
    _rule(["events.k8s.io"], ["events"], READ),
]

_EDIT_RULES = [
    _rule([""], ["pods", "services", "endpoints", "configmaps", "persistentvolumeclaims",
                 "replicationcontrollers", "replicationcontrollers/scale", "serviceaccounts"], WRITE),
    _rule([""], ["secrets"], READ + WRITE),
    _rule([""], ["pods/exec", "pods/attach", "pods/portforward", "pods/proxy"], ["create", "get"]),
    _rule([""], ["serviceaccounts"], ["impersonate"]),
    _rule([""], ["serviceaccounts/token"], ["create"]),
    _rule(["apps"], ["deployments", "deployments/scale", "replicasets", "replicasets/scale",
                     "statefulsets", "statefulsets/scale", "daemonsets"], WRITE),
    *(_rule(groups, resources, WRITE) for groups, resources in _WORKLOADS),
]

_ADMIN_RULES = [
    _rule(["rbac.authorization.k8s.io"], ["roles", "rolebindings"], READ + WRITE),
    _rule(["authorization.k8s.io"], ["localsubjectaccessreviews"], ["create"]),
]

BUILTIN_CLUSTER_ROLES: list[dict[str, Any]] = [
    _cluster_role("cluster-admin", [_rule(["*"], ["*"], ["*"]),
                                    {"nonResourceURLs": ["*"], "verbs": ["*"]}]),
    _cluster_role("admin", [], aggregates="admin"),
    _cluster_role("edit", [], labels={AGGREGATE + "admin": "true"}, aggregates="edit"),
    _cluster_role("view", [], labels={AGGREGATE + "edit": "true"}, aggregates="view"),
    _cluster_role("system:aggregate-to-admin", _ADMIN_RULES, labels={AGGREGATE + "admin": "true"}),
    _cluster_role("system:aggregate-to-edit", _EDIT_RULES, labels={AGGREGATE + "edit": "true"}),
    _cluster_role("system:aggregate-to-view", _VIEW_RULES, labels={AGGREGATE + "view": "true"}),
    _cluster_role("system:public-info-viewer", [{
        "nonResourceURLs": ["/healthz", "/livez", "/readyz", "/version", "/version/"],
        "verbs": ["get"],
    }]),
    _cluster_role("system:discovery", [{
        "nonResourceURLs": ["/api", "/api/*", "/apis", "/apis/*", "/healthz", "/livez", "/openapi",
                            "/openapi/*", "/readyz", "/version", "/version/"],
        "verbs": ["get"],
    }]),
    _cluster_role("system:basic-user", [
        _rule(["authorization.k8s.io"], ["selfsubjectaccessreviews", "selfsubjectrulesreviews"],
              ["create"]),
    ]),
    _cluster_role("system:auth-delegator", [
        _rule(["authentication.k8s.io"], ["tokenreviews"], ["create"]),
        _rule(["authorization.k8s.io"], ["subjectaccessreviews"], ["create"]),
    ]),
]

BUILTIN_CLUSTER_ROLE_BINDINGS: list[dict[str, Any]] = [
    _binding("cluster-admin", "cluster-admin", ["system:masters"]),
    _binding("system:public-info-viewer", "system:public-info-viewer",
             ["system:authenticated", "system:unauthenticated"]),
    _binding("system:discovery", "system:discovery", ["system:authenticated"]),
    _binding("system:basic-user", "system:basic-user", ["system:authenticated"]),
]
