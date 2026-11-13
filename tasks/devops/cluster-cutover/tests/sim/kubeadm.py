"""infra/cluster/kubeadm.yaml: the API server's flags and the kubelet's configuration.

SPEC section 3.2 (API server flags, defaults as kubeadm sets them) and 3.3 (KubeletConfiguration,
absent fields take the config-file defaults).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .k8s import as_dict, as_list
from .repo import load_yaml_documents

KUBEADM_FILE = Path("infra") / "cluster" / "kubeadm.yaml"

# Go's strconv.ParseBool, which the API server and kubelet use for boolean flags.
GO_FALSE = frozenset({"0", "f", "F", "false", "FALSE", "False"})
GO_TRUE = frozenset({"1", "t", "T", "true", "TRUE", "True"})


def go_bool(value: Any, default: bool) -> bool:
    """A YAML boolean or a Go-style boolean string; anything else is `default`."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip() in GO_TRUE | GO_FALSE:
        return value.strip() in GO_TRUE
    return default


@dataclass(frozen=True)
class ApiServerFlags:
    anonymous_auth: bool = True
    authorization_modes: tuple[str, ...] = ("Node", "RBAC")


@dataclass(frozen=True)
class KubeletConfig:
    anonymous_enabled: bool = False
    webhook_enabled: bool = True
    authorization_mode: str = "Webhook"
    read_only_port: int = 0


@dataclass(frozen=True)
class ClusterSetup:
    cluster_name: str = "kubernetes"
    apiserver: ApiServerFlags = ApiServerFlags()
    kubelet: KubeletConfig = KubeletConfig()


def _flag_text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None else str(value)


def extra_args(api_server: dict[str, Any]) -> dict[str, str]:
    """`apiServer.extraArgs` as a v1beta3 map or a v1beta4 list of {name, value}."""
    raw = api_server.get("extraArgs")
    if isinstance(raw, dict):
        pairs = list(raw.items())
    else:
        pairs = [(as_dict(a).get("name"), as_dict(a).get("value")) for a in as_list(raw)]
    return {str(name): _flag_text(value) for name, value in pairs if name is not None}


def apiserver_flags(cluster_configuration: dict[str, Any]) -> ApiServerFlags:
    """anonymous-auth (default true: anything ParseBool reads as false turns it off) and
    authorization-mode (kubeadm's default Node,RBAC when absent)."""
    args = extra_args(as_dict(cluster_configuration.get("apiServer")))
    anonymous = args.get("anonymous-auth", "true").strip() not in GO_FALSE
    modes_text = args.get("authorization-mode", "Node,RBAC")
    modes = tuple(m.strip() for m in modes_text.split(",") if m.strip())
    return ApiServerFlags(anonymous, modes)


def kubelet_config(document: dict[str, Any]) -> KubeletConfig:
    authentication = as_dict(document.get("authentication"))
    anonymous = go_bool(as_dict(authentication.get("anonymous")).get("enabled"), False)
    webhook = go_bool(as_dict(authentication.get("webhook")).get("enabled"), True)
    mode = as_dict(document.get("authorization")).get("mode") or "Webhook"
    port = document.get("readOnlyPort", 0)
    if isinstance(port, str) and port.strip().isdigit():
        port = int(port)
    if not isinstance(port, int) or isinstance(port, bool):
        port = 0
    return KubeletConfig(anonymous, webhook, str(mode), port)


def load(root: Path) -> ClusterSetup:
    """The ClusterConfiguration and KubeletConfiguration documents (kubeadm's defaults if absent)."""
    cluster: dict[str, Any] | None = None
    kubelet: dict[str, Any] | None = None
    for document in load_yaml_documents(root / KUBEADM_FILE, root):
        kind = as_dict(document).get("kind")
        if kind == "ClusterConfiguration":
            cluster = document
        elif kind == "KubeletConfiguration":
            kubelet = document
    defaults = ClusterSetup()
    return ClusterSetup(
        cluster_name=str((cluster or {}).get("clusterName") or defaults.cluster_name),
        apiserver=apiserver_flags(cluster) if cluster is not None else defaults.apiserver,
        kubelet=kubelet_config(kubelet) if kubelet is not None else defaults.kubelet,
    )
