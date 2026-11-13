"""The Kubernetes dashboard (SPEC section 3.4).

The Deployment `kubernetes-dashboard` in namespace `kubernetes-dashboard`, if it exists. Login is
skipped when a container's command or args carry `--enable-skip-login` (bare or true); a visitor
who skips it acts as the Deployment's service account. It is reachable on the nodePort of a
NodePort Service in that namespace whose selector matches the Deployment's pods.
"""

from __future__ import annotations

from .k8s import K8sObject, Manifests, as_dict, as_list
from .kubeadm import go_bool
from .rbac import Identity, service_account

NAMESPACE = "kubernetes-dashboard"
DEPLOYMENT = "kubernetes-dashboard"
SKIP_LOGIN = "--enable-skip-login"


def _skips_login(container: dict) -> bool:
    for arg in as_list(container.get("command")) + as_list(container.get("args")):
        flag, has_value, value = str(arg).partition("=")
        if flag == SKIP_LOGIN and (not has_value or go_bool(value, False)):
            return True
    return False


class Dashboard:
    def __init__(self, manifests: Manifests) -> None:
        self.manifests = manifests
        self.deployment: K8sObject | None = manifests.find("Deployment", DEPLOYMENT, NAMESPACE)

    @property
    def pod_spec(self) -> dict:
        return as_dict(as_dict(self.deployment.spec.get("template")).get("spec")) if self.deployment else {}

    @property
    def pod_labels(self) -> dict:
        if self.deployment is None:
            return {}
        return as_dict(as_dict(as_dict(self.deployment.spec.get("template")).get("metadata")).get("labels"))

    def service_account(self) -> Identity | None:
        """The identity the dashboard's pods run as, if it is deployed."""
        if self.deployment is None:
            return None
        spec = self.pod_spec
        name = spec.get("serviceAccountName") or spec.get("serviceAccount") or "default"
        return service_account(NAMESPACE, str(name))

    def visitor_identity(self) -> Identity | None:
        """Who a visitor who has not logged in acts as (None: nobody)."""
        containers = as_list(self.pod_spec.get("containers"))
        if any(_skips_login(as_dict(c)) for c in containers):
            return self.service_account()
        return None

    def node_ports(self) -> list[int]:
        """nodePorts of NodePort Services in its namespace that select its pods."""
        labels = {str(k): str(v) for k, v in self.pod_labels.items()}
        ports = []
        for service in self.manifests.of_kind("Service"):
            spec = service.spec
            selector = {str(k): str(v) for k, v in as_dict(spec.get("selector")).items()}
            if service.namespace != NAMESPACE or spec.get("type") not in ("NodePort", "LoadBalancer"):
                continue
            if not selector or any(labels.get(k) != v for k, v in selector.items()):
                continue
            ports += [p["nodePort"] for p in map(as_dict, as_list(spec.get("ports")))
                      if isinstance(p.get("nodePort"), int)]
        return ports
