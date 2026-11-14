"""A payments pod started from the manifests and run over time (SPEC section 3.7).

Built from Deployment payments-api in namespace payments. Start: init containers in order (an
agent init container must exit, which it does after its first render with exit_after_auth);
then the `payments` container starts, before any agent in `containers` has rendered, by calling
the real build_service with its environment; then the agents in `containers` run. An agent in
`containers` with exit_after_auth exits and is restarted: a crash loop. advance() moves the clock
and lets the running agents re-render.
"""

from __future__ import annotations

from pathlib import Path

from .agent import PodContext, VaultAgent, invocation
from .containers import (Container, FileMeta, Mount, PodRejected, automount_volume,
                         build_container, build_volumes)
from .k8s import Manifests, as_dict, as_list
from .payments_app import CREDENTIALS_ENV, Clock, FakeStripe, Payments, replace_file
from .vault import FakeVault

NAMESPACE = "payments"
DEPLOYMENT = "payments-api"
APP = "payments"
RUNNING, COMPLETED, CRASH_LOOP, WAITING, FAILED = "running", "completed", "crash loop", "waiting", "failed"


def _automount(spec: dict, manifests: Manifests, service_account: str) -> bool:
    """The pod's automountServiceAccountToken, else the ServiceAccount's, else true."""
    if isinstance(spec.get("automountServiceAccountToken"), bool):
        return spec["automountServiceAccountToken"]
    account = manifests.find("ServiceAccount", service_account, NAMESPACE)
    value = account.body.get("automountServiceAccountToken") if account else None
    return value if isinstance(value, bool) else True


class PaymentsPod:
    """One payments pod: its containers, its agents, the running service and what happened."""

    def __init__(self, vault: FakeVault, payments: Payments, stripe: FakeStripe, workdir: Path) -> None:
        self.vault = vault
        self.payments = payments
        self.stripe = stripe
        self.workdir = workdir
        self.clock = Clock()
        self.events: list[str] = []
        self.created = False
        self.service_account: str | None = None
        self.init_containers: list[Container] = []
        self.containers: list[Container] = []
        self.agents: list[VaultAgent] = []
        self.states: dict[str, str] = {}
        self.service: object | None = None
        self.context: PodContext | None = None
        self._writes = 0

    @classmethod
    def start(cls, manifests: Manifests, cluster: str, vault: FakeVault, payments: Payments,
              stripe: FakeStripe, workdir: Path) -> PaymentsPod:
        pod = cls(vault, payments, stripe, workdir)
        try:
            pod._create(manifests, cluster)
        except PodRejected as exc:
            pod.events.append(f"the pod was never created: {exc}")
            return pod
        pod.created = True
        if pod._run_init_containers():
            pod._start_containers()
        return pod

    # What the tests look at

    @property
    def age(self) -> float:
        return self.clock.elapsed

    @property
    def app(self) -> Container | None:
        return next((c for c in self.containers if c.name == APP), None)

    @property
    def all_containers(self) -> list[Container]:
        return self.init_containers + self.containers

    def describe(self) -> str:
        return "; ".join(self.events) or "nothing happened"

    def credentials_location(self) -> tuple[str, tuple[Mount, str] | None] | None:
        """STRIPE_CREDENTIALS_FILE of the payments container and where it resolves."""
        app = self.app
        if app is None or CREDENTIALS_ENV not in app.env:
            return None
        path = app.env[CREDENTIALS_ENV]
        return path, app.locate(path)

    def running_agents(self) -> list[VaultAgent]:
        """Agents in `containers` that keep running and are logged in."""
        return [a for a in self.agents if not a.container.init and self.states.get(a.name) == RUNNING
                and a.token is not None]

    def request_rate(self) -> float:
        """Vault reads per second: per running agent, its distinct secrets over its interval."""
        return sum(len(a.secret_paths) / a.render_interval for a in self.running_agents())

    def advance(self, seconds: float) -> None:
        target = self.clock.elapsed + seconds
        while True:
            due = self.running_agents()
            if not due:
                break
            moment = min(a.next_render for a in due)
            if moment > target:
                break
            self.clock.elapsed = moment
            for agent in due:
                if agent.next_render <= moment:
                    agent.rerender(self.vault, self.context, self._write)
                    agent.next_render += agent.render_interval
        self.clock.elapsed = target

    # Start-up

    def _create(self, manifests: Manifests, cluster: str) -> None:
        deployment = manifests.find("Deployment", DEPLOYMENT, NAMESPACE)
        if deployment is None:
            raise PodRejected("there is no Deployment payments-api in namespace payments")
        spec = as_dict(as_dict(deployment.spec.get("template")).get("spec"))
        account = str(spec.get("serviceAccountName") or spec.get("serviceAccount") or "default")
        if not manifests.has_service_account(NAMESPACE, account):
            raise PodRejected(f"ServiceAccount payments/{account} does not exist")
        self.service_account = account
        fs_group = as_dict(spec.get("securityContext")).get("fsGroup")
        fs_group = fs_group if isinstance(fs_group, int) and not isinstance(fs_group, bool) else None
        volumes = build_volumes(spec, NAMESPACE, manifests, self.workdir / "volumes", fs_group)
        token_volume = automount_volume(self.workdir) if _automount(spec, manifests, account) else None
        for key, init in (("initContainers", True), ("containers", False)):
            built = [build_container(as_dict(raw), init=init, pod_spec=spec, namespace=NAMESPACE,
                                     manifests=manifests, volumes=volumes, token_volume=token_volume)
                     for raw in as_list(spec.get(key))]
            (self.init_containers if init else self.containers).extend(built)
        self.context = PodContext(cluster, NAMESPACE, account, fs_group)

    def _agent(self, container: Container) -> VaultAgent | None:
        how = invocation(container.argv)
        if how is None:
            return None
        agent = VaultAgent(container, how)
        self.agents.append(agent)
        return agent

    def _run_init_containers(self) -> bool:
        for container in self.init_containers:
            name = f"init container {container.name}"
            if container.env_problem:
                self.states[container.name] = WAITING
                self.events.append(f"{name} cannot start: {container.env_problem}")
                return False
            agent = self._agent(container)
            if agent is None:
                self.states[container.name] = COMPLETED
                continue
            if not agent.start(self.vault, self.context, self._write, self.age):
                self.states[container.name] = FAILED
                self.events.append(f"{name} failed (Init:Error): {agent.failure}")
                return False
            if not agent.exits:
                self.states[container.name] = RUNNING
                self.events.append(f"{name} rendered its templates and keeps running, so the pod "
                                   "never leaves Init")
                return False
            self.states[container.name] = COMPLETED
            self.events.append(f"{name} rendered its templates and exited")
        return True

    def _start_containers(self) -> None:
        app = self.app
        if app is None:
            self.events.append("the pod has no container named payments")
        else:
            self._start_app(app)
        for container in self.containers:
            if container is app:
                continue
            if container.env_problem:
                self.states[container.name] = WAITING
                self.events.append(f"container {container.name} cannot start: {container.env_problem}")
                continue
            agent = self._agent(container)
            self.states[container.name] = RUNNING
            if agent is None:
                continue
            started = agent.start(self.vault, self.context, self._write, self.age)
            if agent.exits:
                self.states[container.name] = CRASH_LOOP
                self.events.append(f"container {container.name} exits after its first run and the "
                                   "kubelet restarts it (crash loop)")
            elif not started:
                self.events.append(f"container {container.name}: {agent.failure}")

    def _start_app(self, app: Container) -> None:
        if app.env_problem:
            self.states[app.name] = WAITING
            self.events.append(f"container payments cannot start: {app.env_problem}")
            return
        env = dict(app.env)
        if CREDENTIALS_ENV in env:
            path = env[CREDENTIALS_ENV]
            located = app.locate(path)
            host = app.host_path(path)
            if located is not None and host is not None and host.is_file():
                meta = located[0].volume.files.get(located[1])
                if meta is not None and not app.can_read(meta):
                    self._crash(app, f"PermissionError: uid {app.uid} cannot read {path} (owner "
                                     f"{meta.uid}:{meta.gid}, mode {meta.mode:04o})")
                    return
                env[CREDENTIALS_ENV] = str(host)
            else:
                env[CREDENTIALS_ENV] = str(self.workdir / "not-in-the-container" / path.lstrip("/"))
        try:
            self.service = self.payments.build_service(env, self.stripe, self.clock)
        except (Exception, SystemExit) as exc:
            self._crash(app, f"{type(exc).__name__}: {exc}")
            return
        self.states[app.name] = RUNNING
        self.events.append("container payments started")

    def _crash(self, app: Container, reason: str) -> None:
        self.states[app.name] = CRASH_LOOP
        self.events.append(f"container payments crashed on start ({reason})")

    def _write(self, mount: Mount, rel: str, content: bytes, meta: FileMeta) -> None:
        """Vault Agent's atomic write, skipped when the content is unchanged."""
        target = mount.volume.host_dir / rel
        if target.is_file() and target.read_bytes() == content:
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        self._writes += 1
        replace_file(target, content, self.clock, self._writes)
        mount.volume.files[rel] = meta
