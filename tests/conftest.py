"""Shared pytest fixtures for the roxabi_live test suite."""

from __future__ import annotations

import pytest

from roxabi_live import reconciler


@pytest.fixture(autouse=True)
def reset_reconciler_auth_state() -> None:
    """Reset reconciler module-globals before every test.

    `_auth_failures` and `_halted` are process-globals on the reconciler
    module. A test that triggers the auth-halt path leaves `_halted` set;
    without this reset, every subsequent test in the same process sees
    `_halted.is_set() == True` and silently skips all sync calls.
    """
    if hasattr(reconciler, "_auth_failures"):
        reconciler._auth_failures = 0  # type: ignore[attr-defined]
    if hasattr(reconciler, "_halted"):
        reconciler._halted.clear()  # type: ignore[attr-defined]
    if hasattr(reconciler, "_sync_in_flight"):
        reconciler._sync_in_flight = False  # type: ignore[attr-defined]
