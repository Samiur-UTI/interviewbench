"""The platform Vault, built from the vault/ tree (SPEC sections 2.5 and 3.5).

A file's path under vault/ is its API path: sys/mounts/<m>.json and sys/auth/<m>.json declare
mounts, sys/policies/acl/<name>.hcl (or .json) policies, sys/quotas/rate-limit/<name>.json
quotas, auth/<mount>/role/<name>.json kubernetes auth roles. Secret values are never in the tree:
the tests seed them.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import acl
from .durations import parse_duration
from .k8s import as_dict
from .kubeadm import go_bool
from .repo import RepoError, display, files_under, load_json, read_text

VAULT_ADDRESS = "https://vault.platform.quayside.example:8200"
CLUSTER_MOUNT_PREFIX = "k8s-"


@dataclass(frozen=True)
class KubernetesRole:
    mount: str
    name: str
    names: tuple[str, ...]
    namespaces: tuple[str, ...]
    audience: str
    policies: tuple[str, ...]
    ttl: float
    max_ttl: float
    no_default_policy: bool
    source: str


@dataclass(frozen=True)
class Quota:
    name: str
    path: str
    rate: float
    interval: float

    @property
    def per_second(self) -> float:
        return self.rate / self.interval


def _list_field(value: Any) -> tuple[str, ...]:
    """A role field given as a list or a comma-separated string."""
    items = value if isinstance(value, list) else str(value).split(",") if value is not None else []
    return tuple(s for s in (str(v).strip() for v in items) if s)


def _duration(data: dict, keys: tuple[str, ...], source: str) -> float:
    for key in keys:
        if key in data and data[key] is not None:
            try:
                return parse_duration(data[key])
            except ValueError:
                raise RepoError(f"{source}: {key} is not a duration: {data[key]!r}") from None
    return 0.0


def _role(mount: str, name: str, data: Any, source: str) -> KubernetesRole:
    data = as_dict(data)
    policies = data.get("token_policies", data.get("policies"))
    return KubernetesRole(
        mount=mount,
        name=name,
        names=_list_field(data.get("bound_service_account_names")),
        namespaces=_list_field(data.get("bound_service_account_namespaces")),
        audience=str(data.get("audience") or ""),
        policies=_list_field(policies),
        ttl=_duration(data, ("token_ttl", "ttl"), source),
        max_ttl=_duration(data, ("token_max_ttl", "max_ttl"), source),
        no_default_policy=go_bool(data.get("token_no_default_policy"), False),
        source=source,
    )


@dataclass
class VaultConfig:
    """What the vault/ tree declares."""

    secret_mounts: dict[str, dict[str, Any]]
    auth_mounts: dict[str, str]
    roles: dict[tuple[str, str], KubernetesRole]
    policies: dict[str, acl.Policy]
    quotas: list[Quota]

    @classmethod
    def load(cls, root: Path) -> VaultConfig:
        base = root / "vault"
        config = cls({}, {}, {}, {}, [])
        role_files = []
        for path in files_under(base, (".json", ".hcl")):
            rel = path.relative_to(base).as_posix()
            stem, suffix = rel.rsplit(".", 1)
            source = display(path, root)
            if stem.startswith("sys/mounts/") and suffix == "json":
                data = as_dict(load_json(path, root))
                config.secret_mounts[stem[len("sys/mounts/"):] + "/"] = data
            elif stem.startswith("sys/auth/") and suffix == "json":
                config.auth_mounts[stem[len("sys/auth/"):]] = str(as_dict(load_json(path, root)).get("type"))
            elif stem.startswith("sys/policies/acl/"):
                name = stem[len("sys/policies/acl/"):]
                if suffix == "hcl":
                    config.policies[name] = acl.parse_hcl_policy(name, read_text(path, root), source)
                else:
                    config.policies[name] = acl.parse_json_policy(name, load_json(path, root), source)
            elif stem.startswith("sys/quotas/rate-limit/") and suffix == "json":
                config.quotas.append(_quota(stem.rsplit("/", 1)[1], load_json(path, root), source))
            elif stem.startswith("auth/") and "/role/" in stem and suffix == "json":
                role_files.append((path, stem, source))
        for path, stem, source in role_files:
            mount, name = stem[len("auth/"):].rsplit("/role/", 1)
            if config.auth_mounts.get(mount) == "kubernetes":
                config.roles[(mount, name)] = _role(mount, name, load_json(path, root), source)
        return config


def _quota(name: str, data: Any, source: str) -> Quota:
    data = as_dict(data)
    try:
        rate = float(data.get("rate"))
        interval = parse_duration(data.get("interval", "1s")) or 1.0
    except (TypeError, ValueError):
        raise RepoError(f"{source}: rate or interval is not a number") from None
    return Quota(name, str(data.get("path") or ""), rate, interval)


@dataclass(frozen=True)
class ServiceAccountJwt:
    """A Kubernetes service account token, as its claims."""

    cluster: str
    namespace: str
    service_account: str
    audiences: tuple[str, ...]
    expires_in: float


@dataclass(frozen=True)
class VaultToken:
    policies: frozenset[str]
    ttl: float
    max_ttl: float
    role: str


@dataclass(frozen=True)
class LoginResult:
    token: VaultToken | None
    reason: str = ""


class VaultError(Exception):
    """A request Vault refuses (permission denied, no such secret)."""


class FakeVault:
    """Vault's ACLs, KV v2 and kubernetes auth over a VaultConfig.

    `token_review(cluster)` returns None when Vault can review a token issued by `cluster`
    against its API server, else what went wrong.
    """

    def __init__(self, config: VaultConfig, token_review: Callable[[str], str | None]) -> None:
        self.config = config
        self.token_review = token_review
        self._secrets: dict[str, tuple[dict[str, Any], int]] = {}

    # Kubernetes auth

    @staticmethod
    def cluster_of_mount(mount: str) -> str | None:
        """The cluster an auth mount reviews tokens against (rule: k8s-<clusterName>)."""
        return mount[len(CLUSTER_MOUNT_PREFIX):] if mount.startswith(CLUSTER_MOUNT_PREFIX) else None

    def kubernetes_mounts(self) -> list[str]:
        return sorted(m for m, kind in self.config.auth_mounts.items() if kind == "kubernetes")

    def roles_on(self, mount: str) -> list[KubernetesRole]:
        return [r for (m, _), r in sorted(self.config.roles.items()) if m == mount]

    def login(self, mount: str, role_name: str, jwt: ServiceAccountJwt) -> LoginResult:
        mount = mount.strip("/")
        if self.config.auth_mounts.get(mount) != "kubernetes":
            return LoginResult(None, f"no kubernetes auth method is mounted at auth/{mount}")
        role = self.config.roles.get((mount, role_name))
        if role is None:
            return LoginResult(None, f"role {role_name!r} does not exist on auth/{mount}")
        cluster = self.cluster_of_mount(mount)
        if jwt.cluster != cluster:
            return LoginResult(None, f"the token comes from cluster {jwt.cluster}, and auth/{mount} "
                                     f"reviews tokens from {cluster or 'no cluster'}")
        if jwt.expires_in <= 0:
            return LoginResult(None, "the token has expired")
        if "*" not in role.names and jwt.service_account not in role.names:
            return LoginResult(None, f"service account name {jwt.service_account} is not authorized")
        if "*" not in role.namespaces and jwt.namespace not in role.namespaces:
            return LoginResult(None, f"namespace {jwt.namespace} is not authorized")
        if role.audience and role.audience not in jwt.audiences:
            return LoginResult(None, f"audience {', '.join(jwt.audiences)} is not {role.audience}")
        problem = self.token_review(jwt.cluster)
        if problem:
            return LoginResult(None, f"the token review failed: {problem}")
        policies = set(role.policies) | (set() if role.no_default_policy else {"default"})
        return LoginResult(VaultToken(frozenset(policies), role.ttl, role.max_ttl, role.name))

    # ACL

    def capabilities(self, token: VaultToken, path: str) -> frozenset[str]:
        if "root" in token.policies:
            return acl.ALL_CAPABILITIES
        policies = [self.config.policies[p] for p in token.policies if p in self.config.policies]
        if "default" in token.policies and "default" not in self.config.policies:
            policies.append(acl.DEFAULT_POLICY)
        return acl.capabilities(policies, path)

    # KV

    def _mount_of(self, path: str) -> tuple[str, dict[str, Any]] | None:
        mounts = [m for m in self.config.secret_mounts if path.startswith(m)]
        if not mounts:
            return None
        mount = max(mounts, key=len)
        return mount, self.config.secret_mounts[mount]

    def _is_kv2(self, mount: dict[str, Any]) -> bool:
        version = str(as_dict(mount.get("options")).get("version", "1"))
        return mount.get("type") == "kv-v2" or (mount.get("type") == "kv" and version == "2")

    def data_path(self, path: str) -> str:
        """The API path a read of `path` uses: KV v2 paths get `data/` as consul-template adds it."""
        path = path.strip().strip("/")
        found = self._mount_of(path)
        if found is None or not self._is_kv2(found[1]):
            return path
        mount, _ = found
        rest = path[len(mount):]
        return path if rest.startswith("data/") else f"{mount}data/{rest}"

    def write_secret(self, path: str, fields: dict[str, Any]) -> None:
        """Store a secret as its owner would (no ACL check): a new version each time."""
        key = self.data_path(path)
        version = self._secrets.get(key, ({}, 0))[1] + 1
        self._secrets[key] = (dict(fields), version)

    def read_secret(self, token: VaultToken, path: str) -> dict[str, Any]:
        """The read response for `path` as the token may see it (KV v2: data.data and
        data.metadata; KV v1: data)."""
        key = self.data_path(path)
        mount = self._mount_of(key)
        if mount is None:
            raise VaultError(f"no secrets engine is mounted at {path}")
        if "read" not in self.capabilities(token, key):
            raise VaultError(f"permission denied reading {key}")
        if key not in self._secrets:
            raise VaultError(f"no secret at {key}")
        fields, version = self._secrets[key]
        if not self._is_kv2(mount[1]):
            return {"data": dict(fields)}
        return {"data": {"data": dict(fields), "metadata": {"version": version}}}

    def quota_for(self, api_path: str) -> Quota | None:
        """The most specific rate-limit quota covering `api_path`."""
        covering = [q for q in self.config.quotas if api_path.startswith(q.path)]
        return max(covering, key=lambda q: len(q.path)) if covering else None
