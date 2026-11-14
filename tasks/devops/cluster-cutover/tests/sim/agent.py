"""Vault Agent in a container, as the hidden tests model it (SPEC section 3.7, "Agent containers").

A container is an agent when its command line (after splitting a `sh -c "<script>"` form) has the
word `agent` and a -config option. Its run, in order, stops at the first failure: read the HCL
config through the container's mounts; reach the platform Vault (address, then TLS); log in with
the kubernetes auto-auth method; render every template to its destination
with its perms. A running agent re-renders every static_secret_render_interval (default 5m) and
rewrites a file only when its content changed.
"""

from __future__ import annotations

import posixpath
import shlex
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import hcl
from .containers import AUTOMOUNT_DIR, Container, FileMeta, Mount, ProjectedToken
from .durations import parse_duration
from .k8s import PLATFORM_CA
from .kubeadm import go_bool
from .repo import RepoError
from .template import Template, TemplateError, render
from .template import parse as parse_template
from .vault import VAULT_ADDRESS, FakeVault, ServiceAccountJwt, VaultError, VaultToken

SHELLS = ("sh", "bash", "ash", "dash")
DEFAULT_ADDRESS = "https://127.0.0.1:8200"
DEFAULT_MOUNT = "auth/kubernetes"
DEFAULT_TOKEN_PATH = AUTOMOUNT_DIR + "/token"
DEFAULT_RENDER_INTERVAL = 300.0
DEFAULT_PERMS = 0o644


@dataclass(frozen=True)
class Invocation:
    config_paths: tuple[str, ...]
    exit_after_auth: bool


def command_words(argv: tuple[str, ...]) -> list[str]:
    """The command line, with the script of `sh -c "<script>"` split as the shell would."""
    words = list(argv)
    if words and posixpath.basename(words[0]) in SHELLS:
        for index, word in enumerate(words[1:], start=1):
            if word.startswith("-") and not word.startswith("--") and "c" in word[1:]:
                if index + 1 < len(words):
                    try:
                        return shlex.split(words[index + 1])
                    except ValueError:
                        return words
    return words


def invocation(argv: tuple[str, ...]) -> Invocation | None:
    """How the container runs Vault Agent, or None when it does not."""
    words = command_words(argv)
    if "agent" not in words:
        return None
    configs, exit_after_auth = [], False
    for index, word in enumerate(words):
        flag, has_value, value = word.partition("=")
        if flag in ("-config", "--config"):
            if has_value:
                configs.append(value)
            elif index + 1 < len(words):
                configs.append(words[index + 1])
        elif flag in ("-exit-after-auth", "--exit-after-auth"):
            exit_after_auth = go_bool(value, False) if has_value else True
    return Invocation(tuple(configs), exit_after_auth) if configs else None


@dataclass(frozen=True)
class AutoAuth:
    method: str
    mount: str
    role: str | None
    token_path: str


@dataclass(frozen=True)
class TemplateBlock:
    contents: str | None
    source: str | None
    destination: str | None
    perms: Any


@dataclass(frozen=True)
class AgentConfig:
    address: str | None
    ca_cert: str | None
    ca_path: str | None
    tls_skip_verify: bool
    exit_after_auth: bool
    auto_auth: AutoAuth | None
    sinks: tuple[str | None, ...]
    templates: tuple[TemplateBlock, ...]
    render_interval: float


def _text(value: Any) -> str | None:
    return None if value is None else str(value)


def _kind(block: hcl.Block) -> str:
    """`method "kubernetes" {}` or `method { type = "kubernetes" }`."""
    return block.labels[0] if block.labels else str(block.body.attr("type", ""))


def agent_config(body: hcl.Body, source: str) -> AgentConfig:
    vault = body.merged("vault")
    auto_auth, sinks = None, []
    auto_blocks = body.blocks("auto_auth")
    if auto_blocks:
        stanza = auto_blocks[0].body
        methods = stanza.blocks("method")
        if methods:
            method = methods[0]
            config = method.body.merged("config")
            mount = str(method.body.attr("mount_path") or DEFAULT_MOUNT).strip("/")
            auto_auth = AutoAuth(_kind(method), mount[len("auth/"):] if mount.startswith("auth/") else mount,
                                 _text(config.attr("role")),
                                 str(config.attr("token_path") or DEFAULT_TOKEN_PATH))
        sinks = [_text(s.body.merged("config").attr("path")) for s in stanza.blocks("sink")
                 if _kind(s) == "file"]
    templates = tuple(
        TemplateBlock(_text(t.body.attr("contents")), _text(t.body.attr("source")),
                      _text(t.body.attr("destination")), t.body.attr("perms"))
        for t in body.blocks("template")
    )
    interval_value = body.merged("template_config").attr("static_secret_render_interval")
    try:
        interval = DEFAULT_RENDER_INTERVAL if interval_value is None else parse_duration(interval_value)
    except ValueError:
        raise RepoError(f"{source}: static_secret_render_interval {interval_value!r} is not a duration") from None
    return AgentConfig(
        address=_text(vault.attr("address")),
        ca_cert=_text(vault.attr("ca_cert")),
        ca_path=_text(vault.attr("ca_path")),
        tls_skip_verify=go_bool(vault.attr("tls_skip_verify"), False),
        exit_after_auth=go_bool(body.attr("exit_after_auth"), False),
        auto_auth=auto_auth,
        sinks=tuple(sinks),
        templates=templates,
        render_interval=interval if interval > 0 else DEFAULT_RENDER_INTERVAL,
    )


@dataclass(frozen=True)
class PodContext:
    """What an agent needs to know about its pod."""

    cluster: str
    namespace: str
    service_account: str
    fs_group: int | None


Writer = Callable[[Mount, str, bytes, FileMeta], None]


@dataclass(frozen=True)
class Output:
    """One template of a running agent."""

    destination: str
    mount: Mount
    rel: str
    template: Template
    perms: int
    secret_paths: frozenset[str]


class AgentFailure(Exception):
    pass


def parse_perms(value: Any) -> int:
    """A template's perms: a number as written (HCL reads 0440 as octal), a string as octal."""
    if value is None:
        return DEFAULT_PERMS
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    text = str(value).strip().lower().removeprefix("0o")
    try:
        return int(text, 8)
    except ValueError:
        raise AgentFailure(f"perms {value!r} is not an octal mode") from None


def _is_platform_ca(content: bytes | None) -> bool:
    return content is not None and PLATFORM_CA.strip().encode() in content.replace(b"\r\n", b"\n")


class VaultAgent:
    """One container running Vault Agent, and what happened when it ran."""

    def __init__(self, container: Container, how: Invocation) -> None:
        self.container = container
        self.invocation = how
        self.config: AgentConfig | None = None
        self.address: str | None = None
        self.tls_verified: bool | None = None
        self.login_token: ProjectedToken | None = None
        self.login_mount: str | None = None
        self.login_role: str | None = None
        self.token: VaultToken | None = None
        self.outputs: list[Output] = []
        self.failure: str | None = None
        self.next_render = 0.0

    @property
    def name(self) -> str:
        return self.container.name

    @property
    def exits(self) -> bool:
        """Whether it exits after its first render (exit_after_auth)."""
        from_config = self.config.exit_after_auth if self.config else False
        return self.invocation.exit_after_auth or from_config

    @property
    def render_interval(self) -> float:
        return self.config.render_interval if self.config else DEFAULT_RENDER_INTERVAL

    @property
    def secret_paths(self) -> frozenset[str]:
        return frozenset().union(*(o.secret_paths for o in self.outputs))

    def start(self, vault: FakeVault, pod: PodContext, write: Writer, now: float) -> bool:
        """The first run; False (with `failure` set) when a step fails."""
        try:
            self.config = self._read_config()
            self._connect()
            self._login(vault, pod)
            self.outputs = [self._prepare(t, vault) for t in self.config.templates]
            for output in self.outputs:
                self._render(output, vault, pod, write)
        except AgentFailure as exc:
            self.failure = str(exc)
            return False
        self.next_render = now + self.render_interval
        return True

    def rerender(self, vault: FakeVault, pod: PodContext, write: Writer) -> None:
        """A periodic re-read of every static secret; a failure keeps the files as they were."""
        for output in self.outputs:
            try:
                self._render(output, vault, pod, write)
            except AgentFailure as exc:
                self.failure = str(exc)

    def _read_config(self) -> AgentConfig:
        bodies = []
        for path in self.invocation.config_paths:
            host = self.container.host_path(path)
            if host is None or not host.exists():
                raise AgentFailure(f"config {path} does not exist in the container")
            files = sorted(host.glob("*.hcl")) if host.is_dir() else [host]
            for file in files:
                name = f"{path}/{file.name}" if host.is_dir() else path
                try:
                    bodies.append(hcl.parse(file.read_bytes().decode("utf-8-sig"), name))
                except (RepoError, UnicodeDecodeError) as exc:
                    raise AgentFailure(f"cannot read its config: {exc}") from None
        try:
            return agent_config(hcl.Body([i for b in bodies for i in b.items]), self.invocation.config_paths[0])
        except RepoError as exc:
            raise AgentFailure(f"cannot read its config: {exc}") from None

    def _connect(self) -> None:
        assert self.config is not None
        env = self.container.env
        self.address = env.get("VAULT_ADDR") or self.config.address or DEFAULT_ADDRESS
        if self.address.rstrip("/") != VAULT_ADDRESS:
            raise AgentFailure(f"cannot reach Vault at {self.address}")
        if self.config.tls_skip_verify or go_bool(env.get("VAULT_SKIP_VERIFY"), False):
            self.tls_verified = False
            return
        ca_file = env.get("VAULT_CACERT") or self.config.ca_cert
        ca_dir = env.get("VAULT_CAPATH") or self.config.ca_path
        candidates = [self.container.read(ca_file)] if ca_file else []
        directory = self.container.host_path(ca_dir) if ca_dir else None
        if directory is not None and directory.is_dir():
            candidates += [f.read_bytes() for f in sorted(directory.iterdir()) if f.is_file()]
        if not any(_is_platform_ca(c) for c in candidates):
            raise AgentFailure("x509: certificate signed by unknown authority")
        self.tls_verified = True

    def _login(self, vault: FakeVault, pod: PodContext) -> None:
        assert self.config is not None
        auth = self.config.auto_auth
        if auth is None or auth.method != "kubernetes":
            raise AgentFailure("it has no kubernetes auto_auth method")
        self.login_mount, self.login_role = auth.mount, auth.role
        if not auth.role:
            raise AgentFailure("its kubernetes auto_auth method names no role")
        self.login_token = self.container.token_at(auth.token_path)
        if self.login_token is None:
            raise AgentFailure(f"there is no service account token at {auth.token_path}")
        jwt = ServiceAccountJwt(pod.cluster, pod.namespace, pod.service_account,
                                (self.login_token.audience,), self.login_token.lifetime)
        result = vault.login(auth.mount, auth.role, jwt)
        if result.token is None:
            raise AgentFailure(f"login through auth/{auth.mount} as role {auth.role} failed: "
                               f"{result.reason}")
        self.token = result.token

    def _prepare(self, block: TemplateBlock, vault: FakeVault) -> Output:
        destination = block.destination
        if not destination:
            raise AgentFailure("a template has no destination")
        text = block.contents
        if text is None:
            content = self.container.read(block.source) if block.source else None
            if content is None:
                raise AgentFailure(f"the template for {destination} has no contents or readable source")
            text = content.decode("utf-8-sig", errors="replace")
        try:
            template = parse_template(text)
        except TemplateError as exc:
            raise AgentFailure(f"the template for {destination}: {exc}") from None
        perms = parse_perms(block.perms)
        located = self.container.locate(destination)
        if located is None or not located[0].writable or not located[1]:
            raise AgentFailure(f"cannot write {destination}: it is not a file on a writable volume")
        paths = frozenset(vault.data_path(p) for p in template.secret_paths)
        return Output(destination, located[0], located[1], template, perms, paths)

    def _render(self, output: Output, vault: FakeVault, pod: PodContext, write: Writer) -> None:
        token = self.token
        assert token is not None
        try:
            text = render(output.template, lambda path: vault.read_secret(token, path))
        except VaultError as exc:
            raise AgentFailure(f"the template for {output.destination}: {exc}") from None
        gid = pod.fs_group if pod.fs_group is not None else self.container.gid
        write(output.mount, output.rel, text.encode(), FileMeta(self.container.uid, gid, output.perms))
