"""``.agileboard/`` layout — port of ``harness/src/shards.mjs``.

The harness (MCP) owns ``manifest.json``, ``lock``, ``state.json``, the snapshot
and ``cursors/mcp.json``; the browser only appends to ``events/<writer>.ndjson``.
Cursors are byte offsets so a torn last line is never consumed.
"""

from __future__ import annotations

import errno
import json
import logging
import os
import re
import socket
import time
import uuid
from typing import Any, Callable

logger = logging.getLogger("openagile.shards")

# .agileboard/ layout. The harness owns manifest.json, lock, state.json and
# cursors/mcp.json; the browser only appends to events/<writer>.ndjson.
WRITER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

CURSOR_FILE = "mcp.json"

_RENAME_ATTEMPTS = 5
_RENAME_RETRY_WAIT_S = 0.015


def _resolve_lock_stale_ms() -> int:
    raw = os.environ.get("OPENAGILE_LOCK_STALE_MS")
    try:
        parsed = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, int) and parsed > 0:
        return parsed
    return 30 * 60 * 1000


LOCK_STALE_MS = _resolve_lock_stale_ms()


def shard_path(data_dir: str, writer_id: str) -> str:
    if not WRITER_ID_RE.match(writer_id or ""):
        raise ValueError(f"invalid writer id: {writer_id}")
    return os.path.join(data_dir, "events", f"{writer_id}.ndjson")


def cursor_path(data_dir: str) -> str:
    return os.path.join(data_dir, "cursors", CURSOR_FILE)


def _write_lock(path: str, contents: dict[str, Any]) -> None:
    with open(path, "x", encoding="utf-8") as handle:
        handle.write(json.dumps(contents))


def _is_pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes

            process_query_limited_information = 0x1000
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
            if handle:
                kernel32.CloseHandle(handle)
                return True
            return False
        except Exception:  # pragma: no cover - platform guard
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as err:
        return err.errno == errno.EPERM


def _is_lock_fresh(existing: Any) -> bool:
    if not isinstance(existing, dict):
        return False
    started_at = _parse_iso(existing.get("startedAt"))
    if started_at is None or time.time() * 1000 - started_at > LOCK_STALE_MS:
        return False
    return _is_pid_alive(existing.get("pid"))


def _parse_iso(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        from datetime import datetime

        return datetime.fromisoformat(text).timestamp() * 1000
    except ValueError:
        return None


def _ensure_manifest(data_dir: str) -> dict[str, Any]:
    path = os.path.join(data_dir, "manifest.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, ValueError):
            pass  # rebuild an unreadable manifest
    manifest = {
        "format": "openagile.board",
        "formatVersion": 1,
        "projectId": str(uuid.uuid4()),
        "createdAt": _now_iso(),
    }
    try:
        with open(path, "x", encoding="utf-8") as handle:
            handle.write(json.dumps(manifest, indent=2) + "\n")
    except FileExistsError:
        pass
    return manifest


def _acquire_lock(data_dir: str) -> dict[str, Any] | None:
    path = os.path.join(data_dir, "lock")
    token = str(uuid.uuid4())
    contents = {"pid": os.getpid(), "host": socket.gethostname(), "startedAt": _now_iso(), "token": token}
    try:
        _write_lock(path, contents)
        return {"path": path, "token": token}
    except FileExistsError:
        pass

    existing: Any = None
    try:
        with open(path, encoding="utf-8") as handle:
            existing = json.load(handle)
    except (OSError, ValueError):
        existing = None
    if existing is not None and _is_lock_fresh(existing):
        logger.warning(
            "[harness] advisory lock held by pid %s on %s; continuing without it",
            existing.get("pid"),
            existing.get("host"),
        )
        return None

    logger.warning("[harness] taking over a stale advisory lock")
    try:
        os.unlink(path)
    except OSError:
        pass  # already gone
    try:
        _write_lock(path, contents)
        return {"path": path, "token": token}
    except OSError as err:
        logger.warning("[harness] advisory lock not acquired: %s", err)
        return None


def _load_cursors(data_dir: str) -> dict[str, Any]:
    path = cursor_path(data_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            parsed = json.load(handle)
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_cursors(data_dir: str, cursors: dict[str, Any]) -> None:
    path = cursor_path(data_dir)
    os.makedirs(os.path.join(data_dir, "cursors"), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(cursors))
    rename_with_retry(tmp, path)


def _read_shard_from(data_dir: str, writer_id: str, offset: Any) -> tuple[list[dict[str, Any]], int]:
    path = shard_path(data_dir, writer_id)
    if not os.path.exists(path):
        return [], offset if isinstance(offset, int) else 0
    with open(path, "rb") as handle:
        data = handle.read()
    start = offset if isinstance(offset, int) and not isinstance(offset, bool) and 0 <= offset <= len(data) else 0
    events: list[dict[str, Any]] = []
    cursor = start
    while cursor < len(data):
        newline = data.find(b"\n", cursor)
        if newline == -1:
            break
        line = data[cursor:newline].decode("utf-8", errors="replace")
        if line == "":
            break
        try:
            event = json.loads(line)
        except ValueError:
            break
        if not isinstance(event, dict):
            break
        events.append(event)
        cursor = newline + 1
    return events, cursor


def rename_with_retry(source: str, destination: str) -> None:
    attempt = 1
    while True:
        try:
            os.replace(source, destination)
            return
        except OSError as err:
            transient = err.errno in (errno.EPERM, errno.EACCES, errno.EBUSY)
            if not transient or attempt >= _RENAME_ATTEMPTS:
                raise
            time.sleep(_RENAME_RETRY_WAIT_S)
            attempt += 1


def ensure_layout(data_dir: str) -> dict[str, Any]:
    os.makedirs(os.path.join(data_dir, "events"), exist_ok=True)
    os.makedirs(os.path.join(data_dir, "cursors"), exist_ok=True)
    if not os.path.exists(cursor_path(data_dir)):
        _save_cursors(data_dir, {})
    manifest = _ensure_manifest(data_dir)
    lock = _acquire_lock(data_dir)
    return {"manifest": manifest, "lock": lock}


def release_lock(data_dir: str, lock: Any) -> None:
    if not lock:
        return
    path = lock.get("path") if isinstance(lock, dict) else None
    path = path or os.path.join(data_dir, "lock")
    try:
        with open(path, encoding="utf-8") as handle:
            current = json.load(handle)
        if not isinstance(current, dict) or current.get("token") != lock.get("token"):
            return
        os.unlink(path)
    except (OSError, ValueError):
        pass  # lock already released


def append_shard(data_dir: str, writer_id: str, event: dict[str, Any]) -> None:
    with open(shard_path(data_dir, writer_id), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")


def list_shard_writers(data_dir: str) -> list[str]:
    directory = os.path.join(data_dir, "events")
    if not os.path.exists(directory):
        return []
    names = os.listdir(directory)
    writers = [name[: -len(".ndjson")] for name in names if name.endswith(".ndjson")]
    return sorted(writer for writer in writers if WRITER_ID_RE.match(writer))


def merge_shards(data_dir: str, accept: Callable[[dict[str, Any]], Any]) -> int:
    cursors = _load_cursors(data_dir)
    accepted = 0
    for writer_id in list_shard_writers(data_dir):
        start = cursors.get(writer_id) if isinstance(cursors.get(writer_id), int) else 0
        events, offset = _read_shard_from(data_dir, writer_id, start)
        for event in events:
            if accept(event):
                accepted += 1
        if offset != start or writer_id not in cursors:
            cursors[writer_id] = offset
            _save_cursors(data_dir, cursors)
    return accepted


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
