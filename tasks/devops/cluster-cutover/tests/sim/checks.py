"""Checks shared by more than one stage's hidden tests (SPEC section 4, "Regression").

Each returns what it observed that breaks the rule, phrased as who could do what; an empty list
means the rule holds.
"""

from __future__ import annotations

import re

from .agent import AgentFailure, VaultAgent, parse_perms
from .containers import DEFAULT_AUDIENCE, Mount
from .firewall import INTERNET, PROBE_PORTS, openings_beyond_flows
from .k8s import as_dict
from .personas import APP_NAMESPACES, DEVELOPER, DEVELOPER_NAMESPACES, SUPPORT, edit_level
from .personas import pod_reading, support_reading
from .pod import COMPLETED, CRASH_LOOP, PaymentsPod
from .rbac import Identity, NonResourceRequest, Request, ResourceRequest
from .vault import FakeVault, ServiceAccountJwt, VaultToken
from .world import STRIPE_PATH, World

VAULT_AUDIENCE = "vault"
MIN_TOKEN_SECONDS, MAX_TOKEN_SECONDS = 600, 3600
AGENT_IMAGE = re.compile(r"registry\.quayside\.example/mirror/hashicorp/vault:([^@/:]+)(@sha256:[0-9a-f]{64})?")
OTHER_WORKLOADS = (("storefront", "default"), ("orders", "orders-api"), ("monitoring", "prometheus"),
                   ("kubernetes-dashboard", "kubernetes-dashboard"), ("payments", "default"),
                   ("platform", "vault-auth"))
DEFAULT_ONLY = VaultToken(frozenset({"default"}), 0, 0, "")

# The API server without credentials: resources in several namespaces (secrets and pod logs
# included), discovery, metrics. Only /healthz, /livez, /readyz and /version may answer.
ANONYMOUS_PROBES: tuple[Request, ...] = (
    ResourceRequest("list", "pods"),
    *(ResourceRequest("list", "pods", ns) for ns in ("payments", "storefront", "kube-system")),
    ResourceRequest("get", "pods", "payments", subresource="log", name="payments-api-7d9c5b8f4-x2x9q"),
    ResourceRequest("create", "pods", "storefront", subresource="exec", name="storefront-6d4cf56db6-abcde"),
    ResourceRequest("get", "secrets", "payments", name="payments-stripe"),
    ResourceRequest("list", "secrets", "kube-system"),
    ResourceRequest("list", "configmaps", "kube-system"),
    ResourceRequest("list", "deployments", "orders", group="apps"),
    ResourceRequest("list", "nodes"),
    ResourceRequest("list", "namespaces"),
    *(NonResourceRequest("get", p) for p in ("/api", "/api/v1", "/apis", "/apis/apps/v1",
                                             "/openapi/v2", "/openapi/v3", "/metrics", "/logs/")),
)


def internet_openings(world: World) -> list[str]:
    """Anything the internet reaches beyond tcp 80/443 on the workers."""
    return openings_beyond_flows(world.firewall, INTERNET, PROBE_PORTS)


def anonymous_api_answers(world: World) -> list[str]:
    """Probes a request without credentials gets answered (SPEC 3.2: anonymous-auth and RBAC)."""
    return [f"without credentials, {r} is answered" for r in ANONYMOUS_PROBES
            if world.apiserver.answers(None, r)]


def missing(world: World, identity: Identity, requests: list[Request]) -> list[str]:
    """Requests the API server refuses the identity."""
    return [f"{identity} cannot {r}" for r in requests if not world.apiserver.authorize(identity, r)]


def granted(world: World, identity: Identity, requests: list[Request]) -> list[str]:
    """Requests the API server allows the identity."""
    return [f"{identity} can {r}" for r in requests if world.apiserver.authorize(identity, r)]


def developer_access_problems(world: World) -> list[str]:
    """`edit` in storefront and orders; pods, logs and events in every other namespace of ours.

    Only the namespaces this repo declares are checked: "every other namespace" in docs/access.md
    is not read as a promise about kube-system.
    """
    found = []
    for namespace in APP_NAMESPACES:
        needs = edit_level(namespace) if namespace in DEVELOPER_NAMESPACES else pod_reading(namespace)
        found += missing(world, DEVELOPER, needs)
    return found


def support_access_problems(world: World) -> list[str]:
    """Read-only everywhere: pods, their logs, events, deployments, services.

    Checked namespace by namespace over the ones this repo declares, so a binding per namespace is
    as good as one cluster-wide binding.
    """
    found = []
    for namespace in APP_NAMESPACES:
        found += missing(world, SUPPORT, support_reading(namespace))
    return found


# The payments pod and its Vault Agents

def pod_not_created(pod: PaymentsPod) -> list[str]:
    """Why the pod does not exist, if it does not."""
    return [] if pod.created else [pod.describe()]


def no_agents(pod: PaymentsPod) -> list[str]:
    """Why there is no Vault Agent to check, if there is none."""
    if not pod.created:
        return [pod.describe()]
    return [] if pod.agents else [f"no container in the payments pod runs Vault Agent ({pod.describe()})"]


def transport_problems(pod: PaymentsPod) -> list[str]:
    """Every agent reaches the documented address and verifies Vault against the platform CA."""
    found = no_agents(pod)
    for agent in pod.agents:
        if agent.tls_verified is False:
            found.append(f"{agent.name} talks to Vault without verifying its certificate")
        elif agent.tls_verified is None:
            found.append(f"{agent.name} never connected to Vault: {agent.failure}")
    return found


def login_problems(pod: PaymentsPod) -> list[str]:
    """Every agent logged in with a projected token for audience `vault` living 600..3600 s
    (a successful login is necessarily through this cluster's own auth mount)."""
    found = no_agents(pod)
    for agent in pod.agents:
        token = agent.login_token
        if agent.token is None or token is None:
            found.append(f"{agent.name} did not log in to Vault: {agent.failure}")
            continue
        if token.audience != VAULT_AUDIENCE:
            found.append(f"{agent.name} logs in with a token for audience {token.audience}")
        if not MIN_TOKEN_SECONDS <= token.lifetime <= MAX_TOKEN_SECONDS:
            found.append(f"{agent.name} logs in with a token that lives {token.lifetime} s")
    return found


def tokens_outside_agents(pod: PaymentsPod) -> list[str]:
    """No container except those that log in to Vault carries a service account token."""
    agents = {id(a.container) for a in pod.agents}
    found = pod_not_created(pod)
    for container in pod.all_containers:
        if id(container) not in agents:
            found += [f"container {container.name} carries a service account token at {path} "
                      f"(audience {token.audience})" for path, token in container.tokens()]
    return found


def _destinations(agent: VaultAgent) -> list[tuple[str, Mount | None, object]]:
    """(destination, the mount it is on, perms as written) of each template in its config."""
    if agent.config is None:
        return []
    found = []
    for block in agent.config.templates:
        located = agent.container.locate(block.destination) if block.destination else None
        found.append((block.destination or "(no destination)", located[0] if located else None,
                      block.perms))
    return found


def rendered_outside_memory(pod: PaymentsPod) -> list[str]:
    """Every template renders onto a memory-backed emptyDir (standard rule 6)."""
    found = no_agents(pod)
    for agent in pod.agents:
        if agent.config is None:
            found.append(f"{agent.name}: {agent.failure}")
        for destination, mount, _ in _destinations(agent):
            if mount is None or not mount.volume.memory_backed_empty_dir:
                where = mount.volume.describe() if mount else "its own filesystem"
                found.append(f"{agent.name} renders {destination} onto {where}")
    return found


def rendered_open_to_others(pod: PaymentsPod) -> list[str]:
    """No rendered file has permission bits for other (standard rule 6)."""
    found = no_agents(pod)
    for agent in pod.agents:
        if agent.config is None:
            found.append(f"{agent.name}: {agent.failure}")
        for destination, _, perms in _destinations(agent):
            try:
                mode = parse_perms(perms)
            except AgentFailure as exc:
                found.append(f"{agent.name} renders {destination}: {exc}")
                continue
            if mode & 0o007:
                found.append(f"{agent.name} renders {destination} with mode {mode:04o}")
    return found


def credentials_unreadable(pod: PaymentsPod) -> list[str]:
    """The payments container reads the rendered file as its own non-root user (rule 6)."""
    if not pod.created:
        return [pod.describe()]
    location = pod.credentials_location()
    app = pod.app
    if location is None or app is None:
        return ["the payments container has no STRIPE_CREDENTIALS_FILE"]
    path, located = location
    meta = located[0].volume.files.get(located[1]) if located else None
    if meta is None:
        return [f"nothing was rendered at {path} in the payments container ({pod.describe()})"]
    found = []
    if app.uid == 0:
        found.append("the payments container runs as root")
    if not app.can_read(meta):
        groups = ", ".join(str(g) for g in sorted(app.groups))
        found.append(f"the payments container (uid {app.uid}, groups {groups}) cannot read {path} "
                     f"(owner {meta.uid}:{meta.gid}, mode {meta.mode:04o})")
    return found


def exposed_token_sinks(pod: PaymentsPod) -> list[str]:
    """A Vault token written to a file stays on a memory-backed volume no other container
    mounts (rule 7)."""
    found = no_agents(pod)
    for agent in pod.agents:
        for path in agent.config.sinks if agent.config else ():
            located = agent.container.locate(path) if path else None
            if located is None:
                found.append(f"{agent.name} writes its Vault token to {path} on its own filesystem")
                continue
            volume = located[0].volume
            if not volume.memory_backed_empty_dir:
                found.append(f"{agent.name} writes its Vault token to {path} on {volume.describe()}")
            sharing = [c.name for c in pod.all_containers if c is not agent.container
                       and any(m.volume is volume for m in c.mounts)]
            if sharing:
                found.append(f"{agent.name} writes its Vault token to {path}, which "
                             f"{', '.join(sharing)} also mount")
    return found


def unpinned_agent_images(pod: PaymentsPod) -> list[str]:
    """Every agent runs the mirrored Vault image with a tag that is not latest (rule 8)."""
    found = no_agents(pod)
    for agent in pod.agents:
        match = AGENT_IMAGE.fullmatch(agent.container.image)
        if match is None or match.group(1) == "latest":
            found.append(f"{agent.name} runs image {agent.container.image or '(none)'}")
    return found


def cold_start_problems(pod: PaymentsPod) -> list[str]:
    """Every init container exited and the payments container started with its credentials."""
    if not pod.created:
        return [pod.describe()]
    waiting = [c.name for c in pod.init_containers if pod.states.get(c.name) != COMPLETED]
    if waiting or pod.service is None:
        return [f"the payments pod did not start: {pod.describe()}"]
    return []


def crash_loops(pod: PaymentsPod) -> list[str]:
    """Containers that exit and are restarted by the kubelet (SPEC 3.7, pod start)."""
    if not pod.created:
        return [pod.describe()]
    looping = [name for name, state in pod.states.items() if state == CRASH_LOOP]
    return [f"{', '.join(looping)} in a crash loop ({pod.describe()})"] if looping else []


def pod_service_account(world: World) -> str:
    """The service account the payments Deployment's pods run as."""
    deployment = world.manifests.find("Deployment", "payments-api", "payments")
    spec = as_dict(as_dict(deployment.spec.get("template")).get("spec")) if deployment else {}
    return str(spec.get("serviceAccountName") or spec.get("serviceAccount") or "default")


def others_reading_stripe(world: World, vault: FakeVault) -> list[str]:
    """Every login, through every role on every kubernetes auth mount, by an identity other than
    the payments pods, that yields a token able to read payments/stripe."""
    home = world.cluster.cluster_name
    target = vault.data_path(STRIPE_PATH)
    found = []
    for mount in vault.kubernetes_mounts():
        cluster = vault.cluster_of_mount(mount) or home
        identities = list(OTHER_WORKLOADS)
        if cluster != home:
            identities.append(("payments", pod_service_account(world)))
        for role in vault.roles_on(mount):
            for namespace, name in identities:
                for audience in (DEFAULT_AUDIENCE, VAULT_AUDIENCE):
                    jwt = ServiceAccountJwt(cluster, namespace, name, (audience,), 3600)
                    token = vault.login(mount, role.name, jwt).token
                    if token is not None and "read" in vault.capabilities(token, target):
                        found.append(f"{namespace}/{name} on cluster {cluster} (audience {audience}) "
                                     f"logs in as role {role.name} on auth/{mount} and reads "
                                     "payments/stripe")
    return found


def beyond_default(vault: FakeVault, token: VaultToken, path: str) -> frozenset[str]:
    """What the token may do on `path` beyond what Vault's default policy gives every token."""
    return vault.capabilities(token, path) - vault.capabilities(DEFAULT_ONLY, path)
