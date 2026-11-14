"""Kubernetes RBAC as the API server evaluates it (SPEC section 3.2).

Bindings and roles come from deploy/k8s/ plus the built-ins in k8s_builtins; an object in the
repository with a built-in's name replaces the built-in. A ClusterRoleBinding grants its
ClusterRole everywhere (every namespace, cluster-scoped resources, non-resource URLs); a
RoleBinding grants its Role or ClusterRole on namespaced resources in its own namespace only.
A binding whose role does not exist grants nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Union

from .k8s import K8sObject, Manifests, as_dict, as_list, object_from
from .k8s_builtins import BUILTIN_CLUSTER_ROLE_BINDINGS, BUILTIN_CLUSTER_ROLES

AUTHENTICATED = "system:authenticated"
UNAUTHENTICATED = "system:unauthenticated"


@dataclass(frozen=True)
class Identity:
    """An authenticated (or anonymous) caller as the API server sees it."""

    user: str
    groups: frozenset[str]

    def __str__(self) -> str:
        return self.user


def person(user: str, *groups: str) -> Identity:
    """A person logged in through OIDC: their groups plus system:authenticated."""
    return Identity(user, frozenset((*groups, AUTHENTICATED)))


def service_account(namespace: str, name: str) -> Identity:
    return Identity(
        f"system:serviceaccount:{namespace}:{name}",
        frozenset({"system:serviceaccounts", f"system:serviceaccounts:{namespace}", AUTHENTICATED}),
    )


ANONYMOUS = Identity("system:anonymous", frozenset({UNAUTHENTICATED}))


@dataclass(frozen=True)
class ResourceRequest:
    """A request on an API resource. `namespace` None: cluster-scoped, or across all namespaces."""

    verb: str
    resource: str
    namespace: str | None = None
    group: str = ""
    subresource: str | None = None
    name: str | None = None

    def __str__(self) -> str:
        what = self.resource + (f"/{self.subresource}" if self.subresource else "")
        if self.group:
            what += f".{self.group}"
        where = f" in {self.namespace}" if self.namespace else " across the cluster"
        return f"{self.verb} {what}{where}"


@dataclass(frozen=True)
class NonResourceRequest:
    verb: str
    path: str

    def __str__(self) -> str:
        return f"{self.verb.upper()} {self.path}"


Request = Union[ResourceRequest, NonResourceRequest]


def _strings(value: Any) -> frozenset[str]:
    return frozenset(str(v) for v in as_list(value) if v is not None)


@dataclass(frozen=True)
class Rule:
    """One PolicyRule."""

    verbs: frozenset[str]
    api_groups: frozenset[str]
    resources: frozenset[str]
    resource_names: frozenset[str]
    non_resource_urls: frozenset[str]

    @classmethod
    def parse(cls, raw: Any) -> Rule:
        raw = as_dict(raw)
        return cls(_strings(raw.get("verbs")), _strings(raw.get("apiGroups")),
                   _strings(raw.get("resources")), _strings(raw.get("resourceNames")),
                   _strings(raw.get("nonResourceURLs")))

    def matches(self, request: Request) -> bool:
        if "*" not in self.verbs and request.verb not in self.verbs:
            return False
        if isinstance(request, NonResourceRequest):
            return any(_url_matches(url, request.path) for url in self.non_resource_urls)
        if "*" not in self.api_groups and request.group not in self.api_groups:
            return False
        if not self._resource_matches(request):
            return False
        return not self.resource_names or request.name in self.resource_names

    def _resource_matches(self, request: ResourceRequest) -> bool:
        """As upstream: `*` matches everything, `*/sub` that subresource of any resource, otherwise
        the exact resource or resource/subresource. `res/*` is not a wildcard in Kubernetes RBAC."""
        sub = request.subresource
        full = f"{request.resource}/{sub}" if sub else request.resource
        if "*" in self.resources or full in self.resources:
            return True
        return bool(sub) and f"*/{sub}" in self.resources


def _url_matches(rule_url: str, path: str) -> bool:
    if rule_url == "*" or rule_url == path:
        return True
    return rule_url.endswith("*") and path.startswith(rule_url[:-1])


def _selector_matches(selector: Any, labels: dict[str, Any]) -> bool:
    """A metav1.LabelSelector (matchLabels and matchExpressions) against a role's labels."""
    selector = as_dict(selector)
    text = {str(k): str(v) for k, v in labels.items()}
    for key, value in as_dict(selector.get("matchLabels")).items():
        if text.get(str(key)) != str(value):
            return False
    for expression in as_list(selector.get("matchExpressions")):
        expression = as_dict(expression)
        key, operator = str(expression.get("key")), expression.get("operator")
        values = {str(v) for v in as_list(expression.get("values"))}
        if operator == "In" and text.get(key) not in values:
            return False
        if operator == "NotIn" and text.get(key) in values:
            return False
        if operator == "Exists" and key not in text:
            return False
        if operator == "DoesNotExist" and key in text:
            return False
    return True


@dataclass(frozen=True)
class _ClusterRole:
    labels: dict[str, Any]
    rules: tuple[Rule, ...]
    selectors: tuple[Any, ...] | None


@dataclass(frozen=True)
class _Binding:
    namespace: str | None
    role_kind: str
    role_name: str
    subjects: tuple[dict[str, Any], ...]

    @classmethod
    def parse(cls, obj: K8sObject) -> _Binding:
        ref = as_dict(obj.body.get("roleRef"))
        subjects = tuple(as_dict(s) for s in as_list(obj.body.get("subjects")))
        namespace = obj.namespace if obj.kind == "RoleBinding" else None
        return cls(namespace, str(ref.get("kind")), str(ref.get("name")), subjects)

    def includes(self, identity: Identity) -> bool:
        for subject in self.subjects:
            kind, name = subject.get("kind"), str(subject.get("name"))
            if kind == "User" and name == identity.user:
                return True
            if kind == "Group" and name in identity.groups:
                return True
            if kind == "ServiceAccount":
                namespace = subject.get("namespace") or self.namespace
                if namespace and identity.user == f"system:serviceaccount:{namespace}:{name}":
                    return True
        return False


class Rbac:
    """Answers whether an identity may make a request, over the repository and the built-ins."""

    def __init__(self, manifests: Manifests) -> None:
        builtin_roles = [object_from(raw, "built-in") for raw in BUILTIN_CLUSTER_ROLES]
        builtin_bindings = [object_from(raw, "built-in") for raw in BUILTIN_CLUSTER_ROLE_BINDINGS]
        cluster_roles = {o.name: o for o in builtin_roles}
        cluster_roles.update({o.name: o for o in manifests.of_kind("ClusterRole")})
        self._cluster_roles = {name: self._parse_cluster_role(o) for name, o in cluster_roles.items()}
        self._roles = {
            (o.namespace, o.name): tuple(Rule.parse(r) for r in as_list(o.body.get("rules")))
            for o in manifests.of_kind("Role")
        }
        cluster_bindings = {o.name: o for o in builtin_bindings}
        cluster_bindings.update({o.name: o for o in manifests.of_kind("ClusterRoleBinding")})
        self._cluster_bindings = [_Binding.parse(o) for o in cluster_bindings.values()]
        self._bindings = [_Binding.parse(o) for o in manifests.of_kind("RoleBinding")]
        self._aggregated: dict[str, tuple[Rule, ...] | None] = {}

    @staticmethod
    def _parse_cluster_role(obj: K8sObject) -> _ClusterRole:
        rules = tuple(Rule.parse(r) for r in as_list(obj.body.get("rules")))
        aggregation = obj.body.get("aggregationRule")
        selectors = None
        if isinstance(aggregation, dict):
            selectors = tuple(as_list(aggregation.get("clusterRoleSelectors")))
        return _ClusterRole(obj.labels, rules, selectors)

    def cluster_role_rules(self, name: str) -> tuple[Rule, ...] | None:
        """The ClusterRole's rules after aggregation, or None when it does not exist."""
        if name not in self._aggregated:
            self._aggregated[name] = self._collect(name, frozenset())
        return self._aggregated[name]

    def _collect(self, name: str, visiting: frozenset[str]) -> tuple[Rule, ...] | None:
        role = self._cluster_roles.get(name)
        if role is None:
            return None
        if role.selectors is None:
            return role.rules
        rules: list[Rule] = []
        for other, candidate in sorted(self._cluster_roles.items()):
            if other == name or other in visiting:
                continue
            if any(_selector_matches(s, candidate.labels) for s in role.selectors):
                rules.extend(self._collect(other, visiting | {name}) or ())
        return tuple(rules)

    def _rules_of(self, binding: _Binding) -> tuple[Rule, ...]:
        if binding.role_kind == "ClusterRole":
            return self.cluster_role_rules(binding.role_name) or ()
        if binding.role_kind == "Role" and binding.namespace is not None:
            return self._roles.get((binding.namespace, binding.role_name), ())
        return ()

    def allows(self, identity: Identity, request: Request) -> bool:
        for binding in self._cluster_bindings:
            if binding.includes(identity) and any(r.matches(request) for r in self._rules_of(binding)):
                return True
        if not isinstance(request, ResourceRequest) or request.namespace is None:
            return False
        for binding in self._bindings:
            if binding.namespace != request.namespace or not binding.includes(identity):
                continue
            if any(r.matches(request) for r in self._rules_of(binding)):
                return True
        return False
