"""pytest fixtures the hidden test modules import (the verifier runs with --noconftest).

A file that cannot be read, or a payments package that cannot be imported, fails the tests that
use the fixture with that message and nothing else.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

import pytest

from .payments_app import Payments, PaymentsImportError, import_payments
from .pod import PaymentsPod
from .repo import RepoError, app_dir
from .vault import FakeVault
from .world import World

T = TypeVar("T")


def need(build: Callable[[], T]) -> T:
    """`build()`, turning a RepoError into a test failure that shows only its message."""
    try:
        return build()
    except RepoError as exc:
        pytest.fail(str(exc), pytrace=False)


@pytest.fixture(scope="session")
def world() -> World:
    return World(app_dir())


@pytest.fixture(scope="module")
def payments() -> Payments:
    """The candidate's payments package, imported afresh for each test module."""
    try:
        return import_payments(app_dir())
    except PaymentsImportError as exc:
        pytest.fail(str(exc), pytrace=False)


@pytest.fixture
def vault(world: World) -> FakeVault:
    return need(world.new_vault)


@pytest.fixture
def pod(world: World, payments: Payments, vault: FakeVault, tmp_path: Path) -> PaymentsPod:
    """A payments pod started at age 0 on a fresh Vault."""
    return need(lambda: world.start_pod(payments, tmp_path, vault))
