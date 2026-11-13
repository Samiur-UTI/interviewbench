"""Vault durations (SPEC section 3.5): an int is seconds; a string is "1200", "1200s", "20m",
"1h30m", "24h" and the like (Go duration units, plus "d" as Vault accepts)."""

from __future__ import annotations

import re
from typing import Any

_UNITS = {"ns": 1e-9, "us": 1e-6, "µs": 1e-6, "ms": 1e-3, "s": 1, "m": 60, "h": 3600, "d": 86400}
_PART = re.compile(r"(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d)")
_DURATION = re.compile(r"(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d))+")


def parse_duration(value: Any) -> float:
    """Seconds; an empty string is 0 (unset). Raises ValueError for anything else."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0.0
        if re.fullmatch(r"\d+(?:\.\d+)?", text):
            return float(text)
        if _DURATION.fullmatch(text):
            return sum(float(n) * _UNITS[unit] for n, unit in _PART.findall(text))
    raise ValueError(f"not a duration: {value!r}")
