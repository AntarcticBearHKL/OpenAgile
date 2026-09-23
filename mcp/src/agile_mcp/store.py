"""Server-side authoritative event log + read-model projection.

Port of ``harness/src/store.mjs``. It reuses the ported pure reducer so the
server and every browser project identical domain events.

Ordering authority: the server appends and assigns a monotonic ``seq`` in a
single synchronous turn. SSE delivery follows seq order per connection, which is
what the browser bridge relies on (live projection is per-event, so arrival order
must equal commit order).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from typing import Any, Callable

from .constants import (
    BACKLOG_COLUMN_ID,
    BLOCKED_COLUMN_ID,
    DEFAULT_BOARD_ID,
    HUMAN_IN_THE_LOOP_COLUMN_ID,
    IN_PROGRESS_COLUMN_ID,
    STABLE_COLUMNS,
)
from .hlc import emit_local_sync, init_hlc, observe_remote
from .reducer import apply_event, create_projection_state
from .shards import WRITER_ID_RE, append_shard, ensure_layout, merge_shards, release_lock, rename_with_retry
from .util import is_int, is_number, iso_from_ms, iso_now, parse_iso_ms

logger = logging.getLogger("openagile.store")

_HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.abspath(os.path.join(_HERE, "..", ".."))
LEGACY_DATA_DIR = os.path.join(os.path.dirname(PROJECT_DIR), "harness", "data")


def _resolve_launch_dir() -> str:
    """The launch scripts cd into ``mcp/``, but the project-local store belongs at
    the repository root, so an ``mcp`` cwd is normalized one level up."""
    cwd = os.path.abspath(os.getcwd())
    if cwd == PROJECT_DIR or os.path.basename(cwd) == "mcp":
        return os.path.dirname(cwd)
    return cwd


LAUNCH_DIR = _resolve_launch_dir()
DATA_DIR = os.path.abspath(os.environ["OPENAGILE_DATA_DIR"]) if os.environ.get("OPENAGILE_DATA_DIR") else os.path.join(LAUNCH_DIR, ".agileboard")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
EVENT_ARCHIVE_FILE = os.path.join(DATA_DIR, "events-archive.ndjson")

COMPACT_AFTER_EVENTS = 5000
MAX_WAIT_MS = 30_000
CLAIM_STALE_MS = 5 * 60 * 1000
CLAIM_STALE_REASON = "Auto-blocked: no agent sync for over 5 minutes."

AGENT_ID = os.environ.get("OPENAGILE_AGENT_NAME") or "openagile-harness"
AGENT_ACTOR = {"type": "agent", "id": AGENT_ID}

_meta: dict[str, Any] = {"nodeId": None, "seq": 0}
_events: list[dict[str, Any]] = []
_groups: list[dict[str, Any]] = []
_board_groups: dict[str, Any] = {}
_no_boards = False
_skills: list[dict[str, Any]] = []
_skills_seeded = False
_groups_skills_event_sourced = False
_seen_ids: set[str] = set()
_applied_ids: set[str] = set()

_boards: list[dict[str, Any]] = []
_tasks_by_board: dict[str, list[dict[str, Any]]] = {}
_columns_by_board: dict[str, list[dict[str, Any]]] = {}
_settings_by_board: dict[str, dict[str, Any]] = {}

_persist_timer: Any = None
_writer_id: str | None = None
_held_lock: Any = None
_idempotency: dict[str, Any] = {}
_task_key_counters: dict[str, Any] = {}

_event_listeners: set[Callable[[dict[str, Any]], None]] = set()

_trim_seq = 0
_archived_count = 0

GROUP_FIELDS = ("name", "order", "collapsed", "prefixCollapsed")
SKILL_FIELDS = ("name", "description", "content", "order")

READY_COLUMN_RANK = {BACKLOG_COLUMN_ID: 0, HUMAN_IN_THE_LOOP_COLUMN_ID: 1}


def _strict_ne(left: Any, right: Any) -> bool:
    if isinstance(left, bool) != isinstance(right, bool):
        return True
    return left != right


def _changed_fields(previous: dict[str, Any], nxt: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    changed: dict[str, Any] = {}
    for field in fields:
        if _strict_ne(nxt.get(field), previous.get(field)):
            changed[field] = nxt.get(field)
    return changed


def _normalize_group(group: Any, index: int) -> dict[str, Any]:
    group = group if isinstance(group, dict) else {}
    raw_id = group.get("id")
    return {
        "id": raw_id if isinstance(raw_id, str) and raw_id else str(uuid.uuid4()),
        "name": group.get("name") if isinstance(group.get("name"), str) else "",
        "order": group.get("order") if is_number(group.get("order")) else index + 1,
        "collapsed": group.get("collapsed") is True,
        "prefixCollapsed": group.get("prefixCollapsed") is True,
    }


def _normalize_skill(skill: Any, index: int) -> dict[str, Any]:
    skill = skill if isinstance(skill, dict) else {}
    raw_id = skill.get("id")
    return {
        "id": raw_id if isinstance(raw_id, str) and raw_id else str(uuid.uuid4()),
        "name": skill.get("name") if isinstance(skill.get("name"), str) else "Untitled skill",
        "description": skill.get("description") if isinstance(skill.get("description"), str) else "",
        "content": skill.get("content") if isinstance(skill.get("content"), str) else "",
        "order": skill.get("order") if is_number(skill.get("order")) else index + 1,
    }


def _key_number(key: Any) -> int:
    match = re.search(r"-(\d+)$", key if isinstance(key, str) else "")
    return int(match.group(1)) if match else 0


# ── Projection (mirrors read-model-projector.js) ──────────────────────────────


def _entity_exists(event_type: str, entity_id: Any, board_id: Any) -> bool:
    if not entity_id:
        return False
    if event_type == "board.created":
        return any(board.get("id") == entity_id for board in _boards)
    if event_type == "column.created":
        return any(column.get("id") == entity_id for column in _columns_by_board.get(board_id, []))
    if event_type == "task.created":
        return any(task.get("id") == entity_id for task in _tasks_by_board.get(board_id, []))
    if event_type == "group.created":
        return any(group.get("id") == entity_id for group in _groups)
    if event_type == "skill.created":
        return any(skill.get("id") == entity_id for skill in _skills)
    return False


def _project(event: dict[str, Any]) -> None:
    global _boards, _groups, _board_groups, _skills
    if not event.get("id") or event["id"] in _applied_ids:
        return
    _applied_ids.add(event["id"])

    scope = event.get("scope") or "board"
    if scope == "global":
        projected = apply_event(
            create_projection_state({"groups": _groups, "boardGroups": _board_groups, "skills": _skills}), event
        )
        _groups = projected["groups"]
        _board_groups = projected["boardGroups"]
        _skills = projected["skills"]
        return

    board_id = event.get("board_id")
    if not isinstance(board_id, str) or not board_id:
        return

    if event.get("type") == "task.created":
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
        issued = _key_number(task.get("key"))
        current = _task_key_counters.get(board_id)
        if issued > (current if is_number(current) else 0):
            _task_key_counters[board_id] = issued

    projected = apply_event(
        create_projection_state(
            {
                "boards": _boards,
                "tasks": _tasks_by_board.get(board_id, []),
                "columns": _columns_by_board.get(board_id, []),
                "settings": _settings_by_board.get(board_id, {}),
            }
        ),
        event,
    )

    _boards = projected["boards"]
    _tasks_by_board[board_id] = projected["tasks"]
    _columns_by_board[board_id] = projected["columns"]
    _settings_by_board[board_id] = projected["settings"]


def _notify_event_listeners(event: dict[str, Any]) -> None:
    for listener in list(_event_listeners):
        try:
            listener(event)
        except Exception:  # noqa: BLE001 - a listener must never break the append
            logger.exception("[OpenAgile] event listener failed")


def append_event(raw: Any) -> dict[str, Any] | None:
    """Append one already-built event. Idempotent: duplicate ids and duplicate
    ``*.created`` entities (browser scaffold vs server scaffold) are dropped."""
    if not isinstance(raw, dict) or not raw.get("id") or not raw.get("type"):
        return None
    if raw["id"] in _seen_ids:
        return None
    if str(raw["type"]).endswith(".created") and _entity_exists(raw["type"], raw.get("entity_id"), raw.get("board_id")):
        return None

    next_seq = _meta["seq"] + 1
    event = {**raw, "seq": next_seq}

    try:
        _project(event)
    except Exception:  # noqa: BLE001 - an event that cannot project is rejected whole
        logger.exception("[OpenAgile] Rejected an event that failed to project: %s", raw.get("type"))
        return None

    if raw.get("hlc"):
        observe_remote(raw["hlc"])
    _meta["seq"] = next_seq
    _events.append(event)
    _seen_ids.add(event["id"])
    if _writer_id:
        try:
            append_shard(DATA_DIR, _writer_id, event)
        except Exception:  # noqa: BLE001
            logger.exception("[harness] shard append failed")
    _notify_event_listeners(event)
    schedule_persist()
    if len(_events) >= COMPACT_AFTER_EVENTS:
        compact_events()
    return event


def append_events(events: Any) -> list[dict[str, Any]]:
    batch = events if isinstance(events, list) else [events]
    out: list[dict[str, Any]] = []
    for raw in batch:
        event = append_event(raw)
        if event:
            out.append(event)
    return out


def emit(
    event_type: str,
    *,
    board_id: str = DEFAULT_BOARD_ID,
    entity_id: str = "",
    payload: dict[str, Any] | None = None,
    actor: dict[str, Any] | None = None,
    scope: str = "board",
) -> dict[str, Any] | None:
    """Build + append a domain event authored by the server (MCP tools)."""
    event = {
        "id": str(uuid.uuid4()),
        "type": event_type,
        "hlc": emit_local_sync(),
        "at": iso_now(),
        "actor": actor or {"type": "agent", "id": AGENT_ID},
        "scope": scope,
        "board_id": board_id if scope == "board" else None,
        "entity_id": entity_id,
        "payload": payload if payload is not None else {},
    }
    return append_event(event)


def _emit_global(event_type: str, entity_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    return emit(event_type, entity_id=entity_id, payload=payload, scope="global")


# ── Compaction ────────────────────────────────────────────────────────────────


def _snapshot_read_model() -> dict[str, Any]:
    return {
        "seq": _meta["seq"],
        "boards": _boards,
        "tasksByBoard": list(_tasks_by_board.items()),
        "columnsByBoard": list(_columns_by_board.items()),
        "settingsByBoard": list(_settings_by_board.items()),
    }


def _hydrate_read_model(snapshot: Any) -> bool:
    global _boards
    if not isinstance(snapshot, dict):
        return False
    if isinstance(snapshot.get("boards"), list):
        _boards = snapshot["boards"]

    def restore(target: dict[str, Any], entries: Any) -> None:
        target.clear()
        for key, value in entries if isinstance(entries, list) else []:
            target[key] = value

    restore(_tasks_by_board, snapshot.get("tasksByBoard"))
    restore(_columns_by_board, snapshot.get("columnsByBoard"))
    restore(_settings_by_board, snapshot.get("settingsByBoard"))
    return True


# ── Persistence ───────────────────────────────────────────────────────────────


def persist_now() -> None:
    payload = json.dumps(
        {
            "nodeId": _meta["nodeId"],
            "seq": _meta["seq"],
            "trimSeq": _trim_seq,
            "archivedCount": _archived_count,
            "idempotency": _idempotency,
            "taskKeyCounters": _task_key_counters,
            "snapshot": _snapshot_read_model() if _trim_seq > 0 else None,
            "events": _events,
            "groups": _groups,
            "boardGroups": _board_groups,
            "noBoards": _no_boards,
            "skills": _skills,
            "skillsSeeded": _skills_seeded,
            "groupsSkillsEventSourced": _groups_skills_event_sourced,
        }
    )
    tmp = f"{STATE_FILE}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(payload)
    rename_with_retry(tmp, STATE_FILE)


def _run_persist() -> None:
    global _persist_timer
    _persist_timer = None
    try:
        persist_now()
    except Exception:  # noqa: BLE001
        logger.exception("[harness] persist failed")


def schedule_persist() -> None:
    global _persist_timer
    if _persist_timer is not None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _run_persist()
        return
    _persist_timer = loop.call_later(0.2, _run_persist)


def flush_store() -> None:
    global _persist_timer
    if _persist_timer is not None:
        try:
            _persist_timer.cancel()
        except Exception:  # noqa: BLE001
            pass
        _persist_timer = None
    try:
        persist_now()
    except Exception:  # noqa: BLE001
        pass
    _release_held_lock()


def _release_held_lock() -> None:
    global _held_lock
    if not _held_lock:
        return
    release_lock(DATA_DIR, _held_lock)
    _held_lock = None


def archive_events(events: list[dict[str, Any]]) -> None:
    """Archiving is best-effort: a failed write must never stop compaction."""
    try:
        with open(EVENT_ARCHIVE_FILE, "a", encoding="utf-8") as handle:
            handle.write("\n".join(json.dumps(event) for event in events) + "\n")
    except OSError:
        logger.exception("[harness] event archive append failed")


def compact_events() -> dict[str, Any]:
    """Fold the whole log into a read-model snapshot and drop it.

    Note this forgets event ids: a client that re-posts an event from before the
    floor after a restart is no longer rejected by id (the ``*.created`` dedupe
    still applies)."""
    global _events, _trim_seq, _archived_count
    if len(_events) == 0:
        return {"compacted": False, "seq": _meta["seq"], "trimSeq": _trim_seq, "archived": _archived_count}
    archive_events(_events)
    _archived_count += len(_events)
    _trim_seq = _meta["seq"]
    _events = []
    schedule_persist()
    return {"compacted": True, "seq": _meta["seq"], "trimSeq": _trim_seq, "archived": _archived_count}


def get_archive_info() -> dict[str, Any]:
    return {"archivePath": EVENT_ARCHIVE_FILE if _archived_count > 0 else None, "archivedCount": _archived_count}


# ── Seed ──────────────────────────────────────────────────────────────────────


def _seed_default_board_if_empty() -> None:
    global _no_boards
    if len(_boards) > 0 or _no_boards:
        return
    now = iso_now()
    append_event(
        {
            "id": str(uuid.uuid4()),
            "type": "board.created",
            "hlc": emit_local_sync(),
            "at": now,
            "actor": {"type": "agent", "id": AGENT_ID},
            "scope": "board",
            "board_id": DEFAULT_BOARD_ID,
            "entity_id": DEFAULT_BOARD_ID,
            "payload": {"board": {"id": DEFAULT_BOARD_ID, "name": "Default Board", "createdAt": now}},
        }
    )
    for column in STABLE_COLUMNS:
        append_event(
            {
                "id": str(uuid.uuid4()),
                "type": "column.created",
                "hlc": emit_local_sync(),
                "at": now,
                "actor": {"type": "agent", "id": AGENT_ID},
                "scope": "board",
                "board_id": DEFAULT_BOARD_ID,
                "entity_id": column["id"],
                "payload": {"column": dict(column)},
            }
        )


def _migrate_sidecar_global_state(
    sidecar_groups: Any, sidecar_board_groups: Any, sidecar_skills: Any
) -> None:
    """Sidecars written before groups/skills were event-sourced are folded into
    the log once, so the event-derived projection keeps every entity the state
    file held."""
    global _groups_skills_event_sourced
    if _groups_skills_event_sourced:
        return

    for index, group in enumerate(sidecar_groups if isinstance(sidecar_groups, list) else []):
        if isinstance(group, dict) and group.get("deleted") is True:
            continue
        normalized = _normalize_group(group, index)
        if any(entry.get("id") == normalized["id"] for entry in _groups):
            continue
        _emit_global("group.created", normalized["id"], {"group": normalized})

    for index, skill in enumerate(sidecar_skills if isinstance(sidecar_skills, list) else []):
        if isinstance(skill, dict) and skill.get("deleted") is True:
            continue
        normalized = _normalize_skill(skill, index)
        if any(entry.get("id") == normalized["id"] for entry in _skills):
            continue
        _emit_global("skill.created", normalized["id"], {"skill": normalized})

    mapping = sidecar_board_groups if isinstance(sidecar_board_groups, dict) else {}
    for board_id in sorted(mapping.keys()):
        if board_id in _board_groups:
            continue
        group_id = mapping[board_id]
        _emit_global("board.group.assigned", board_id, {"group_id": group_id if isinstance(group_id, str) else None})

    _groups_skills_event_sourced = True


def _migrate_legacy_state() -> None:
    """One-time, copy-only migration from the pre-.agileboard location. The source
    is never moved, deleted or rewritten."""
    if os.environ.get("OPENAGILE_DATA_DIR"):
        return
    if os.path.exists(STATE_FILE):
        return
    legacy_state = os.path.join(LEGACY_DATA_DIR, "state.json")
    if not os.path.exists(legacy_state):
        return

    tmp = f"{STATE_FILE}.tmp"
    with open(legacy_state, "rb") as source, open(tmp, "wb") as destination:
        destination.write(source.read())
    rename_with_retry(tmp, STATE_FILE)
    logger.info("[harness] migrated legacy state into %s", STATE_FILE)

    try:
        entries = os.listdir(LEGACY_DATA_DIR)
    except OSError:
        entries = []
    for name in entries:
        if not re.match(r"^state\.backup-.*\.json$", name):
            continue
        destination = os.path.join(DATA_DIR, name)
        if os.path.exists(destination):
            continue
        try:
            backup_tmp = f"{destination}.tmp"
            with open(os.path.join(LEGACY_DATA_DIR, name), "rb") as source, open(backup_tmp, "wb") as target:
                target.write(source.read())
            rename_with_retry(backup_tmp, destination)
        except OSError as err:
            logger.warning("[harness] legacy backup not copied %s: %s", name, err)


def init_store() -> dict[str, Any]:
    global _meta, _groups, _board_groups, _skills, _no_boards, _skills_seeded
    global _groups_skills_event_sourced, _writer_id, _held_lock, _idempotency, _task_key_counters
    global _trim_seq, _archived_count, _events, _boards

    os.makedirs(DATA_DIR, exist_ok=True)
    _migrate_legacy_state()
    _held_lock = ensure_layout(DATA_DIR)["lock"]

    loaded_events: list[Any] = []
    loaded_snapshot: Any = None
    sidecar_groups: Any = None
    sidecar_board_groups: Any = None
    sidecar_skills: Any = None
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, encoding="utf-8") as handle:
                loaded = json.load(handle)
            raw_node = loaded.get("nodeId")
            _meta = {"nodeId": raw_node if isinstance(raw_node, str) else None, "seq": loaded.get("seq") if is_number(loaded.get("seq")) else 0}
            if isinstance(loaded.get("events"), list):
                loaded_events = loaded["events"]
            if isinstance(loaded.get("groups"), list):
                sidecar_groups = loaded["groups"]
            if isinstance(loaded.get("boardGroups"), dict):
                sidecar_board_groups = loaded["boardGroups"]
            if loaded.get("noBoards") is True:
                _no_boards = True
            if isinstance(loaded.get("skills"), list):
                sidecar_skills = loaded["skills"]
            if loaded.get("skillsSeeded") is True:
                _skills_seeded = True
            if loaded.get("groupsSkillsEventSourced") is True:
                _groups_skills_event_sourced = True
            if is_number(loaded.get("trimSeq")):
                _trim_seq = loaded["trimSeq"]
            if is_number(loaded.get("archivedCount")):
                _archived_count = loaded["archivedCount"]
            if isinstance(loaded.get("idempotency"), dict):
                _idempotency = loaded["idempotency"]
            if isinstance(loaded.get("taskKeyCounters"), dict):
                _task_key_counters = loaded["taskKeyCounters"]
            if isinstance(loaded.get("snapshot"), dict):
                loaded_snapshot = loaded["snapshot"]
        except Exception as err:  # noqa: BLE001
            logger.error("[harness] state file unreadable, starting fresh: %s", err)
            _meta = {"nodeId": None, "seq": 0}
            sidecar_groups = None
            sidecar_board_groups = None
            sidecar_skills = None
            _no_boards = False
            _skills_seeded = False
            _groups_skills_event_sourced = False

    if not _meta["nodeId"]:
        _meta["nodeId"] = str(uuid.uuid4())
    init_hlc(_meta["nodeId"])
    candidate_writer_id = f"mcp-{_meta['nodeId']}"
    if WRITER_ID_RE.match(candidate_writer_id):
        _writer_id = candidate_writer_id
    else:
        _writer_id = f"mcp-{uuid.uuid4()}"
        logger.warning("[harness] nodeId is not a legal writer id; using %s", _writer_id)

    # Before the one-time migration the global projection is rebuilt from the log
    # alone, so a sidecar entity genuinely lacks an event and the emitted
    # ``*.created`` is not dropped by the appendEvent entity dedupe.
    if _groups_skills_event_sourced:
        if isinstance(sidecar_groups, list):
            _groups = sidecar_groups
        if isinstance(sidecar_board_groups, dict):
            _board_groups = sidecar_board_groups
        if isinstance(sidecar_skills, list):
            _skills = sidecar_skills
    else:
        _groups = []
        _board_groups = {}
        _skills = []

    # A persisted snapshot already contains every event at or below its seq, so
    # those are not replayed (the log holds only what came after it).
    snapshot_seq = 0
    if _hydrate_read_model(loaded_snapshot) and is_number(loaded_snapshot.get("seq")):
        snapshot_seq = loaded_snapshot["seq"]

    for event in loaded_events:
        if not isinstance(event, dict) or not event.get("id") or event["id"] in _seen_ids:
            continue
        seq = event.get("seq")
        if is_number(seq) and seq <= snapshot_seq:
            _seen_ids.add(event["id"])
            continue
        if not is_number(seq):
            _meta["seq"] += 1
            event["seq"] = _meta["seq"]
        else:
            _meta["seq"] = max(_meta["seq"], seq)
        if event.get("hlc"):
            observe_remote(event["hlc"])
        _events.append(event)
        _seen_ids.add(event["id"])
        _project(event)

    merge_shards(DATA_DIR, append_event)
    _migrate_sidecar_global_state(sidecar_groups, sidecar_board_groups, sidecar_skills)
    _seed_default_board_if_empty()
    _seed_default_skills_if_empty()
    schedule_persist()

    return {"boardId": DEFAULT_BOARD_ID, "seq": _meta["seq"], "events": len(_events)}


# ── Reads ─────────────────────────────────────────────────────────────────────


def _live_group_ids() -> set[str]:
    return {group["id"] for group in _groups if isinstance(group, dict) and group.get("deleted") is not True and isinstance(group.get("id"), str)}


def get_boards() -> list[dict[str, Any]]:
    live_groups = _live_group_ids()
    result = []
    for board in _boards:
        if board.get("deleted"):
            continue
        mapped = _board_groups.get(board.get("id"))
        result.append(
            {
                "id": board.get("id"),
                "name": board.get("name"),
                "createdAt": board.get("createdAt"),
                "groupId": mapped if isinstance(mapped, str) and mapped in live_groups else "",
            }
        )
    return result


def get_board(board_id: Any) -> dict[str, Any] | None:
    for board in _boards:
        if board.get("id") == board_id and not board.get("deleted"):
            return board
    return None


def get_columns(board_id: Any) -> list[dict[str, Any]]:
    stored = {
        column["id"]: column
        for column in _columns_by_board.get(board_id, [])
        if not column.get("deleted") and isinstance(column.get("id"), str)
    }
    result = []
    for template in STABLE_COLUMNS:
        previous = stored.get(template["id"]) or {}
        color = previous.get("color")
        wip = previous.get("wipLimit")
        result.append(
            {
                **template,
                "color": color if isinstance(color, str) and color else template["color"],
                "collapsed": previous.get("collapsed") is True,
                "wipLimit": wip if is_number(wip) else 0,
            }
        )
    return result


def get_tasks(board_id: Any) -> list[dict[str, Any]]:
    return [task for task in _tasks_by_board.get(board_id, []) if not task.get("deleted")]


def reserve_task_key_number(board_id: str, floor: int = 0) -> int:
    """A deleted task is hard-removed from the read model, so the highest number
    ever issued cannot be recovered from the tasks themselves; the counter is
    persisted."""
    issued = _task_key_counters.get(board_id)
    issued = issued if is_number(issued) else 0
    nxt = max(issued, floor if is_number(floor) else 0) + 1
    _task_key_counters[board_id] = nxt
    schedule_persist()
    return nxt


def get_settings(board_id: Any) -> dict[str, Any]:
    return _settings_by_board.get(board_id) or {}


def find_task(task_id: Any) -> dict[str, Any] | None:
    for board_id, tasks in _tasks_by_board.items():
        for task in tasks or []:
            if task.get("id") == task_id and not task.get("deleted"):
                return {"task": task, "boardId": board_id}
    return None


def _build_board_order(board_id: str, task_id: str, target_column_id: str) -> list[dict[str, Any]]:
    by_column: dict[str, list[dict[str, Any]]] = {}
    for task in _tasks_by_board.get(board_id, []):
        if task.get("deleted"):
            continue
        column = target_column_id if task.get("id") == task_id else task.get("column")
        by_column.setdefault(column, []).append({**task, "column": column})
    order: list[dict[str, Any]] = []
    for column_id, items in by_column.items():
        items.sort(key=lambda task: task.get("order") if is_number(task.get("order")) else 0)
        for index, task in enumerate(items):
            order.append({"id": task.get("id"), "column": column_id, "order": index + 1})
    return order


def _last_activity_at(task: dict[str, Any]) -> float | None:
    """``task.moved`` is structural and never writes changeDate, so activity is
    the later of changeDate and the moment the task entered the column it sits
    in (last history entry)."""
    latest = parse_iso_ms(task.get("changeDate"))
    history = task.get("columnHistory") if isinstance(task.get("columnHistory"), list) else []
    entered = history[-1] if history else None
    if isinstance(entered, dict) and entered.get("column") == task.get("column"):
        entered_at = parse_iso_ms(entered.get("at"))
        if entered_at is not None:
            latest = max(latest, entered_at) if latest is not None else entered_at
    return latest


def is_claim_expired(task: Any, now: float | None = None) -> bool:
    if not isinstance(task, dict) or not task.get("claimedBy"):
        return False
    moment = now if is_number(now) else int(__import__("time").time() * 1000)
    activity = _last_activity_at(task)
    if activity is None:
        return True
    return moment - activity > CLAIM_STALE_MS


def is_ready_task(task: Any, now: float | None = None) -> bool:
    if not isinstance(task, dict) or task.get("deleted"):
        return False
    if task.get("column") not in (BACKLOG_COLUMN_ID, HUMAN_IN_THE_LOOP_COLUMN_ID):
        return False
    if pending_notes_message(task):
        return False
    if task.get("claimedBy") and not is_claim_expired(task, now):
        return False
    return True


def next_ready_task(board_id: str, now: float | None = None) -> dict[str, Any] | None:
    candidates = [task for task in get_tasks(board_id) if is_ready_task(task, now)]
    candidates.sort(
        key=lambda task: (
            READY_COLUMN_RANK.get(task.get("column"), 99),
            task.get("order") if is_number(task.get("order")) else 0,
            str(task.get("id")),
        )
    )
    return candidates[0] if candidates else None


def is_last_board_in_group(board_id: str) -> bool:
    board = get_board(board_id)
    if not board:
        raise ValueError(f"Board not found: {board_id}")
    group_id = _board_groups.get(board_id) or ""
    siblings = [entry for entry in get_boards() if (entry.get("groupId") or "") == group_id]
    return len(siblings) == 0 or siblings[-1].get("id") == board_id


def sweep_stale_claims(now: float | None = None) -> list[str]:
    """Stale claims move with two events, exactly like a client drag:
    ``task.moved`` plus the blocked ``task.updated``."""
    moment = now if is_number(now) else int(__import__("time").time() * 1000)
    stale: list[tuple[str, str]] = []
    for board_id, tasks in list(_tasks_by_board.items()):
        for task in tasks:
            if task.get("deleted") or task.get("column") != IN_PROGRESS_COLUMN_ID:
                continue
            if not task.get("claimedBy") and not task.get("claimedAt"):
                continue
            changed_at = _last_activity_at(task)
            if changed_at is not None and moment - changed_at > CLAIM_STALE_MS:
                stale.append((board_id, task.get("id")))

    moved: list[str] = []
    for board_id, task_id in stale:
        task = next(
            (
                entry
                for entry in _tasks_by_board.get(board_id, [])
                if entry.get("id") == task_id and not entry.get("deleted") and entry.get("column") == IN_PROGRESS_COLUMN_ID
            ),
            None,
        )
        if not task:
            continue
        order = _build_board_order(board_id, task_id, BLOCKED_COLUMN_ID)
        emit("task.moved", board_id=board_id, entity_id=task_id, payload={"order": order})
        at = iso_from_ms(moment)
        fields: dict[str, Any] = {"blockedAt": at, "changeDate": at}
        if not task.get("blockedReason"):
            fields["blockedReason"] = CLAIM_STALE_REASON
        emit("task.updated", board_id=board_id, entity_id=task_id, payload={"fields": fields})
        logger.info("[harness] auto-blocked %s (no sync for 5 minutes)", task.get("key") or task_id)
        moved.append(task_id)
    return moved


def pending_notes(task: Any) -> list[dict[str, Any]]:
    points = task.get("keyPoints") if isinstance(task, dict) and isinstance(task.get("keyPoints"), list) else []
    return [point for point in points if isinstance(point, dict) and not point.get("digestedAt")]


def pending_notes_message(task: Any) -> str | None:
    if not isinstance(task, dict):
        return None
    if task.get("needsDigest") is not True and len(pending_notes(task)) == 0:
        return None
    ref = task.get("key") or task.get("id")
    return (
        f"Task {ref} still has notes from the human that the agent has not digested; "
        "run digest_key_points first to fold them into the description before starting."
    )


def digest_key_points(task_id: str, point_ids: Any = None) -> dict[str, Any]:
    found = find_task(task_id)
    if not found:
        raise ValueError(f"Task not found: {task_id}")
    task = found["task"]
    board_id = found["boardId"]
    key_points = task.get("keyPoints") if isinstance(task.get("keyPoints"), list) else []
    selected = set(point_ids) if isinstance(point_ids, list) and len(point_ids) > 0 else None
    now = iso_now()
    digested: list[Any] = []
    nxt = []
    for point in key_points:
        point = point if isinstance(point, dict) else {}
        target = (point.get("id") in selected) if selected is not None else (not point.get("digestedAt"))
        if not target:
            nxt.append(point)
            continue
        digested.append(point.get("id"))
        nxt.append({**point, "digestedAt": now})
    fields: dict[str, Any] = {"keyPoints": nxt, "needsDigest": False, "changeDate": now}
    if task.get("isRework") is True:
        fields["isRework"] = False
    emit("task.updated", board_id=board_id, entity_id=task_id, payload={"fields": fields})
    return {"taskId": task_id, "digested": digested}


def get_seq() -> int:
    return _meta["seq"]


# Storage only: the tool layer owns the create/dedupe decision.
def lookup_idempotency(key: Any) -> dict[str, Any] | None:
    if not isinstance(key, str) or not key:
        return None
    entry = _idempotency.get(key)
    if not isinstance(entry, dict):
        return None
    return {"taskId": entry.get("taskId"), "boardId": entry.get("boardId"), "at": entry.get("at")}


def record_idempotency(key: Any, task_id: str, board_id: str) -> None:
    if not isinstance(key, str) or not key:
        return
    _idempotency[key] = {"taskId": task_id, "boardId": board_id, "at": iso_now()}
    schedule_persist()


def subscribe_events(listener: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
    _event_listeners.add(listener)

    def unsubscribe() -> None:
        _event_listeners.discard(listener)

    return unsubscribe


def get_event_listener_count() -> int:
    return len(_event_listeners)


async def wait_for_event(
    *, since: float = 0, timeout_ms: float = MAX_WAIT_MS, type: str = "", board_id: str = ""  # noqa: A002
) -> dict[str, Any] | None:
    after = since if is_number(since) else 0

    def matches(event: dict[str, Any]) -> bool:
        seq = event.get("seq")
        return (
            (seq if is_number(seq) else 0) > after
            and (not type or event.get("type") == type)
            and (not board_id or event.get("board_id") == board_id)
        )

    for event in _events:
        if matches(event):
            return event

    bounded = max(1, min(MAX_WAIT_MS, timeout_ms if is_number(timeout_ms) else MAX_WAIT_MS))
    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()

    def listener(event: dict[str, Any]) -> None:
        if not future.done() and matches(event):
            future.set_result(event)

    unsubscribe = subscribe_events(listener)
    try:
        return await asyncio.wait_for(future, timeout=bounded / 1000)
    except (asyncio.TimeoutError, TimeoutError):
        return None
    finally:
        unsubscribe()


def get_events_since(since: float) -> list[dict[str, Any]]:
    return [event for event in _events if (event.get("seq") if is_number(event.get("seq")) else 0) > since]


def get_snapshot(board_id: str = DEFAULT_BOARD_ID) -> dict[str, Any]:
    return {
        "seq": _meta["seq"],
        "boardId": board_id,
        "state": {
            "boards": _boards,
            "tasks": _tasks_by_board.get(board_id, []),
            "columns": get_columns(board_id),
            "settings": _settings_by_board.get(board_id, {}),
        },
    }


def get_stats() -> dict[str, Any]:
    return {"boards": len(get_boards()), "events": len(_events), "seq": _meta["seq"], "trimSeq": _trim_seq, "nodeId": _meta["nodeId"]}


def resolve_group(group_id: str = "") -> dict[str, Any]:
    groups = get_groups()
    target = next((group for group in groups if group.get("id") == group_id), None) if group_id else (groups[-1] if groups else None)
    if not target:
        raise ValueError(
            f"Group not found: {group_id}"
            if group_id
            else "No groups exist; create a group first: every iteration belongs to a group"
        )
    return target


def create_board(*, group_id: str = "") -> dict[str, Any]:
    global _no_boards
    group = resolve_group(group_id)
    highest = 0
    for board in get_boards():
        if board.get("groupId") != group.get("id"):
            continue
        match = re.match(r"^Iteration (\d+)$", str(board.get("name") or ""))
        if match:
            highest = max(highest, int(match.group(1)))
    position = highest + 1
    board_id = str(uuid.uuid4())
    board = {"id": board_id, "name": f"Iteration {position}", "createdAt": iso_now()}
    emit("board.created", board_id=board_id, entity_id=board_id, payload={"board": board})
    _emit_global("board.group.assigned", board_id, {"group_id": group.get("id")})
    _no_boards = False
    schedule_persist()
    return {**board, "groupId": group.get("id")}


def delete_board(board_id: str) -> dict[str, Any]:
    global _no_boards
    if not get_board(board_id):
        raise ValueError(f"Board not found: {board_id}")
    emit("board.deleted", board_id=board_id, entity_id=board_id, payload={})
    if get_board_group_map().get(board_id):
        _emit_global("board.group.assigned", board_id, {"group_id": None})
    if len(get_boards()) == 0:
        _no_boards = True
    schedule_persist()
    return {"deleted": board_id}


def get_skills() -> list[dict[str, Any]]:
    return sorted(
        [skill for skill in _skills if isinstance(skill, dict) and skill.get("deleted") is not True],
        key=lambda skill: skill.get("order") if is_number(skill.get("order")) else 0,
    )


def set_skills(skills_list: Any) -> list[dict[str, Any]]:
    global _skills_seeded
    source = skills_list if isinstance(skills_list, list) else []
    nxt = [
        _normalize_skill(skill, index)
        for index, skill in enumerate(source)
        if not (isinstance(skill, dict) and skill.get("deleted") is True)
    ]
    current = get_skills()
    current_by_id = {skill["id"]: skill for skill in current}
    next_ids = {skill["id"] for skill in nxt}

    for skill in nxt:
        if skill["id"] not in current_by_id:
            _emit_global("skill.created", skill["id"], {"skill": skill})
    for skill in nxt:
        previous = current_by_id.get(skill["id"])
        if not previous:
            continue
        fields = _changed_fields(previous, skill, SKILL_FIELDS)
        if fields:
            _emit_global("skill.updated", skill["id"], {"fields": fields})
    removed = sorted(
        (skill for skill in current if skill["id"] not in next_ids), key=lambda skill: str(skill["id"])
    )
    for skill in removed:
        _emit_global("skill.deleted", skill["id"], {})

    _skills_seeded = True
    return get_skills()


def get_skills_state() -> dict[str, Any]:
    return {"skills": get_skills()}


def get_groups() -> list[dict[str, Any]]:
    return sorted(
        [group for group in _groups if isinstance(group, dict) and group.get("deleted") is not True],
        key=lambda group: group.get("order") if is_number(group.get("order")) else 0,
    )


def set_groups(groups_list: Any) -> list[dict[str, Any]]:
    source = groups_list if isinstance(groups_list, list) else []
    nxt = [
        _normalize_group(group, index)
        for index, group in enumerate(source)
        if not (isinstance(group, dict) and group.get("deleted") is True)
    ]
    current = get_groups()
    current_by_id = {group["id"]: group for group in current}
    next_ids = {group["id"] for group in nxt}
    bindings = get_board_group_map()

    for group in nxt:
        if group["id"] not in current_by_id:
            _emit_global("group.created", group["id"], {"group": group})
    for group in nxt:
        previous = current_by_id.get(group["id"])
        if not previous:
            continue
        fields = _changed_fields(previous, group, GROUP_FIELDS)
        if fields:
            _emit_global("group.updated", group["id"], {"fields": fields})
    removed = sorted(
        (group for group in current if group["id"] not in next_ids), key=lambda group: str(group["id"])
    )
    for group in removed:
        bound_boards = sorted(
            board_id for board_id, group_id in bindings.items() if group_id == group["id"]
        )
        _emit_global("group.deleted", group["id"], {})
        for board_id in bound_boards:
            _emit_global("board.group.assigned", board_id, {"group_id": None})

    return get_groups()


def get_board_group_map() -> dict[str, str]:
    live_groups = _live_group_ids()
    return {
        board_id: group_id
        for board_id, group_id in _board_groups.items()
        if group_id is not None and isinstance(group_id, str) and group_id in live_groups
    }


def set_board_group_map(mapping: Any) -> dict[str, str]:
    nxt = mapping if isinstance(mapping, dict) else {}
    current = get_board_group_map()
    board_ids = sorted({*current.keys(), *nxt.keys()})

    for board_id in board_ids:
        before = current[board_id] if board_id in current else None
        raw = nxt[board_id] if board_id in nxt else None
        after = raw if isinstance(raw, str) else None
        if before != after:
            _emit_global("board.group.assigned", board_id, {"group_id": after})

    return get_board_group_map()


def get_groups_state() -> dict[str, Any]:
    return {"groups": get_groups(), "boardGroups": get_board_group_map()}


def get_recent_events(limit: Any = 100) -> list[dict[str, Any]]:
    count = max(1, min(1000, int(limit))) if is_int(limit) else 100
    return [
        {
            "seq": event.get("seq"),
            "type": event.get("type"),
            "boardId": event.get("board_id"),
            "entityId": event.get("entity_id"),
            "at": event.get("at"),
            "actor": event.get("actor"),
        }
        for event in _events[-count:]
    ]


# ── Verbatim seed skills (harness/src/store.mjs DEFAULT_SKILLS) ──────────────

DEFAULT_SKILLS: list[dict[str, str]] = [
    {
        "name": "人与 subagent 的协作工作方式",
        "description": "人与 AI subagent 在这块看板上如何分工与交接。",
        "content": "\n".join(
            [
                "这块看板是「人 + 多个 AI subagent」共享的唯一事实来源。任务主要由 AI 填写与搬动，人负责看、定方向、下指令。",
                "",
                "【职责分工——谁写什么】",
                "- 描述（description）是 agent 的：立项时由 agent 写，之后由 agent 维护，也是 agent 的回复面。",
                "- 给 agent 的备注（notes to the agent，数据字段 keyPoints）是人的：人一次加一条，agent 只读，不得增删改。",
                "- 任务对话框里只有标题、描述和给 agent 的备注这三样；人写备注，agent 把备注折进描述。",
                "",
                "【人的职责】",
                "- 随时点开任务：看清它要干什么（描述、给 agent 的备注）。",
                "- 用「给 agent 的备注」写下想法、决定和要 agent 做的事。",
                "- 加备注：除 In Progress 外都能加（Backlog、Human In The Loop、Blocked、Finished）；In Progress 整份表单只读。",
                "- 非 Human In The Loop 的任务，标题和描述都是 agent 的，人只改备注；Human In The Loop 里人可以改全部。",
                "- 人只在 Human In The Loop 列手工建任务；其他列的任务由 agent 或流程产生。",
                "",
                "【AI / subagent 的职责】",
                "- 动手前先读：get_task（含给 agent 的备注）、list_tasks、list_skills。",
                "- 认领：claim_task 写明是哪个 subagent 在做；已被别人认领且认领未过期时会被拒绝；认领超过 5 分钟没有活动即过期，过期后才能接管（结果里会写 tookOver）。做完或中断时 release_task；任务还有未消化的备注时 claim_task 会被拒绝。",
                "- 描述由 agent 维护；人的备注不得删改，只能折进描述后标记已消化。",
                "- 开工前必须先消化：把备注折进描述，再用 digest_key_points 清掉 needsDigest；没消化就 claim_task、或把任务移进 In Progress，都会被拒绝。",
                "- 卡住时移到 Blocked 并写 set_blocked_reason。",
                "- 等变化不要轮询 list_events：用 wait_for_event（带上你已经见过的 seq，可加 type / boardId 过滤）；等人的备注或等同波任务收尾都靠它。",
                "",
                "【任务字段（当前模型）】",
                "- 创建任务只需要标题和描述；没有优先级、没有截止日期、没有标签、没有子任务。",
                "- 给 agent 的备注（keyPoints）= 人写的一条条要求；描述（description）= agent 维护的完整说明。",
                "",
                "【五列的语义（固定，不可增删）】",
                "- Backlog：已立项、待认领。人在这里读需求、加备注。",
                "- Human In The Loop：人手工建任务的地方；新任务从这里出发。",
                "- In Progress：已被某个 subagent 认领并在处理中 → 任务表单完全锁定（只读）。",
                "- Blocked：卡住了，必须写原因；连续两次日报仍卡住就升级。",
                "- Finished：已完成，是完成情况的统计来源。",
                "",
                "【交接约定】",
                "- 同一时刻一个任务只应被一个 subagent 认领；已被别人认领（且认领未过期）的任务不要动，认领过期后才允许接管。",
                "- 交接前把进展写进描述，让人不用逐个点开也知道发生了什么。",
                "- 人加了备注后，agent 应把它当成新的输入，折进描述，再用 digest_key_points 标记已消化；备注未消化前不能开工，claim_task 会被拒绝。",
            ]
        ),
    },
    {
        "name": "如何与 AI agent 一起运转这块看板",
        "description": "人与 agent 之间的分工约定。",
        "content": "\n".join(
            [
                "这块看板是人（human）与 AI agent 之间共享的状态。",
                "",
                "人负责：工作方向、给 agent 的备注（keyPoints），以及最终「算不算完成」的拍板。",
                "agent 负责：动手前先通过 MCP 读看板；写并维护描述（description）；认领任务；把人的备注折进描述；",
                "记录卡住的原因；用证据汇报进展。",
                "",
                "协作规则：",
                "- 看板上没有的工作不要凭空开做：先用 create_task 建任务，再做。建任务只需要标题和描述——",
                "  没有优先级、没有截止日期、没有标签、没有子任务。",
                "- 一波任务用 create_tasks 一次建完：{boardId, tasks:[{title, description?}]}，全部落在 Backlog；整批先校验后写入，一条不合法就整批拒绝，绝不部分生效。",
                "- 描述是 agent 的，备注是人的：agent 不得增删改 keyPoints，只能读。",
                "- 动手前先消化：任务带 needsDigest 时，先把新备注折进描述，再用 digest_key_points 标记已消化；没消化就 claim_task、或把任务移进 In Progress，都会被拒绝。",
                "- 只有真的动了才移动任务：开始做时移到 In Progress，做不下去时移到 Blocked 并写原因，",
                "  主工作完成后才移到 Finished。",
                "- 人只通过 Human In The Loop 列手工建任务；Backlog 与其余列由 agent 与流程驱动。",
                "- 与其建一个大任务，不如拆成能一次做完的小任务。",
                "- 人写在「给 agent 的备注」里的指示必须回应：把它折进描述，不要让人的话悬着。",
                "- 评审者需要知道的任何事，都写进任务的描述（description）。",
                "",
                "【计时提醒】任务从 claim_task 那一刻开始计时，任何更新都会重置 5 分钟窗口；只想续命、不改任何内容时用 heartbeat_task（只写 changeDate），把任务移进 In Progress 也会重新开始窗口；细则见「认领工作」。",
            ]
        ),
    },
    {
        "name": "任务拆分与备注",
        "description": "如何把工作切到能一次做完的程度。",
        "content": "\n".join(
            [
                "一个任务只需要标题和描述就能创建；没有优先级、没有截止日期、没有标签、没有子任务。",
                "",
                "给 agent 的备注（keyPoints）是人的输入，不是勾选清单：人一次加一条，agent 只读，不得增删改。",
                "描述（description）是 agent 的：动手前先把任务上的备注折进描述，再用 digest_key_points 标记已消化。",
                "只有 needsDigest 清掉之后，才算真正准备好开工；带未消化备注就 claim_task 会被直接拒绝。",
                "",
                "拆分规则：",
                "- 一个任务 = 一个结果，一天内可交付。",
                "- 按结果切，不要按阶段或文档切。",
                "- 一个任务一天内做不完，就继续拆成多个任务。",
                "- 需要交代的背景和步骤，都写进描述，由 agent 维护。",
            ]
        ),
    },
    {
        "name": "迭代规划",
        "description": "如何用 group／迭代组织工作。",
        "content": "\n".join(
            [
                "group 是人命名的容器，可以改名（人在界面上改名，agent 用 rename_group），里面装着一个或多个迭代。",
                "迭代（iteration）是 group 里的一块看板，按顺序编号（Iteration 1、Iteration 2……），不能手工命名。",
                "一块看板永远属于某个 group，不会独立存在。",
                "group 开头连续若干个「任务全部在 Finished」的迭代，可以用一个控件折叠起来。",
                "",
                "规划流程：",
                "- 开始前先设好迭代日期（startDate/endDate）和一句话目标。",
                "- 只把近期做得了的工作拉进迭代，其余留在 Backlog。",
                "- 让五列保持如实：Backlog、Human In The Loop、In Progress、Blocked、Finished。",
                "- 人只在 Human In The Loop 列手工建任务；Backlog 是 agent 立项的队列。",
                "",
                "读懂数字：",
                "- 每个迭代的起止日期和 Finished 列一起，说明这一轮做完了什么。",
                "",
                "【迭代 = 一波工作（wave）】",
                "- 同一波、可以同时进行的工作放进同一个迭代；必须等前一波做完才能开始的工作，放进下一个迭代（create_board 新建）。",
                "- 一波任务用 create_tasks 一次建完（全部落 Backlog）；整批换列用 move_tasks。",
                "- 一个迭代里的工作全部完成之前，不开始下一个迭代里的工作：先收掉当前这一波，再开新的。",
                "- 这是给 agent 的协作约定，不是硬性闸门：工具不会因为你认领了后面迭代的任务而拒绝，但请自觉按波次推进。",
                "- list_roadmap 会给出每个迭代还有多少没完成（unfinishedTasks），并标出当前的活动迭代（isActive：按 group 顺序第一个没有全部完成的迭代）。",
            ]
        ),
    },
    {
        "name": "认领工作",
        "description": "subagent 的归属规则。",
        "content": "\n".join(
            [
                "这块看板是 subagent 级别的协作工具：subagent 认领任务、推进、然后交回。",
                "",
                "认领：",
                "- 动手前先认领（claim_task 填上你的 agent 名），让人看得见任务归谁；任务还有未消化的备注时认领会被拒绝。",
                "- 停下时释放（release_task），即使任务还没做完。",
                "- 不要做没人认领的任务；已被别人认领的就别碰——除非那份认领已经过期（见下）。",
                "",
                "【认领是硬锁，过期才可接管】",
                "- 认领是硬锁：任务已被别的 subagent 认领、且认领还新鲜时，claim_task 会被拒绝，并在错误里点名持有人。",
                "- 同一 agent 再次认领自己的任务是续期：刷新认领时间和 changeDate，不是冲突。",
                "- 最后一次活动超过 5 分钟，认领即过期；list_tasks / get_task 会返回 claimedBy、claimedAt、changeDate、blockedReason 和 claimExpired，谁持有、持有多久、是否安静一眼可见。",
                "- 看门狗不会替你清掉认领：它只把仍然卡住的 In Progress 任务移进 Blocked 并记录原因；认领是否过期由时间判定，是否接管由 agent 决定。",
                "- 认领过期后可以接管：claim_task 会成功并在结果里说明 tookOver: true；仍然 live 的认领永远不能抢。",
                "- 不知道从哪个任务开始时用 claim_next：它原子地认领下一个 ready 任务。ready = 在 Backlog 或 Human In The Loop、备注已消化、且无人认领或认领已过期；顺序固定为 Backlog 先于 Human In The Loop，再按任务 order，最后按任务 id。",
                "",
                "【计时约定】",
                "- 认领那一刻就开始计时：claim_task 会写入认领时间戳；看门狗按它判断你是否还在线。",
                "- 如果预计还要超过约 5 分钟才能做完，agent 必须在到点前同步一次：任务上的任何更新都算同步",
                "  （改描述、digest_key_points 或重新认领），并重新开始 5 分钟窗口。",
                "- 只想续命、不想动任何内容时，用 heartbeat_task：它只写 changeDate，不动描述、备注、消化标记和列；",
                "  只有「已认领且在 In Progress」的任务能用，其他状态会被拒绝。",
                "- 把任务移进 In Progress 同样算一次活动：窗口从进列那一刻重新开始，刚开工的任务不会被误判为卡住。",
                "- 如果大约 5 分钟内没有任何同步，服务端会把任务移到 Blocked、记录原因，计时随即停止；它不会清掉认领，认领是否过期只由时间判定，接管与否由 agent 决定。",
                "- 正常流程是由 agent 自己移动卡片：主工作完成就移到 Finished；做不下去或需要人拍板就移到",
                "  Blocked 并写原因。移动卡片才是停止计时的方式，计时因此始终如实。",
                "- 任务主要由 agent 用 create_task 创建（落在 Backlog）；人只能在 Human In The Loop 列手工建任务。",
                "",
                "【备注与返工】",
                "- 任务带 needsDigest 时先别开工：把给 agent 的备注折进描述，再 digest_key_points 标记已消化；未消化就 claim_task 会被直接拒绝。",
                "- 已 Finished 的任务若被人加了新备注，会自动回到 Backlog 并带上 isRework——按返工处理，",
                "  消化新备注后再做；digest_key_points 之后 isRework 会被清掉，它只表示还有活要干，不表示曾经返工过。",
                "",
                "【等变化，不要轮询】",
                "- 等人的新备注、或等同波其他任务收尾时，不要循环调用 list_events：用 wait_for_event 传你已经见过的 seq，有事件追加会立刻返回；超时返回 timedOut: true。",
                "- wait_for_event 可以加 type、boardId 过滤；timeoutMs 上限 30000 毫秒（默认 15000）；每次等待结束都会自动清理，反复调用不会留下残留。",
                "",
                "备注与回复：",
                "- 给 agent 的备注（keyPoints）是人给 agent 下指令的通道。动手前先读（get_task），人的话不要删。",
                "- 人的每条备注都要读懂并折进描述（description），再用 digest_key_points 标记已消化。任务处于 In Progress 时整个表单都是只读的。",
            ]
        ),
    },
    {
        "name": "阻塞处理与每日同步",
        "description": "工作停摆时怎么办，以及每日更新长什么样。",
        "content": "\n".join(
            [
                "Blocked 的含义：没有你控制之外的东西就无法继续推进。",
                "",
                "- 一定要写阻塞原因（set_blocked_reason）；只写「blocked」而没原因是没用的。",
                "- Blocked 的任务还没完成；它们是进行中的工作，不是已完成的工作。",
                "- 任务连续两次每日更新仍然卡住，就要升级处理。",
                "",
                "每日更新（agent 写进迭代任务的描述 description）：",
                "- 进展：今天有哪些卡换了列。",
                "- 下一步：接下来要动什么。",
                "- 阻塞：卡住了什么、需要我们做什么。",
            ]
        ),
    },
]


def _seed_default_skills_if_empty() -> None:
    global _skills_seeded
    if _skills_seeded or len(_skills) > 0:
        return
    for index, skill in enumerate(DEFAULT_SKILLS):
        seeded = _normalize_skill(skill, index)
        _emit_global("skill.created", seeded["id"], {"skill": seeded})
    _skills_seeded = True


def reset_for_tests() -> None:
    """Re-import-free reset used only by the test suite."""
    global _meta, _events, _groups, _board_groups, _no_boards, _skills, _skills_seeded
    global _groups_skills_event_sourced, _seen_ids, _applied_ids, _boards, _tasks_by_board
    global _columns_by_board, _settings_by_board, _persist_timer, _writer_id, _held_lock
    global _idempotency, _task_key_counters, _trim_seq, _archived_count
    _meta = {"nodeId": None, "seq": 0}
    _events = []
    _groups = []
    _board_groups = {}
    _no_boards = False
    _skills = []
    _skills_seeded = False
    _groups_skills_event_sourced = False
    _seen_ids = set()
    _applied_ids = set()
    _boards = []
    _tasks_by_board = {}
    _columns_by_board = {}
    _settings_by_board = {}
    _persist_timer = None
    _writer_id = None
    _held_lock = None
    _idempotency = {}
    _task_key_counters = {}
    _trim_seq = 0
    _archived_count = 0
    _event_listeners.clear()
