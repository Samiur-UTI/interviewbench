"""A small HCL1 reader for Vault policies and Vault Agent configuration (SPEC section 3.6).

It reads comments (`#`, `//`, `/* */`), blocks with zero or more labels, attributes
`name = value`, strings with escapes, numbers (a leading 0 followed by digits is octal, as in
`perms = 0440`), booleans, lists (trailing commas allowed), objects with newline or comma
separators and bare or quoted keys, and heredocs (`<<EOT`, and `<<-EOT` which removes the closing
marker's indentation from every line, as HCL1 does). An object value is read as a Body, so
`config = { ... }` and `config { ... }` are the same thing. There are no functions and no
interpolation. Anything else raises HclError naming the file and line.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Union

from .repo import RepoError


class HclError(RepoError):
    """Unreadable HCL; the message is "<file>:<line>: <problem>"."""


@dataclass(frozen=True)
class Attribute:
    name: str
    value: Any
    line: int


@dataclass(frozen=True)
class Block:
    type: str
    labels: tuple[str, ...]
    body: Body
    line: int


@dataclass
class Body:
    items: list[Union[Attribute, Block]] = field(default_factory=list)

    def attr(self, name: str, default: Any = None) -> Any:
        """The last value given to `name`."""
        values = [i.value for i in self.items if isinstance(i, Attribute) and i.name == name]
        return values[-1] if values else default

    def blocks(self, name: str) -> list[Block]:
        """`name { }` blocks and `name = { }` (or a list of objects) attributes, in order."""
        found: list[Block] = []
        for item in self.items:
            if isinstance(item, Block) and item.type == name:
                found.append(item)
            elif isinstance(item, Attribute) and item.name == name:
                values = item.value if isinstance(item.value, list) else [item.value]
                found += [Block(name, (), v, item.line) for v in values if isinstance(v, Body)]
        return found

    def merged(self, name: str) -> Body:
        """Every `name` block's items in one Body (later values win in attr())."""
        return Body([i for block in self.blocks(name) for i in block.body.items])


@dataclass(frozen=True)
class _Token:
    kind: str  # str, heredoc, num, bool, ident, punct, eof
    value: Any
    line: int

    def is_punct(self, char: str) -> bool:
        return self.kind == "punct" and self.value == char

    def __str__(self) -> str:
        return "end of file" if self.kind == "eof" else repr(self.value)


_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_\-.]*")
_NUMBER = re.compile(r"-?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)")
_HEREDOC = re.compile(r"<<(-?)([A-Za-z_][A-Za-z0-9_\-]*)[ \t]*\n")
_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t", "r": "\r", "/": "/"}


class _Lexer:
    def __init__(self, text: str, name: str) -> None:
        self.text = text
        self.name = name
        self.pos = 0
        self.line = 1

    def error(self, message: str, line: int | None = None) -> HclError:
        return HclError(f"{self.name}:{line or self.line}: {message}")

    def tokens(self) -> list[_Token]:
        found = []
        while (token := self._next()) is not None:
            found.append(token)
        found.append(_Token("eof", None, self.line))
        return found

    def _next(self) -> _Token | None:
        text = self.text
        while self.pos < len(text):
            char = text[self.pos]
            if char == "\n":
                self.line += 1
                self.pos += 1
            elif char in " \t\r":
                self.pos += 1
            elif char == "#" or text.startswith("//", self.pos):
                end = text.find("\n", self.pos)
                self.pos = len(text) if end == -1 else end
            elif text.startswith("/*", self.pos):
                end = text.find("*/", self.pos + 2)
                if end == -1:
                    raise self.error("unterminated /* comment")
                self.line += text.count("\n", self.pos, end)
                self.pos = end + 2
            else:
                return self._token(char)
        return None

    def _token(self, char: str) -> _Token:
        line = self.line
        if char == '"':
            return _Token("str", self._string(), line)
        if self.text.startswith("<<", self.pos):
            return _Token("heredoc", self._heredoc(), line)
        if char in "{}[]=,":
            self.pos += 1
            return _Token("punct", char, line)
        if char == "-" or char.isdigit():
            return _Token("num", self._number(), line)
        match = _IDENT.match(self.text, self.pos)
        if match:
            self.pos = match.end()
            word = match.group(0)
            if word in ("true", "false"):
                return _Token("bool", word == "true", line)
            return _Token("ident", word, line)
        raise self.error(f"unexpected character {char!r}")

    def _string(self) -> str:
        text, out = self.text, []
        self.pos += 1
        while True:
            if self.pos >= len(text) or text[self.pos] == "\n":
                raise self.error("unterminated string")
            char = text[self.pos]
            if char == '"':
                self.pos += 1
                return "".join(out)
            if char != "\\":
                out.append(char)
                self.pos += 1
                continue
            escape = text[self.pos + 1:self.pos + 2]
            if escape in _ESCAPES:
                out.append(_ESCAPES[escape])
                self.pos += 2
            elif escape in ("u", "U"):
                width = 4 if escape == "u" else 8
                digits = text[self.pos + 2:self.pos + 2 + width]
                if len(digits) != width or not all(c in "0123456789abcdefABCDEF" for c in digits):
                    raise self.error("invalid unicode escape")
                out.append(chr(int(digits, 16)))
                self.pos += 2 + width
            else:
                raise self.error(f"unknown escape \\{escape}")

    def _heredoc(self) -> str:
        match = _HEREDOC.match(self.text, self.pos)
        if not match:
            raise self.error("malformed heredoc (expected <<MARKER and a newline)")
        start_line = self.line
        indented, marker = match.group(1) == "-", match.group(2)
        pos, lines = match.end(), []
        while True:
            if pos > len(self.text):
                raise self.error(f"heredoc {marker} is never closed", start_line)
            end = self.text.find("\n", pos)
            end = len(self.text) if end == -1 else end
            content = self.text[pos:end]
            if content.strip() == marker:
                closing_indent = content[:len(content) - len(content.lstrip())]
                break
            lines.append(content)
            pos = end + 1
        self.line += len(lines) + 1
        self.pos = end
        if indented and all(line.startswith(closing_indent) for line in lines):
            lines = [line[len(closing_indent):] for line in lines]
        return "".join(line + "\n" for line in lines)

    def _number(self) -> int | float:
        match = _NUMBER.match(self.text, self.pos)
        if not match:
            raise self.error("malformed number")
        self.pos = match.end()
        word = match.group(0)
        digits = word.lstrip("-")
        sign = -1 if word.startswith("-") else 1
        if digits[:2] in ("0x", "0X"):
            return sign * int(digits, 16)
        if any(c in digits for c in ".eE"):
            return float(word)
        if len(digits) > 1 and digits[0] == "0":
            try:
                return sign * int(digits, 8)
            except ValueError:
                raise self.error(f"invalid octal number {word}") from None
        return int(word)


class _Parser:
    def __init__(self, tokens: list[_Token], lexer: _Lexer) -> None:
        self.tokens = tokens
        self.lexer = lexer
        self.index = 0

    def peek(self) -> _Token:
        return self.tokens[self.index]

    def take(self) -> _Token:
        token = self.tokens[self.index]
        self.index = min(self.index + 1, len(self.tokens) - 1)
        return token

    def body(self, closing: str | None) -> Body:
        items: list[Union[Attribute, Block]] = []
        while True:
            token = self.peek()
            if closing is None and token.kind == "eof":
                return Body(items)
            if closing is not None and token.is_punct(closing):
                self.take()
                return Body(items)
            if token.kind == "eof":
                raise self.lexer.error("missing closing }", token.line)
            if token.is_punct(","):
                self.take()
                continue
            items.append(self.item())

    def item(self) -> Union[Attribute, Block]:
        key = self.take()
        if key.kind not in ("ident", "str"):
            raise self.lexer.error(f"expected a name, found {key}", key.line)
        if self.peek().is_punct("="):
            self.take()
            return Attribute(key.value, self.value(), key.line)
        labels = []
        while self.peek().kind in ("str", "ident"):
            labels.append(self.take().value)
        opening = self.take()
        if not opening.is_punct("{"):
            raise self.lexer.error(f"expected = or {{ after {key.value}, found {opening}", opening.line)
        return Block(key.value, tuple(labels), self.body("}"), key.line)

    def value(self) -> Any:
        token = self.take()
        if token.kind in ("str", "heredoc", "num", "bool"):
            return token.value
        if token.is_punct("{"):
            return self.body("}")
        if token.is_punct("["):
            values = []
            while not self.peek().is_punct("]"):
                values.append(self.value())
                if self.peek().is_punct(","):
                    self.take()
                elif not self.peek().is_punct("]"):
                    raise self.lexer.error(f"expected , or ] in a list, found {self.peek()}",
                                           self.peek().line)
            self.take()
            return values
        raise self.lexer.error(f"expected a value, found {token}", token.line)


def parse(text: str, name: str) -> Body:
    """The top-level body of an HCL document; `name` labels error messages."""
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    lexer = _Lexer(text, name)
    return _Parser(lexer.tokens(), lexer).body(None)
