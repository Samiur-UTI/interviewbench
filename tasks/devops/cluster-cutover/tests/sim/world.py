"""Everything the simulator builds from one repository, loaded lazily.

Each part raises RepoError (naming the file) when its files cannot be read; nothing is cached on
failure, so every check that needs a broken file fails with that message and the others run.
"""

from __future__ import annotations

from functools import cached_property
from pathlib import Path

from . import kubeadm
from .apiserver import ApiServer
from .dashboard import Dashboard
from .firewall import Firewall
from .k8s import Manifests
from .kubelet import Kubelet
from .payments_app import KEY_A, WEBHOOK_A, FakeStripe, Payments
from .pod import PaymentsPod
from .rbac import Rbac, ResourceRequest, service_account
from .vault import FakeVault, VaultConfig

VAULT_EGRESS = "203.0.113.60"
VAULT_AUTH = service_account("platform", "vault-auth")
TOKEN_REVIEW = ResourceRequest("create", "tokenreviews", group="authentication.k8s.io")
STRIPE_PATH = "kv/payments/stripe"
SEEDED_SECRETS = {
    STRIPE_PATH: {"secret_key": KEY_A, "webhook_secret": WEBHOOK_A},
    "kv/payments/stripe-connect": {"client_secret": "sk_live_fake-C3-connect-interviewbench"},
    "kv/payments-ledger/db": {"password": "fake-ledger-db-password"},
    "kv/orders/postgres": {"password": "fake-orders-postgres-password"},
    "kv-stg/payments/stripe": {"secret_key": "sk_test_fake-S1-interviewbench",
                               "webhook_secret": "whsec_fake-S1-interviewbench"},
}


class World:
    def __init__(self, root: Path) -> None:
        self.root = root

    @cached_property
    def manifests(self) -> Manifests:
        return Manifests.load(self.root)

    @cached_property
    def cluster(self) -> kubeadm.ClusterSetup:
        return kubeadm.load(self.root)

    @cached_property
    def rbac(self) -> Rbac:
        return Rbac(self.manifests)

    @cached_property
    def apiserver(self) -> ApiServer:
        return ApiServer(self.cluster.apiserver, self.rbac)

    @cached_property
    def kubelet(self) -> Kubelet:
        return Kubelet(self.cluster.kubelet, self.apiserver)

    @cached_property
    def firewall(self) -> Firewall:
        return Firewall.load(self.root)

    @cached_property
    def dashboard(self) -> Dashboard:
        return Dashboard(self.manifests)

    @cached_property
    def vault_config(self) -> VaultConfig:
        return VaultConfig.load(self.root)

    def token_review_problem(self, cluster: str) -> str | None:
        """Why Vault cannot review a token from `cluster` against its API server (None: it can).
        Only this repository's cluster is modelled; other clusters' reviews are assumed to work."""
        if cluster != self.cluster.cluster_name:
            return None
        if not self.firewall.allows(VAULT_EGRESS, "control-plane", "tcp", 6443):
            return f"the firewall drops {VAULT_EGRESS} to the API server on tcp 6443"
        if not self.apiserver.authorize(VAULT_AUTH, TOKEN_REVIEW):
            return "platform/vault-auth may not create tokenreviews"
        return None

    def new_vault(self) -> FakeVault:
        """A Vault built from vault/, with the tests' secrets stored in it."""
        vault = FakeVault(self.vault_config, self.token_review_problem)
        for path, fields in SEEDED_SECRETS.items():
            vault.write_secret(path, fields)
        return vault

    def start_pod(self, payments: Payments, workdir: Path, vault: FakeVault | None = None,
                  stripe: FakeStripe | None = None) -> PaymentsPod:
        """A payments pod on a fresh (or the given) Vault, talking to a fake Stripe."""
        return PaymentsPod.start(self.manifests, self.cluster.cluster_name,
                                 vault or self.new_vault(), payments,
                                 stripe or FakeStripe(KEY_A), workdir)
