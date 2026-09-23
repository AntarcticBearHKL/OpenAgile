"""Small shared helpers. Kept minimal — no domain logic lives here."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def iso_now() -> str:
    """``new Date().toISOString()`` — UTC, millisecond precision, trailing ``Z``."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_from_ms(ms: float) -> str:
    """``new Date(ms).toISOString()``."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso_ms(value: Any) -> float | None:
    """``Date.parse(value)`` in milliseconds, or ``None`` when unparseable."""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text).timestamp() * 1000
    except ValueError:
        return None


def is_number(value: Any) -> bool:
    """``Number.isFinite`` — rejects bools, strings, NaN and infinities."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return False
    return True


def is_int(value: Any) -> bool:
    """``Number.isInteger``."""
    return isinstance(value, int) and not isinstance(value, bool)
