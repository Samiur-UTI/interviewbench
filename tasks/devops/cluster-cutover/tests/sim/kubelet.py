"""A kubelet's HTTP endpoints on 10250 and its read-only port (SPEC section 3.3).

On 10250: a bearer token authenticates only when webhook authentication is on, otherwise the
caller counts as having no credentials; a caller without credentials is rejected unless anonymous
authentication is on. Under AlwaysAllow every authenticated caller may do everything; under
Webhook the request becomes a SubjectAccessReview on nodes/<subresource> that the API server
decides. A non-zero readOnlyPort answers anyone without authentication.
"""

from __future__ import annotations

from .apiserver import ApiServer
from .kubeadm import KubeletConfig
from .rbac import ANONYMOUS, Identity, ResourceRequest

SECURE_PORT = 10250
_SUBRESOURCES = (("/metrics", "metrics"), ("/stats", "stats"), ("/logs", "log"), ("/spec", "spec"))


def node_request(method: str, path: str, node: str) -> ResourceRequest:
    """The RBAC request the kubelet asks the API server about for an HTTP request."""
    subresource = next((sub for prefix, sub in _SUBRESOURCES if path.startswith(prefix)), "proxy")
    verb = "create" if method.upper() == "POST" else "get"
    return ResourceRequest(verb, "nodes", subresource=subresource, name=node)


class Kubelet:
    def __init__(self, config: KubeletConfig, apiserver: ApiServer, node: str = "w-1") -> None:
        self.config = config
        self.apiserver = apiserver
        self.node = node

    def answers(self, port: int, bearer: Identity | None, method: str, path: str) -> bool:
        """Whether a request with this bearer token (None: no credentials) gets a 200."""
        if port == SECURE_PORT:
            return self._secure_port_answers(bearer, method, path)
        return self.config.read_only_port != 0 and port == self.config.read_only_port

    def unauthenticated_ports(self) -> list[int]:
        """Ports that answer without any authentication."""
        return [self.config.read_only_port] if self.config.read_only_port != 0 else []

    def _secure_port_answers(self, bearer: Identity | None, method: str, path: str) -> bool:
        caller = bearer if self.config.webhook_enabled else None
        if caller is None:
            if not self.config.anonymous_enabled:
                return False
            caller = ANONYMOUS
        if self.config.authorization_mode == "AlwaysAllow":
            return True
        if self.config.authorization_mode != "Webhook":
            return False
        return self.apiserver.authorize(caller, node_request(method, path, self.node))
