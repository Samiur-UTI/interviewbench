"""The objects the pipeline applies from deploy/k8s/ (SPEC sections 2.4 and 3).

Every YAML file under deploy/k8s/ is read, whatever its name, including multi-document files,
empty documents and `kind: List`. An object without `metadata.namespace` that is namespaced lives
in `default`. When two files declare the same object, the later one in path order wins, as with
`kubectl apply` over the directory.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .repo import RepoError, display, files_under, load_yaml_documents

CLUSTER_SCOPED_KINDS = frozenset({
    "APIService", "CSIDriver", "ClusterIssuer", "ClusterRole", "ClusterRoleBinding",
    "CustomResourceDefinition", "IngressClass", "MutatingWebhookConfiguration", "Namespace",
    "Node", "PersistentVolume", "PriorityClass", "RuntimeClass", "StorageClass",
    "ValidatingWebhookConfiguration", "VolumeAttachment",
})
BUILTIN_NAMESPACES = ("default", "kube-system", "kube-public")
PLATFORM_CA_CONFIGMAP = "platform-ca"
PLATFORM_CA = "-----FAKE PLATFORM CA-----\n"


def as_dict(value: Any) -> dict[str, Any]:
    """`value` if it is a mapping, else an empty one."""
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    """`value` if it is a list, else an empty one."""
    return value if isinstance(value, list) else []


@dataclass(frozen=True)
class K8sObject:
    """One applied object. `namespace` is None for cluster-scoped kinds."""

    kind: str
    name: str
    namespace: str | None
    body: dict[str, Any]
    source: str

    @property
    def spec(self) -> dict[str, Any]:
        return as_dict(self.body.get("spec"))

    @property
    def labels(self) -> dict[str, Any]:
        return as_dict(as_dict(self.body.get("metadata")).get("labels"))

    def describe(self) -> str:
        where = f"{self.namespace}/" if self.namespace else ""
        return f"{self.kind} {where}{self.name} ({self.source})"


def object_from(raw: dict[str, Any], source: str) -> K8sObject:
    """A K8sObject from one manifest mapping, defaulting the namespace as the API server does."""
    kind = raw.get("kind")
    if not isinstance(kind, str) or not kind:
        raise RepoError(f"{source}: an object has no kind")
    metadata = as_dict(raw.get("metadata"))
    name = metadata.get("name")
    if name is None or name == "":
        raise RepoError(f"{source}: a {kind} has no metadata.name")
    namespace = None
    if kind not in CLUSTER_SCOPED_KINDS:
        namespace = str(metadata.get("namespace") or "default")
    return K8sObject(kind, str(name), namespace, raw, source)


def _objects_in(document: Any, source: str) -> Iterator[K8sObject]:
    if not isinstance(document, dict):
        raise RepoError(f"{source}: a YAML document is not a mapping")
    if document.get("kind") == "List":
        for item in as_list(document.get("items")):
            yield from _objects_in(item, source)
        return
    yield object_from(document, source)


def _decode_secret_data(obj: K8sObject) -> dict[str, bytes]:
    values: dict[str, bytes] = {}
    for key, value in as_dict(obj.body.get("data")).items():
        try:
            values[str(key)] = base64.b64decode(str(value), validate=True)
        except (binascii.Error, ValueError):
            raise RepoError(f"{obj.source}: Secret {obj.name} key {key} is not base64") from None
    for key, value in as_dict(obj.body.get("stringData")).items():
        values[str(key)] = str(value).encode()
    return values


class Manifests:
    """The objects in deploy/k8s/, indexed by kind, namespace and name."""

    def __init__(self, objects: list[K8sObject]) -> None:
        latest: dict[tuple[str, str | None, str], K8sObject] = {}
        for obj in objects:
            latest[(obj.kind, obj.namespace, obj.name)] = obj
        self.objects = list(latest.values())

    @classmethod
    def load(cls, root: Path) -> Manifests:
        objects: list[K8sObject] = []
        for path in files_under(root / "deploy" / "k8s", (".yaml", ".yml")):
            source = display(path, root)
            for document in load_yaml_documents(path, root):
                objects.extend(_objects_in(document, source))
        return cls(objects)

    def of_kind(self, *kinds: str) -> list[K8sObject]:
        return [obj for obj in self.objects if obj.kind in kinds]

    def find(self, kind: str, name: str, namespace: str | None = None) -> K8sObject | None:
        for obj in self.objects:
            if obj.kind == kind and obj.name == name and obj.namespace == namespace:
                return obj
        return None

    def namespaces(self) -> list[str]:
        """Namespaces that exist: the declared ones and the three every cluster has."""
        declared = {obj.name for obj in self.of_kind("Namespace")}
        return sorted(declared | set(BUILTIN_NAMESPACES))

    def service_accounts(self) -> list[tuple[str, str]]:
        """(namespace, name) of every ServiceAccount: declared ones and each namespace's default."""
        accounts = {(obj.namespace or "default", obj.name) for obj in self.of_kind("ServiceAccount")}
        accounts |= {(ns, "default") for ns in self.namespaces()}
        return sorted(accounts)

    def has_service_account(self, namespace: str, name: str) -> bool:
        return (namespace, name) in self.service_accounts()

    def config_map(self, namespace: str, name: str) -> dict[str, bytes] | None:
        """A ConfigMap's keys, including trust-manager's `platform-ca` in every namespace."""
        if name == PLATFORM_CA_CONFIGMAP and namespace in self.namespaces():
            return {"ca.crt": PLATFORM_CA.encode()}
        obj = self.find("ConfigMap", name, namespace)
        if obj is None:
            return None
        values = {str(k): str(v).encode() for k, v in as_dict(obj.body.get("data")).items()}
        for key, value in as_dict(obj.body.get("binaryData")).items():
            try:
                values[str(key)] = base64.b64decode(str(value), validate=True)
            except (binascii.Error, ValueError):
                raise RepoError(f"{obj.source}: ConfigMap {name} key {key} is not base64") from None
        return values

    def secret(self, namespace: str, name: str) -> dict[str, bytes] | None:
        obj = self.find("Secret", name, namespace)
        return None if obj is None else _decode_secret_data(obj)

    def pod_specs(self) -> list[tuple[K8sObject, dict[str, Any]]]:
        """(workload, pod spec) for every object that creates pods."""
        found = []
        for obj in self.objects:
            if obj.kind == "Pod":
                found.append((obj, obj.spec))
            elif obj.kind in ("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"):
                found.append((obj, as_dict(as_dict(obj.spec.get("template")).get("spec"))))
            elif obj.kind == "CronJob":
                job = as_dict(as_dict(obj.spec.get("jobTemplate")).get("spec"))
                found.append((obj, as_dict(as_dict(job.get("template")).get("spec"))))
        return found
