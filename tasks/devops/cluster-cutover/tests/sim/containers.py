"""A pod's volumes and containers as the API server and kubelet set them up (SPEC section 3.7).

Volumes are materialised as real folders under the test's temporary directory; the ownership and
mode of the files in them are simulated metadata, never real permission bits. A path inside a
container resolves through its volumeMounts (the longest matching mountPath, then subPath); a path
on no mount is on the container's own filesystem, where nothing the tests look at exists.
"""

from __future__ import annotations

import json
import posixpath
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .k8s import Manifests, as_dict, as_list

DEFAULT_AUDIENCE = "https://kubernetes.default.svc.cluster.local"
AUTOMOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
DEFAULT_TOKEN_SECONDS = 3600
MIN_TOKEN_SECONDS = 600
DEFAULT_MODE = 0o644
IMAGE_USERS = (("hashicorp/vault", (100, 1000)), ("quayside/payments", (10001, 10001)))


class PodRejected(Exception):
    """The pod is never created or never starts; the message says what happened."""


@dataclass(frozen=True)
class FileMeta:
    uid: int
    gid: int
    mode: int


@dataclass(frozen=True)
class ProjectedToken:
    """A service account token file: its audience and lifetime in seconds."""

    audience: str
    lifetime: int


class Volume:
    """One pod volume and the files in it."""

    def __init__(self, name: str, kind: str, host_dir: Path, memory: bool = False,
                 writable: bool = False) -> None:
        self.name = name
        self.kind = kind
        self.host_dir = host_dir
        self.memory = memory
        self.writable = writable
        self.files: dict[str, FileMeta] = {}
        self.tokens: dict[str, ProjectedToken] = {}
        host_dir.mkdir(parents=True, exist_ok=True)

    @property
    def memory_backed_empty_dir(self) -> bool:
        return self.kind == "emptyDir" and self.memory

    def describe(self) -> str:
        backing = "memory" if self.memory else "disk"
        return f"{self.kind} volume {self.name} ({backing})"

    def add_file(self, rel: str, content: bytes, meta: FileMeta) -> None:
        target = self.host_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        self.files[rel] = meta

    def add_token(self, rel: str, token: ProjectedToken, meta: FileMeta) -> None:
        claims = {"aud": [token.audience], "exp_in": token.lifetime, "note": "fake token"}
        self.add_file(rel, json.dumps(claims).encode(), meta)
        self.tokens[rel] = token


@dataclass(frozen=True)
class Mount:
    volume: Volume
    path: str
    sub_path: str
    read_only: bool

    @property
    def writable(self) -> bool:
        return self.volume.writable and not self.read_only


@dataclass
class Container:
    name: str
    image: str
    argv: tuple[str, ...]
    env: dict[str, str]
    env_problem: str | None
    mounts: list[Mount]
    uid: int
    gid: int
    groups: frozenset[int]
    init: bool

    def locate(self, path: str) -> tuple[Mount, str] | None:
        """The mount an absolute path is on and the path inside its volume."""
        if not path.startswith("/"):
            return None
        path = posixpath.normpath(path)
        best: tuple[Mount, str] | None = None
        for mount in self.mounts:
            base = mount.path.rstrip("/")
            if path == (base or "/") or path.startswith(base + "/"):
                if best is None or len(base) > len(best[0].path.rstrip("/")):
                    best = (mount, path[len(base):].lstrip("/"))
        if best is None:
            return None
        mount, rest = best
        rel = posixpath.normpath(posixpath.join(mount.sub_path, rest)) if mount.sub_path or rest else ""
        if rel == ".":
            rel = ""
        return None if rel.startswith("..") else (mount, rel)

    def host_path(self, path: str) -> Path | None:
        located = self.locate(path)
        if located is None:
            return None
        mount, rel = located
        return mount.volume.host_dir / rel if rel else mount.volume.host_dir

    def read(self, path: str) -> bytes | None:
        """A file's content as the container sees it, or None."""
        host = self.host_path(path)
        return host.read_bytes() if host is not None and host.is_file() else None

    def token_at(self, path: str) -> ProjectedToken | None:
        located = self.locate(path)
        return located[0].volume.tokens.get(located[1]) if located else None

    def tokens(self) -> list[tuple[str, ProjectedToken]]:
        """Every service account token file the container can read, with its path in it."""
        found = []
        for mount in self.mounts:
            prefix = mount.sub_path.strip("/")
            for rel, token in mount.volume.tokens.items():
                if prefix and rel != prefix and not rel.startswith(prefix + "/"):
                    continue
                inner = rel[len(prefix):].lstrip("/")
                found.append((posixpath.join(mount.path, inner) if inner else mount.path, token))
        return found

    def can_read(self, meta: FileMeta) -> bool:
        """Owner with the owner read bit, a group member with the group read bit, or other read."""
        if meta.uid == self.uid and meta.mode & 0o400:
            return True
        if meta.gid in self.groups and meta.mode & 0o040:
            return True
        return bool(meta.mode & 0o004)


def _key_files(values: dict[str, bytes] | None, spec: dict[str, Any], what: str
               ) -> dict[str, tuple[bytes, Any]]:
    """{path in the volume: (content, item mode)} for a configMap/secret source with `items`."""
    optional = spec.get("optional") is True
    if values is None:
        if optional:
            return {}
        raise PodRejected(f"{what} does not exist")
    items = as_list(spec.get("items"))
    if not items:
        return {key: (value, None) for key, value in values.items()}
    files = {}
    for item in map(as_dict, items):
        key = str(item.get("key"))
        if key not in values:
            if optional:
                continue
            raise PodRejected(f"{what} has no key {key}")
        files[str(item.get("path") or key)] = (values[key], item.get("mode"))
    return files


def _mode(*candidates: Any) -> int:
    return next((c for c in candidates if isinstance(c, int) and not isinstance(c, bool)), DEFAULT_MODE)


def _projected_sources(volume: Volume, raw: dict[str, Any], namespace: str, manifests: Manifests,
                       fs_group: int | None) -> None:
    default_mode = raw.get("defaultMode")
    for source in map(as_dict, as_list(raw.get("sources"))):
        if "serviceAccountToken" in source:
            spec = as_dict(source.get("serviceAccountToken"))
            lifetime = spec.get("expirationSeconds", DEFAULT_TOKEN_SECONDS)
            if not isinstance(lifetime, int) or lifetime < MIN_TOKEN_SECONDS:
                raise PodRejected(f"the API server rejects the pod: volume {volume.name} asks for a "
                                  f"token with expirationSeconds {lifetime} (minimum 600)")
            token = ProjectedToken(str(spec.get("audience") or DEFAULT_AUDIENCE), lifetime)
            volume.add_token(str(spec.get("path") or "token"), token,
                             FileMeta(0, fs_group or 0, _mode(default_mode, 0o600)))
        for key, getter, kind in (("configMap", manifests.config_map, "ConfigMap"),
                                  ("secret", manifests.secret, "Secret")):
            if key in source:
                spec = as_dict(source.get(key))
                name = str(spec.get("name"))
                files = _key_files(getter(namespace, name), spec, f"{kind} {namespace}/{name}")
                for rel, (content, mode) in files.items():
                    volume.add_file(rel, content, FileMeta(0, fs_group or 0, _mode(mode, default_mode)))


def build_volumes(pod_spec: dict[str, Any], namespace: str, manifests: Manifests, root: Path,
                  fs_group: int | None) -> dict[str, Volume]:
    volumes: dict[str, Volume] = {}
    for raw in map(as_dict, as_list(pod_spec.get("volumes"))):
        name = str(raw.get("name"))
        host_dir = root / f"{len(volumes)}-{''.join(c if c.isalnum() else '_' for c in name)}"
        if "emptyDir" in raw:
            medium = as_dict(raw.get("emptyDir")).get("medium") == "Memory"
            volume = Volume(name, "emptyDir", host_dir, memory=medium, writable=True)
        elif "configMap" in raw or "secret" in raw:
            kind = "configMap" if "configMap" in raw else "secret"
            spec = as_dict(raw.get(kind))
            object_name = str(spec.get("name") if kind == "configMap" else spec.get("secretName"))
            getter = manifests.config_map if kind == "configMap" else manifests.secret
            label = f"{'ConfigMap' if kind == 'configMap' else 'Secret'} {namespace}/{object_name}"
            try:
                files = _key_files(getter(namespace, object_name), spec, label)
            except PodRejected as exc:
                raise PodRejected(f"volume {name}: {exc}") from None
            volume = Volume(name, kind, host_dir, memory=kind == "secret")
            for rel, (content, mode) in files.items():
                volume.add_file(rel, content, FileMeta(0, fs_group or 0,
                                                       _mode(mode, spec.get("defaultMode"))))
        elif "projected" in raw:
            volume = Volume(name, "projected", host_dir, memory=True)
            try:
                _projected_sources(volume, as_dict(raw.get("projected")), namespace, manifests, fs_group)
            except PodRejected as exc:
                raise PodRejected(f"volume {name}: {exc}") from None
        elif "hostPath" in raw or "persistentVolumeClaim" in raw:
            kind = "hostPath" if "hostPath" in raw else "persistentVolumeClaim"
            volume = Volume(name, kind, host_dir, writable=True)
        else:
            volume = Volume(name, "other", host_dir)
        volumes[name] = volume
    return volumes


def automount_volume(root: Path) -> Volume:
    """The kube-api-access volume the API server adds when automounting is in effect."""
    volume = Volume("kube-api-access", "projected", root / "kube-api-access", memory=True)
    volume.add_token("token", ProjectedToken(DEFAULT_AUDIENCE, DEFAULT_TOKEN_SECONDS),
                     FileMeta(0, 0, DEFAULT_MODE))
    volume.add_file("ca.crt", b"-----FAKE CLUSTER CA-----\n", FileMeta(0, 0, DEFAULT_MODE))
    return volume


def image_user(image: str) -> tuple[int, int]:
    """The default uid:gid of an image (SPEC 3.7): Vault's and payments', else root."""
    repository = image.split("@", 1)[0]
    head, _, last = repository.rpartition("/")
    repository = f"{head}/{last.split(':', 1)[0]}" if head else last.split(":", 1)[0]
    for suffix, ids in IMAGE_USERS:
        if repository == suffix or repository.endswith("/" + suffix):
            return ids
    return (0, 0)


def _first_int(*values: Any) -> int | None:
    return next((v for v in values if isinstance(v, int) and not isinstance(v, bool)), None)


def _value_from(source: dict[str, Any], namespace: str, manifests: Manifests
                ) -> tuple[str | None, str | None]:
    """(value, problem) for an env valueFrom."""
    for key, getter, kind in (("secretKeyRef", manifests.secret, "Secret"),
                              ("configMapKeyRef", manifests.config_map, "ConfigMap")):
        if key in source:
            ref = as_dict(source.get(key))
            values = getter(namespace, str(ref.get("name")))
            wanted = str(ref.get("key"))
            if values is not None and wanted in values:
                return values[wanted].decode(errors="replace"), None
            if ref.get("optional") is True:
                return None, None
            return None, f"{kind} {ref.get('name')} key {wanted} does not exist"
    return "", None


def resolve_environment(raw: dict[str, Any], namespace: str, manifests: Manifests
                        ) -> tuple[dict[str, str], str | None]:
    """The container's environment, and why it cannot start (a missing reference) if so."""
    env: dict[str, str] = {}
    for source in map(as_dict, as_list(raw.get("envFrom"))):
        prefix = str(source.get("prefix") or "")
        for key, getter, kind in (("configMapRef", manifests.config_map, "ConfigMap"),
                                  ("secretRef", manifests.secret, "Secret")):
            ref = source.get(key)
            if not isinstance(ref, dict):
                continue
            values = getter(namespace, str(ref.get("name")))
            if values is None:
                if ref.get("optional") is True:
                    continue
                return env, f"envFrom {kind} {ref.get('name')} does not exist"
            env.update({prefix + k: v.decode(errors="replace") for k, v in values.items()})
    for var in map(as_dict, as_list(raw.get("env"))):
        name = str(var.get("name"))
        if "valueFrom" in var:
            value, problem = _value_from(as_dict(var.get("valueFrom")), namespace, manifests)
            if problem:
                return env, f"env {name}: {problem}"
            if value is not None:
                env[name] = value
        else:
            env[name] = "" if var.get("value") is None else str(var.get("value"))
    return env, None


def build_container(raw: dict[str, Any], *, init: bool, pod_spec: dict[str, Any], namespace: str,
                    manifests: Manifests, volumes: dict[str, Volume],
                    token_volume: Volume | None) -> Container:
    name = str(raw.get("name"))
    image = str(raw.get("image") or "")
    argv = tuple(str(a) for a in as_list(raw.get("command")) + as_list(raw.get("args")))
    env, problem = resolve_environment(raw, namespace, manifests)
    mounts = []
    for spec in map(as_dict, as_list(raw.get("volumeMounts"))):
        volume = volumes.get(str(spec.get("name")))
        if volume is None:
            raise PodRejected(f"container {name} mounts volume {spec.get('name')}, "
                              "which the pod does not declare")
        path = posixpath.normpath(str(spec.get("mountPath") or "/"))
        mounts.append(Mount(volume, path, str(spec.get("subPath") or "").strip("/"),
                            spec.get("readOnly") is True))
    if token_volume is not None and all(m.path != AUTOMOUNT_DIR for m in mounts):
        mounts.append(Mount(token_volume, AUTOMOUNT_DIR, "", True))
    pod_security = as_dict(pod_spec.get("securityContext"))
    security = as_dict(raw.get("securityContext"))
    default_uid, default_gid = image_user(image)
    uid = _first_int(security.get("runAsUser"), pod_security.get("runAsUser"), default_uid)
    gid = _first_int(security.get("runAsGroup"), pod_security.get("runAsGroup"), default_gid)
    groups = {gid}
    if (fs_group := _first_int(pod_security.get("fsGroup"))) is not None:
        groups.add(fs_group)
    groups |= {g for g in as_list(pod_security.get("supplementalGroups")) if isinstance(g, int)}
    return Container(name, image, argv, env, problem, mounts, uid or 0, gid or 0,
                     frozenset(groups), init)
