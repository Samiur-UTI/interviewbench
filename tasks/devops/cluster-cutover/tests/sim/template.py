"""The consul-template subset Vault Agent templates may use (SPEC section 3.8).

Literal text; `{{ with secret "<path>" }}` ... `{{ end }}`; inside it `.Data.data.<field>`,
`index .Data.data "<field>"`, `.Data.data | toJSON`, `toJSON .Data.data` and the same two forms
on one field; the trim markers `{{-` and `-}}`. A missing field renders `<no value>`; toJSON is
compact JSON as Go's encoder writes it. Anything else raises TemplateError.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Union

FIELD = r"\.Data\.data\.([A-Za-z_][A-Za-z0-9_]*)"
_WITH = re.compile(r'with\s+secret\s+"((?:[^"\\]|\\.)*)"')
_EXPRESSIONS: tuple[tuple[re.Pattern[str], bool], ...] = (
    (re.compile(FIELD), False),
    (re.compile(r'index\s+\.Data\.data\s+"((?:[^"\\]|\\.)*)"'), False),
    (re.compile(r"\.Data\.data\s*\|\s*toJSON"), True),
    (re.compile(r"toJSON\s+\.Data\.data"), True),
    (re.compile(FIELD + r"\s*\|\s*toJSON"), True),
    (re.compile(r"toJSON\s+" + FIELD), True),
)
_SPACE = " \t\r\n"


class TemplateError(Exception):
    pass


@dataclass(frozen=True)
class _Value:
    """One output action: a field of the secret (None: the whole `.Data.data`)."""

    field: str | None
    as_json: bool


@dataclass
class _With:
    path: str
    children: list[Node] = field(default_factory=list)


Node = Union[str, _Value, _With]


@dataclass(frozen=True)
class Template:
    nodes: tuple[Node, ...]

    @property
    def secret_paths(self) -> frozenset[str]:
        """Every path a `with secret` reads."""
        found: set[str] = set()
        stack = list(self.nodes)
        while stack:
            node = stack.pop()
            if isinstance(node, _With):
                found.add(node.path)
                stack.extend(node.children)
        return frozenset(found)


def _unquote(text: str) -> str:
    return json.loads(f'"{text}"')


def _split(text: str) -> list[tuple[str, str]]:
    """("text", ...) and ("action", ...) pieces, with trim markers applied to the text."""
    pieces: list[tuple[str, str]] = []
    pos = 0
    while (start := text.find("{{", pos)) != -1:
        end = text.find("}}", start + 2)
        while end != -1 and text.count('"', start, end) % 2 == 1:
            end = text.find("}}", end + 2)
        if end == -1:
            raise TemplateError("unclosed action {{")
        literal = text[pos:start]
        inner = text[start + 2:end]
        if inner[:1] == "-" and inner[1:2] in tuple(_SPACE):
            literal = literal.rstrip(_SPACE)
            inner = inner[1:]
        trim_after = inner[-1:] == "-" and inner[-2:-1] in tuple(_SPACE)
        if trim_after:
            inner = inner[:-1]
        pieces += [("text", literal), ("action", inner.strip())]
        pos = end + 2
        if trim_after:
            while pos < len(text) and text[pos] in _SPACE:
                pos += 1
    pieces.append(("text", text[pos:]))
    return pieces


def parse(text: str) -> Template:
    root: list[Node] = []
    stack: list[list[Node]] = [root]
    for kind, piece in _split(text):
        if kind == "text":
            if piece:
                stack[-1].append(piece)
            continue
        if (match := _WITH.fullmatch(piece)) is not None:
            block = _With(_unquote(match.group(1)))
            stack[-1].append(block)
            stack.append(block.children)
        elif piece == "end":
            if len(stack) == 1:
                raise TemplateError("unsupported template action: {{ end }} without {{ with }}")
            stack.pop()
        else:
            stack[-1].append(_expression(piece, inside_with=len(stack) > 1))
    if len(stack) != 1:
        raise TemplateError("a {{ with secret }} is never closed with {{ end }}")
    return Template(tuple(root))


def _expression(piece: str, inside_with: bool) -> _Value:
    for pattern, as_json in _EXPRESSIONS:
        match = pattern.fullmatch(piece)
        if match is None:
            continue
        if not inside_with:
            raise TemplateError(f"unsupported template action: {{{{ {piece} }}}} outside a with block")
        name = match.group(1) if match.groups() else None
        if name is not None and pattern.pattern.startswith("index"):
            name = _unquote(name)
        return _Value(name, as_json)
    raise TemplateError(f"unsupported template action: {{{{ {piece} }}}}")


def go_json(value: Any) -> str:
    """json.Marshal: compact, sorted keys, UTF-8, with <, > and & escaped."""
    text = json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    for char, escaped in (("<", "\\u003c"), (">", "\\u003e"), ("&", "\\u0026"),
                          ("\u2028", "\\u2028"), ("\u2029", "\\u2029")):
        text = text.replace(char, escaped)
    return text


def _text(value: Any) -> str:
    if value is None:
        return "<no value>"
    if isinstance(value, bool):
        return "true" if value else "false"
    return value if isinstance(value, str) else go_json(value)


def render(template: Template, read_secret: Callable[[str], dict[str, Any]]) -> str:
    """The rendered text; `read_secret(path)` returns Vault's read response or raises."""
    out: list[str] = []

    def walk(nodes: tuple[Node, ...] | list[Node], data: dict[str, Any] | None) -> None:
        for node in nodes:
            if isinstance(node, str):
                out.append(node)
            elif isinstance(node, _With):
                response = read_secret(node.path)
                inner = response.get("data") if isinstance(response, dict) else None
                walk(node.children, inner.get("data") if isinstance(inner, dict) else None)
            else:
                fields = data if isinstance(data, dict) else {}
                value = fields if node.field is None else fields.get(node.field)
                if node.as_json:
                    out.append(go_json(value))
                else:
                    out.append(_text(value))

    walk(template.nodes, None)
    return "".join(out)
