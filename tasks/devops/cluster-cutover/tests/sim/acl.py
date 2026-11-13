"""Vault ACL policies: parsing and path matching (SPEC section 3.5).

A rule's path is exact, ends in `*` (a prefix glob), or has `+` segments (exactly one segment
each). When several rules match a request path, the most specific path string wins, by Vault's
priority rules in this order: a path whose first `+` or `*` comes earlier is lower; a path ending
in `*` is lower than one that does not; more `+` segments is lower; shorter is lower;
lexicographically smaller is lower. The capabilities are the union, across the token's policies,
of the rules written for that winning path; `deny` there wins over everything.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from . import hcl
from .repo import RepoError

ALL_CAPABILITIES = frozenset({"create", "read", "update", "patch", "delete", "list", "sudo"})
LEGACY_POLICY = {
    "read": {"read", "list"},
    "write": {"create", "read", "update", "delete", "list"},
    "deny": {"deny"},
    "sudo": {"create", "read", "update", "delete", "list", "sudo"},
}


@dataclass(frozen=True)
class PathRule:
    pattern: str
    capabilities: frozenset[str]


@dataclass(frozen=True)
class Policy:
    name: str
    rules: tuple[PathRule, ...]


def _rule(pattern: Any, capabilities: Any, legacy: Any, source: str) -> PathRule:
    if not isinstance(pattern, str):
        raise RepoError(f"{source}: a path rule has no path string")
    caps: set[str] = set()
    if capabilities is not None:
        if not isinstance(capabilities, list) or not all(isinstance(c, str) for c in capabilities):
            raise RepoError(f"{source}: capabilities of path {pattern!r} is not a list of strings")
        caps |= {c.strip().lower() for c in capabilities}
    if legacy is not None:
        caps |= LEGACY_POLICY.get(str(legacy).strip().lower(), set())
    return PathRule(pattern.lstrip("/"), frozenset(caps))


def parse_hcl_policy(name: str, text: str, source: str) -> Policy:
    """`path "<p>" { capabilities = [...] }` blocks (or legacy `policy = "read"`)."""
    if text.lstrip().startswith("{"):
        try:
            return parse_json_policy(name, json.loads(text), source)
        except json.JSONDecodeError:
            pass
    body = hcl.parse(text, source)
    rules = []
    for block in body.blocks("path"):
        if len(block.labels) != 1:
            raise RepoError(f"{source}:{block.line}: a path block needs exactly one path")
        rules.append(_rule(block.labels[0], block.body.attr("capabilities"),
                           block.body.attr("policy"), source))
    return Policy(name, tuple(rules))


def parse_json_policy(name: str, data: Any, source: str) -> Policy:
    """A JSON policy: {"path": {"<p>": {"capabilities": [...]}}}, or the API request body
    {"policy": "<policy text>"}."""
    if isinstance(data, dict) and isinstance(data.get("policy"), str):
        return parse_hcl_policy(name, data["policy"], source)
    if not isinstance(data, dict) or not isinstance(data.get("path"), dict):
        raise RepoError(f"{source}: is neither a policy nor a policy request body")
    rules = [_rule(p, (r or {}).get("capabilities"), (r or {}).get("policy"), source)
             for p, r in data["path"].items()]
    return Policy(name, tuple(rules))


DEFAULT_POLICY = Policy("default", tuple(PathRule(p, frozenset(c)) for p, c in (
    ("auth/token/lookup-self", {"read"}),
    ("auth/token/renew-self", {"update"}),
    ("auth/token/revoke-self", {"update"}),
    ("sys/capabilities-self", {"update"}),
    ("sys/leases/renew", {"update"}),
    ("sys/leases/lookup", {"update"}),
    ("sys/wrapping/*", {"update"}),
    ("sys/tools/hash*", {"update"}),
    ("sys/internal/ui/resultant-acl", {"read"}),
    ("cubbyhole/*", {"create", "read", "update", "delete", "list"}),
)))


def pattern_matches(pattern: str, path: str) -> bool:
    glob = pattern.endswith("*")
    wanted = (pattern[:-1] if glob else pattern).split("/")
    actual = path.split("/")
    if len(actual) < len(wanted) or (not glob and len(actual) != len(wanted)):
        return False
    for index, segment in enumerate(wanted):
        last = index == len(wanted) - 1
        if segment == "+" and not (glob and last):
            continue
        if glob and last:
            if not actual[index].startswith(segment):
                return False
        elif actual[index] != segment:
            return False
    return True


def priority(pattern: str) -> tuple[int, int, int, int, str]:
    """Sort key: a higher key is a more specific path (the order in the module docstring)."""
    positions = []
    offset = 0
    for segment in pattern.split("/"):
        if segment == "+":
            positions.append(offset)
        offset += len(segment) + 1
    if pattern.endswith("*"):
        positions.append(len(pattern) - 1)
    first_wildcard = min(positions) if positions else 1 << 30
    plus_segments = pattern.split("/").count("+")
    return (first_wildcard, 0 if pattern.endswith("*") else 1, -plus_segments, len(pattern), pattern)


def capabilities(policies: Iterable[Policy], path: str) -> frozenset[str]:
    """What the policies together allow on `path`."""
    matching = [rule for policy in policies for rule in policy.rules
                if pattern_matches(rule.pattern, path)]
    if not matching:
        return frozenset()
    winner = max({rule.pattern for rule in matching}, key=priority)
    caps = frozenset().union(*(r.capabilities for r in matching if r.pattern == winner))
    return frozenset() if "deny" in caps else caps
