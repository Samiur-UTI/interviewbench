"""Reading files from the candidate's repository (SPEC section 3, "Tolerances").

Every reader accepts CRLF line endings and a UTF-8 BOM. Anything that cannot be read becomes a
RepoError whose message names the file, so only the checks that need that file fail.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import yaml


class RepoError(Exception):
    """A file a check needs is missing or cannot be parsed. The message names the file."""


def app_dir() -> Path:
    """The candidate's repository, from $APP_DIR."""
    return Path(os.environ["APP_DIR"])


def display(path: Path, root: Path) -> str:
    """`path` relative to `root` with forward slashes, for messages."""
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def read_text(path: Path, root: Path) -> str:
    """The file's text without a BOM and with LF line endings."""
    name = display(path, root)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        raise RepoError(f"{name}: no such file") from None
    except OSError as exc:
        raise RepoError(f"{name}: cannot be read ({exc.strerror or exc})") from None
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise RepoError(f"{name}: is not UTF-8 text") from None
    return text.replace("\r\n", "\n").replace("\r", "\n")


def load_yaml_documents(path: Path, root: Path) -> list[Any]:
    """Every non-empty YAML document in the file."""
    text = read_text(path, root)
    try:
        documents = list(yaml.safe_load_all(text))
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        where = f" (line {mark.line + 1})" if mark is not None else ""
        raise RepoError(f"{display(path, root)}: is not valid YAML{where}") from None
    return [doc for doc in documents if doc is not None]


def load_json(path: Path, root: Path) -> Any:
    """The file parsed as JSON."""
    text = read_text(path, root)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RepoError(f"{display(path, root)}: is not valid JSON (line {exc.lineno})") from None


def files_under(directory: Path, suffixes: tuple[str, ...]) -> list[Path]:
    """Files below `directory` with one of `suffixes`, in path order (the order kubectl applies)."""
    if not directory.is_dir():
        return []
    found = [p for p in directory.rglob("*") if p.is_file() and p.suffix.lower() in suffixes]
    return sorted(found, key=lambda p: p.relative_to(directory).as_posix())
