"""The API server: authentication of credential-less requests and authorization (SPEC 3.2).

Without credentials a request is `system:anonymous` (group system:unauthenticated) unless
anonymous-auth is off, in which case it is rejected with 401 on every path, /readyz included.
Authorization: AlwaysAllow anywhere in the mode list allows everything; otherwise RBAC decides
when it is in the list (the Node authorizer only concerns kubelets and is not modelled).
"""

from __future__ import annotations

from .kubeadm import ApiServerFlags
from .rbac import ANONYMOUS, Identity, Rbac, Request


class ApiServer:
    def __init__(self, flags: ApiServerFlags, rbac: Rbac) -> None:
        self.flags = flags
        self.rbac = rbac

    def caller(self, identity: Identity | None) -> Identity | None:
        """Who a request runs as; None for a credential-less request that gets a 401."""
        if identity is not None:
            return identity
        return ANONYMOUS if self.flags.anonymous_auth else None

    def authorize(self, identity: Identity, request: Request) -> bool:
        if "AlwaysAllow" in self.flags.authorization_modes:
            return True
        return "RBAC" in self.flags.authorization_modes and self.rbac.allows(identity, request)

    def answers(self, identity: Identity | None, request: Request) -> bool:
        """Whether the request (None: no credentials) is authenticated and authorized."""
        caller = self.caller(identity)
        return caller is not None and self.authorize(caller, request)
