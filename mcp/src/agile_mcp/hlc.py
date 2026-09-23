"""Hybrid Logical Clock — port of ``harness/src/hlc.mjs``.

Semantics match ``client/src/modules/event-sourcing/hlc.js`` (wallTime/counter/
nodeId) without the IndexedDB dependency. ``observe_remote`` is synchronous here:
the JS version is ``async`` but performs no await.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any

logger = logging.getLogger("openagile.hlc")

MAX_DRIFT_MS = 60_000

_current: dict[str, Any] = {"wallTime": 0, "counter": 0, "nodeId": None}


def _warn_drift() -> None:
    wall = _current["wallTime"]
    if time.time() * 1000 - wall > MAX_DRIFT_MS and wall > 0:
        logger.warning("[harness] HLC drift exceeded 60000ms; accepting local wall time.")


def init_hlc(node_id: str | None) -> None:
    if isinstance(node_id, str) and node_id:
        _current["nodeId"] = node_id


def get_node_id() -> str | None:
    return _current["nodeId"]


def emit_local_sync() -> dict[str, Any]:
    if not _current["nodeId"]:
        _current["nodeId"] = str(uuid.uuid4())
    _warn_drift()
    now = int(time.time() * 1000)
    if now > _current["wallTime"]:
        _current["wallTime"] = now
        _current["counter"] = 0
    else:
        _current["counter"] += 1
    return {"wallTime": _current["wallTime"], "counter": _current["counter"], "nodeId": _current["nodeId"]}


def observe_remote(remote_hlc: Any) -> dict[str, Any]:
    if not _current["nodeId"]:
        _current["nodeId"] = str(uuid.uuid4())
    _warn_drift()
    now = int(time.time() * 1000)
    remote_wall = remote_hlc.get("wallTime") if isinstance(remote_hlc, dict) else None
    remote_counter = remote_hlc.get("counter") if isinstance(remote_hlc, dict) else None
    remote_wall = remote_wall if isinstance(remote_wall, (int, float)) else 0
    remote_counter = remote_counter if isinstance(remote_counter, (int, float)) else 0
    new_wall = max(now, _current["wallTime"], remote_wall)

    if new_wall == _current["wallTime"] and new_wall == remote_wall:
        _current["counter"] = max(_current["counter"], remote_counter) + 1
    elif new_wall == _current["wallTime"]:
        _current["counter"] += 1
    elif new_wall == remote_wall:
        _current["counter"] = remote_counter + 1
    else:
        _current["counter"] = 0

    _current["wallTime"] = new_wall
    return {"wallTime": _current["wallTime"], "counter": _current["counter"], "nodeId": _current["nodeId"]}


def compare_hlc(a: dict[str, Any], b: dict[str, Any]) -> int:
    if a.get("wallTime") != b.get("wallTime"):
        return (a.get("wallTime") or 0) - (b.get("wallTime") or 0)
    if a.get("counter") != b.get("counter"):
        return (a.get("counter") or 0) - (b.get("counter") or 0)
    a_node = a.get("nodeId") or ""
    b_node = b.get("nodeId") or ""
    if a_node < b_node:
        return -1
    if a_node > b_node:
        return 1
    return 0


def reset_for_tests() -> None:
    _current.update({"wallTime": 0, "counter": 0, "nodeId": None})
