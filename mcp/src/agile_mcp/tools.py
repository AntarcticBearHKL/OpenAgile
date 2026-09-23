"""The 42 OpenAgile MCP tools — port of ``harness/src/mcp-tools.mjs``.

Tool names, titles and descriptions are copied verbatim from the Node harness
(the descriptions encode the workflow contract). Each handler mutates the shared
board by appending domain events through ``store.emit``; the browser's
event-sourcing pipeline projects the same events, so the UI updates live.

Every handler is ``async`` while its body is a synchronous critical section on
the event loop — the store's monotonic ``seq`` is never mutated across an await.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from mcp import types

from .constants import (
    DEFAULT_BOARD_ID,
    IN_PROGRESS_COLUMN_ID,
    is_done_column,
)
from . import store
from .skill_doc import board_key_prefix
from .store import AGENT_ID
from .util import is_int, is_number, iso_now

BACKLOG_COLUMN_ID = "00000000-0000-4000-8000-000000000030"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _resolve_actor(agent: Any) -> str:
    return agent.strip() if isinstance(agent, str) and agent.strip() else AGENT_ID


def _agent_actor(actor_id: str) -> dict[str, Any]:
    return {"type": "agent", "id": actor_id}


def _resolve_board(board_id: Any) -> str:
    if board_id:
        if not store.get_board(board_id):
            raise ValueError(f"Board not found: {board_id}")
        return board_id
    if store.get_board(DEFAULT_BOARD_ID):
        return DEFAULT_BOARD_ID
    first = store.get_boards()
    if not first:
        raise ValueError("No boards exist")
    return first[0]["id"]


def _resolve_column(board_id: str, ref: Any) -> dict[str, Any]:
    columns = store.get_columns(board_id)
    if not columns:
        raise ValueError(f"Board {board_id} has no columns")
    if ref is None or ref == "":
        return next((column for column in columns if not is_done_column(column)), columns[0])
    by_id = next((column for column in columns if column.get("id") == ref), None)
    if by_id:
        return by_id
    lower = str(ref).lower()
    by_name = next((column for column in columns if str(column.get("name")).lower() == lower), None)
    if by_name:
        return by_name
    raise ValueError(f"Column not found: {ref}")


def _resolve_backlog_column(board_id: str) -> dict[str, Any]:
    columns = store.get_columns(board_id)
    if not columns:
        raise ValueError(f"Board {board_id} has no columns")
    return (
        next((column for column in columns if column.get("id") == BACKLOG_COLUMN_ID), None)
        or next((column for column in columns if str(column.get("name")).lower() == "backlog"), None)
        or next((column for column in columns if not is_done_column(column)), None)
        or columns[0]
    )


def _find_task_or_throw(task_id: Any) -> dict[str, Any]:
    found = store.find_task(task_id)
    if not found:
        raise ValueError(f"Task not found: {task_id}")
    return found


def _assert_notes_digested(task: dict[str, Any]) -> None:
    message = store.pending_notes_message(task)
    if message:
        raise ValueError(message)


def _assert_claim_allows(task: dict[str, Any], actor_id: str) -> None:
    holder = task.get("claimedBy").strip() if isinstance(task.get("claimedBy"), str) else ""
    if holder and holder != actor_id and not store.is_claim_expired(task):
        raise ValueError(
            f"Task {task.get('key') or task.get('id')} is held by {holder} and that claim is still live; "
            f"wait for it to expire or have {holder} release it."
        )


def _assert_expected_seq(expected_seq: Any) -> None:
    if expected_seq is None:
        return
    current = store.get_seq()
    if expected_seq != current:
        raise ValueError(f"Conflict: board changed since seq {expected_seq} (current {current}); re-read and retry.")


def _without_removed_fields(task: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in task.items() if key not in ("comments", "relationships")}


def _claim_read_fields(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "claimedBy": task.get("claimedBy") or "",
        "claimedAt": task.get("claimedAt") or "",
        "changeDate": task.get("changeDate") or "",
        "blockedReason": task.get("blockedReason") or "",
        "claimExpired": store.is_claim_expired(task),
    }


def _max_order(column_id: str, tasks: list[dict[str, Any]]) -> int:
    return max(
        (
            task.get("order") if is_number(task.get("order")) else 0
            for task in tasks
            if task.get("column") == column_id
        ),
        default=0,
    )


def _next_task_key(board_id: str, tasks: list[dict[str, Any]]) -> str:
    prefix = board_key_prefix((store.get_board(board_id) or {}).get("name"))
    import re

    pattern = re.compile("^" + re.escape(prefix) + r"-(\d+)$")
    live_max = 0
    for task in tasks:
        match = pattern.match(task.get("key") if isinstance(task.get("key"), str) else "")
        if match:
            live_max = max(live_max, int(match.group(1)))
    return f"{prefix}-{store.reserve_task_key_number(board_id, live_max)}"


def _prepare_new_task(
    *, board_id: str, title: Any, description: str = "", assignee: str = "", tasks: list[dict[str, Any]], context: str = ""
) -> tuple[dict[str, Any], dict[str, Any]]:
    title_text = str(title).strip() if title is not None else ""
    if not title or not title_text:
        raise ValueError(f"{context}: title is required" if context else "title is required")
    backlog_column = _resolve_backlog_column(board_id)
    now = iso_now()
    task_id = str(uuid.uuid4())
    task = {
        "id": task_id,
        "key": _next_task_key(board_id, tasks),
        "title": title_text,
        "description": description,
        "assignee": assignee,
        "column": backlog_column["id"],
        "order": _max_order(backlog_column["id"], tasks) + 1,
        "creationDate": now,
        "changeDate": now,
        "columnHistory": [{"column": backlog_column["id"], "at": now}],
        "blockedReason": "",
        "blockedAt": None,
    }
    return task, backlog_column


def _build_move_order(
    board_id: str, task_id: str, target_column_id: str, position: Any = None
) -> list[dict[str, Any]]:
    tasks = list(store.get_tasks(board_id))
    by_column: dict[str, list[dict[str, Any]]] = {}
    for entry in tasks:
        column_id = target_column_id if entry.get("id") == task_id else entry.get("column")
        by_column.setdefault(column_id, []).append(entry)
    order: list[dict[str, Any]] = []
    for column_id, items in by_column.items():
        items.sort(key=lambda task: task.get("order") if is_number(task.get("order")) else 0)
        if column_id == target_column_id and is_int(position):
            current = next((index for index, task in enumerate(items) if task.get("id") == task_id), -1)
            if current >= 0:
                entry = items.pop(current)
                items.insert(max(0, min(position, len(items))), entry)
        for index, entry in enumerate(items):
            order.append({"id": entry.get("id"), "column": column_id, "order": index + 1})
    return order


# ── Handlers ──────────────────────────────────────────────────────────────────


async def _list_boards(args: dict[str, Any]) -> Any:
    return store.get_boards()


async def _create_board(args: dict[str, Any]) -> Any:
    return store.create_board(group_id=args.get("groupId") or "")


async def _rename_board(args: dict[str, Any]) -> Any:
    raise ValueError("Iterations are numbered by their position in a group and cannot be renamed.")


async def _delete_board(args: dict[str, Any]) -> Any:
    board_id = args.get("boardId")
    board = store.get_board(board_id)
    if not board:
        raise ValueError(f"Board not found: {board_id}")
    if not store.is_last_board_in_group(board_id):
        raise ValueError(
            f"{board.get('name')} is not the last iteration in its group; earlier iterations fold away and are kept. "
            "Delete the last iteration, or delete the group to remove all of its iterations."
        )
    return store.delete_board(board_id)


async def _list_groups(args: dict[str, Any]) -> Any:
    return {"groups": store.get_groups(), "boardGroups": store.get_board_group_map()}


async def _create_group(args: dict[str, Any]) -> Any:
    name = args.get("name")
    trimmed = name.strip() if isinstance(name, str) else ""
    if not trimmed:
        raise ValueError("name is required")
    groups = store.get_groups()
    order = max((group.get("order") if is_number(group.get("order")) else 0) for group in groups) + 1 if groups else 1
    group = {"id": str(uuid.uuid4()), "name": trimmed, "order": order, "collapsed": False}
    store.set_groups([*groups, group])
    return group


async def _rename_group(args: dict[str, Any]) -> Any:
    group_id = args.get("groupId")
    name = args.get("name")
    trimmed = name.strip() if isinstance(name, str) else ""
    if not trimmed:
        raise ValueError("name is required")
    groups = store.get_groups()
    if not any(group.get("id") == group_id for group in groups):
        raise ValueError(f"Group not found: {group_id}")
    nxt = [{**group, "name": trimmed} if group.get("id") == group_id else group for group in groups]
    store.set_groups(nxt)
    _broadcast_groups()
    return next((group for group in nxt if group.get("id") == group_id), None)


async def _delete_group(args: dict[str, Any]) -> Any:
    group_id = args.get("groupId")
    groups = store.get_groups()
    if not any(group.get("id") == group_id for group in groups):
        raise ValueError(f"Group not found: {group_id}")
    deleted_boards = [board["id"] for board in store.get_boards() if board.get("groupId") == group_id]
    for board_id in deleted_boards:
        store.delete_board(board_id)
    store.set_groups([group for group in groups if group.get("id") != group_id])
    mapping = store.get_board_group_map()
    nxt = {board_id: mapped for board_id, mapped in mapping.items() if mapped != group_id}
    store.set_board_group_map(nxt)
    return {"deleted": group_id, "deletedBoards": deleted_boards}


async def _assign_board_to_group(args: dict[str, Any]) -> Any:
    board_id = args.get("boardId")
    if not store.get_board(board_id):
        raise ValueError(f"Board not found: {board_id}")
    group = store.resolve_group(args.get("groupId") or "")
    mapping = store.get_board_group_map()
    mapping[board_id] = group["id"]
    store.set_board_group_map(mapping)
    return {"boardId": board_id, "groupId": group["id"]}


async def _get_board(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    board = store.get_board(bid)
    columns = [
        {
            "id": column.get("id"),
            "name": column.get("name"),
            "color": column.get("color"),
            "order": column.get("order"),
            "role": column.get("role") or "",
            "wipLimit": column.get("wipLimit") or 0,
        }
        for column in store.get_columns(bid)
    ]
    tasks = [
        {"id": task.get("id"), "key": task.get("key") or "", "title": task.get("title"), "column": task.get("column"), "type": task.get("type") or "task"}
        for task in sorted(store.get_tasks(bid), key=lambda task: task.get("order") if is_number(task.get("order")) else 0)
    ]
    return {"board": board, "columns": columns, "tasks": tasks, "settings": store.get_settings(bid)}


async def _list_columns(args: dict[str, Any]) -> Any:
    return [
        {
            "id": column.get("id"),
            "name": column.get("name"),
            "color": column.get("color"),
            "order": column.get("order"),
            "role": column.get("role") or "",
            "wipLimit": column.get("wipLimit") or 0,
        }
        for column in store.get_columns(_resolve_board(args.get("boardId")))
    ]


async def _list_tasks(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    column = args.get("column")
    column_id = _resolve_column(bid, column)["id"] if column else None
    search = args.get("search")
    needle = str(search).lower() if search else None
    columns_by_id = {col.get("id"): col.get("name") for col in store.get_columns(bid)}
    tasks = store.get_tasks(bid)
    if column_id:
        tasks = [task for task in tasks if task.get("column") == column_id]
    if needle:
        tasks = [
            task
            for task in tasks
            if needle in f"{task.get('title') or ''} {task.get('description') or ''}".lower()
        ]
    if "claimedBy" in args:
        target = args.get("claimedBy")
        tasks = [task for task in tasks if (task.get("claimedBy") or "") == target]
    if "needsDigest" in args:
        target = args.get("needsDigest")
        tasks = [task for task in tasks if (task.get("needsDigest") is True) == target]
    if "ready" in args:
        target = args.get("ready")
        tasks = [task for task in tasks if store.is_ready_task(task) == target]
    tasks = sorted(tasks, key=lambda task: task.get("order") if is_number(task.get("order")) else 0)
    return [
        {
            "id": task.get("id"),
            "key": task.get("key") or "",
            "title": task.get("title"),
            "description": task.get("description") or "",
            "column": task.get("column"),
            "columnName": columns_by_id.get(task.get("column")) or "",
            "type": task.get("type") or "task",
            "assignee": task.get("assignee") or "",
            "keyPoints": task.get("keyPoints") or [],
            "needsDigest": task.get("needsDigest") is True,
            "isRework": task.get("isRework") is True,
            **_claim_read_fields(task),
        }
        for task in tasks
    ]


async def _get_task(args: dict[str, Any]) -> Any:
    found = _find_task_or_throw(args.get("taskId"))
    task = found["task"]
    board_id = found["boardId"]
    column = next((col for col in store.get_columns(board_id) if col.get("id") == task.get("column")), None)
    return {
        "boardId": board_id,
        "columnName": (column or {}).get("name") or "",
        "task": {**_without_removed_fields(task), "claimExpired": store.is_claim_expired(task)},
    }


async def _create_task(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    key = args.get("idempotencyKey").strip() if isinstance(args.get("idempotencyKey"), str) else ""
    if key:
        hit = store.lookup_idempotency(key)
        existing = store.find_task(hit.get("taskId")) if hit else None
        if existing:
            column = next((col for col in store.get_columns(existing["boardId"]) if col.get("id") == existing["task"].get("column")), None)
            return {
                "id": existing["task"].get("id"),
                "key": existing["task"].get("key") or "",
                "boardId": existing["boardId"],
                "column": existing["task"].get("column"),
                "columnName": (column or {}).get("name") or "",
                "idempotent": True,
            }
    task, column = _prepare_new_task(
        board_id=bid,
        title=args.get("title"),
        description=args.get("description") or "",
        assignee=args.get("assignee") or "",
        tasks=store.get_tasks(bid),
    )
    store.emit("task.created", board_id=bid, entity_id=task["id"], payload={"task": task}, actor=_agent_actor(AGENT_ID))
    if key:
        store.record_idempotency(key, task["id"], bid)
    return {"id": task["id"], "key": task["key"], "boardId": bid, "column": column["id"], "columnName": column["name"], "task": task}


async def _create_tasks(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    items = args.get("tasks")
    items = items if isinstance(items, list) else []
    if len(items) == 0:
        raise ValueError("tasks must be a non-empty array")
    planned: list[tuple[dict[str, Any], str]] = []
    planning = list(store.get_tasks(bid))
    seen: dict[str, dict[str, Any]] = {}
    results: list[Any] = [None] * len(items)
    for index, item in enumerate(items):
        where = f"tasks[{index}]"
        if not isinstance(item, dict):
            raise ValueError(f"{where}: an item must be an object with a title")
        key = item.get("idempotencyKey").strip() if isinstance(item.get("idempotencyKey"), str) else ""
        if key:
            prior = seen.get(key)
            hit = prior or store.lookup_idempotency(key)
            existing = None
            if hit:
                existing = hit if "task" in hit else store.find_task(hit.get("taskId"))
            if existing:
                column = next(
                    (col for col in store.get_columns(existing["boardId"]) if col.get("id") == existing["task"].get("column")),
                    None,
                )
                results[index] = {
                    "id": existing["task"].get("id"),
                    "key": existing["task"].get("key") or "",
                    "boardId": existing["boardId"],
                    "column": existing["task"].get("column"),
                    "columnName": (column or {}).get("name") or "",
                    "idempotent": True,
                }
                continue
        task, column = _prepare_new_task(
            board_id=bid,
            title=item.get("title"),
            description=item.get("description") if item.get("description") is not None else "",
            assignee=item.get("assignee") if item.get("assignee") is not None else "",
            tasks=planning,
            context=where,
        )
        if key:
            seen[key] = {"task": task, "boardId": bid}
        planned.append((task, key))
        planning.append(task)
        results[index] = {
            "id": task["id"],
            "key": task["key"],
            "boardId": bid,
            "column": column["id"],
            "columnName": column["name"],
        }
    for task, idempotency_key in planned:
        store.emit("task.created", board_id=bid, entity_id=task["id"], payload={"task": task}, actor=_agent_actor(AGENT_ID))
        if idempotency_key:
            store.record_idempotency(idempotency_key, task["id"], bid)
    return {
        "created": len(planned),
        "skipped": sum(1 for entry in results if isinstance(entry, dict) and entry.get("idempotent") is True),
        "boardId": bid,
        "results": results,
    }


async def _update_task(args: dict[str, Any]) -> Any:
    _assert_expected_seq(args.get("expectedSeq"))
    actor_id = _resolve_actor(args.get("agent"))
    found = _find_task_or_throw(args.get("taskId"))
    task = found["task"]
    board_id = found["boardId"]
    _assert_claim_allows(task, actor_id)
    fields: dict[str, Any] = {}
    if args.get("title") is not None:
        fields["title"] = args.get("title")
    if args.get("description") is not None:
        fields["description"] = args.get("description")
    if args.get("assignee") is not None:
        fields["assignee"] = args.get("assignee")
    if args.get("blockedReason") is not None:
        fields["blockedReason"] = args.get("blockedReason")
        fields["blockedAt"] = iso_now() if args.get("blockedReason") else None
    if not fields:
        raise ValueError("No fields to update")
    fields["changeDate"] = iso_now()
    store.emit("task.updated", board_id=board_id, entity_id=args.get("taskId"), payload={"fields": fields}, actor=_agent_actor(actor_id))
    return {"taskId": args.get("taskId"), "fields": fields}


async def _move_task(args: dict[str, Any]) -> Any:
    _assert_expected_seq(args.get("expectedSeq"))
    actor_id = _resolve_actor(args.get("agent"))
    found = _find_task_or_throw(args.get("taskId"))
    task = found["task"]
    board_id = found["boardId"]
    _assert_claim_allows(task, actor_id)
    target_column = _resolve_column(board_id, args.get("column"))
    if target_column["id"] == IN_PROGRESS_COLUMN_ID:
        _assert_notes_digested(task)
    order = _build_move_order(board_id, args.get("taskId"), target_column["id"], args.get("position"))
    store.emit("task.moved", board_id=board_id, entity_id=args.get("taskId"), payload={"order": order}, actor=_agent_actor(actor_id))
    if target_column["id"] == IN_PROGRESS_COLUMN_ID and not task.get("claimedBy"):
        now = iso_now()
        store.emit(
            "task.updated",
            board_id=board_id,
            entity_id=args.get("taskId"),
            payload={"fields": {"claimedBy": actor_id, "claimedAt": now, "assignee": task.get("assignee") or actor_id, "changeDate": now}},
            actor=_agent_actor(actor_id),
        )
    return {"taskId": args.get("taskId"), "column": target_column["id"], "columnName": target_column["name"], "order": order}


async def _move_tasks(args: dict[str, Any]) -> Any:
    _assert_expected_seq(args.get("expectedSeq"))
    actor_id = _resolve_actor(args.get("agent"))
    raw_ids = args.get("taskIds")
    task_ids = raw_ids if isinstance(raw_ids, list) else []
    if len(task_ids) == 0:
        raise ValueError("taskIds must be a non-empty array")
    moves = []
    for index, raw_id in enumerate(task_ids):
        task_id = raw_id.strip() if isinstance(raw_id, str) else ""
        if not task_id:
            raise ValueError(f"taskIds[{index}]: taskId is required")
        found = _find_task_or_throw(task_id)
        task = found["task"]
        board_id = found["boardId"]
        _assert_claim_allows(task, actor_id)
        target_column = _resolve_column(board_id, args.get("column"))
        if target_column["id"] == IN_PROGRESS_COLUMN_ID:
            _assert_notes_digested(task)
        moves.append((task, board_id, target_column))
    results = []
    for task, board_id, target_column in moves:
        order = _build_move_order(board_id, task["id"], target_column["id"])
        store.emit("task.moved", board_id=board_id, entity_id=task["id"], payload={"order": order}, actor=_agent_actor(actor_id))
        if target_column["id"] == IN_PROGRESS_COLUMN_ID and not task.get("claimedBy"):
            now = iso_now()
            store.emit(
                "task.updated",
                board_id=board_id,
                entity_id=task["id"],
                payload={"fields": {"claimedBy": actor_id, "claimedAt": now, "assignee": task.get("assignee") or actor_id, "changeDate": now}},
                actor=_agent_actor(actor_id),
            )
        results.append({"taskId": task["id"], "key": task.get("key") or "", "boardId": board_id, "column": target_column["id"], "columnName": target_column["name"]})
    return {"moved": len(results), "column": moves[0][2]["id"], "columnName": moves[0][2]["name"], "results": results}


async def _delete_task(args: dict[str, Any]) -> Any:
    _assert_expected_seq(args.get("expectedSeq"))
    actor_id = _resolve_actor(args.get("agent"))
    found = _find_task_or_throw(args.get("taskId"))
    task = found["task"]
    board_id = found["boardId"]
    _assert_claim_allows(task, actor_id)
    column = next((col for col in store.get_columns(board_id) if col.get("id") == task.get("column")), None)
    if is_done_column(column):
        raise ValueError(f"Task {task.get('key') or task.get('id')}: a task in the Finished column cannot be deleted; completed work is kept.")
    store.emit("task.deleted", board_id=board_id, entity_id=args.get("taskId"), payload={}, actor=_agent_actor(actor_id))
    return {"deleted": args.get("taskId")}


async def _create_column(args: dict[str, Any]) -> Any:
    raise ValueError("Columns are fixed: Backlog, Human In The Loop, In Progress, Blocked, Finished.")


async def _update_column(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    column = next((col for col in store.get_columns(bid) if col.get("id") == args.get("columnId")), None)
    if not column:
        raise ValueError(f"Column not found: {args.get('columnId')}")
    fields: dict[str, Any] = {}
    if args.get("color") is not None:
        fields["color"] = args.get("color")
    if args.get("wipLimit") is not None:
        fields["wipLimit"] = args.get("wipLimit")
    if not fields:
        raise ValueError("No fields to update")
    store.emit("column.updated", board_id=bid, entity_id=args.get("columnId"), payload={"fields": fields}, actor=_agent_actor(AGENT_ID))
    return {"columnId": args.get("columnId"), "fields": fields}


async def _delete_column(args: dict[str, Any]) -> Any:
    raise ValueError("Columns are fixed and cannot be deleted.")


async def _reorder_columns(args: dict[str, Any]) -> Any:
    raise ValueError("Columns are fixed and cannot be reordered.")


async def _set_blocked_reason(args: dict[str, Any]) -> Any:
    found = _find_task_or_throw(args.get("taskId"))
    reason = args.get("reason") or ""
    now = iso_now()
    store.emit(
        "task.updated",
        board_id=found["boardId"],
        entity_id=args.get("taskId"),
        payload={"fields": {"blockedReason": reason, "blockedAt": now if reason else None, "changeDate": now}},
        actor=_agent_actor(AGENT_ID),
    )
    return {"taskId": args.get("taskId"), "blockedReason": reason}


async def _set_board_dates(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    fields: dict[str, Any] = {}
    if args.get("startDate") is not None:
        fields["startDate"] = args.get("startDate")
    if args.get("endDate") is not None:
        fields["endDate"] = args.get("endDate")
    if args.get("goal") is not None:
        fields["goal"] = args.get("goal")
    if not fields:
        raise ValueError("No fields to update")
    store.emit("board.updated", board_id=bid, entity_id=bid, payload={"fields": fields}, actor=_agent_actor(AGENT_ID))
    return {"boardId": bid, "fields": fields}


async def _list_roadmap(args: dict[str, Any]) -> Any:
    groups = store.get_groups()
    boards = store.get_boards()
    position = {board["id"]: index for index, board in enumerate(boards)}
    group_rank = {group["id"]: index for index, group in enumerate(groups)}
    ordered = sorted(
        boards,
        key=lambda board: (
            group_rank.get(board.get("groupId"), len(groups)),
            position[board["id"]],
        ),
    )
    rows: dict[str, dict[str, Any]] = {}
    active_id = ""
    for board in ordered:
        row = store.get_board(board["id"]) or {}
        columns = store.get_columns(board["id"])
        done_column_id = next((column.get("id") for column in columns if column.get("role") == "done"), "") or ""
        tasks = store.get_tasks(board["id"])
        done_tasks = [task for task in tasks if task.get("column") == done_column_id]
        unfinished = len(tasks) - len(done_tasks)
        if not active_id and not (len(tasks) > 0 and unfinished == 0):
            active_id = board["id"]
        rows[board["id"]] = {
            "id": board["id"],
            "name": board.get("name"),
            "groupId": board.get("groupId") or "",
            "startDate": row.get("startDate") or "",
            "endDate": row.get("endDate") or "",
            "goal": row.get("goal") or "",
            "tasks": len(tasks),
            "doneTasks": len(done_tasks),
            "unfinishedTasks": unfinished,
            "isActive": False,
        }
    return [{**rows[board["id"]], "isActive": board["id"] == active_id} for board in ordered]


async def _digest_key_points(args: dict[str, Any]) -> Any:
    return store.digest_key_points(args.get("taskId"), args.get("pointIds"))


async def _undigest_key_points(args: dict[str, Any]) -> Any:
    actor_id = _resolve_actor(args.get("agent"))
    found = _find_task_or_throw(args.get("taskId"))
    task = found["task"]
    board_id = found["boardId"]
    raw_ids = args.get("pointIds")
    selected = set(raw_ids) if isinstance(raw_ids, list) and len(raw_ids) > 0 else None
    undigested: list[Any] = []
    key_points = []
    for point in task.get("keyPoints") if isinstance(task.get("keyPoints"), list) else []:
        if not isinstance(point, dict) or not point.get("digestedAt"):
            key_points.append(point)
            continue
        if selected is not None and point.get("id") not in selected:
            key_points.append(point)
            continue
        undigested.append(point.get("id"))
        key_points.append({key: value for key, value in point.items() if key != "digestedAt"})
    now = iso_now()
    store.emit(
        "task.updated",
        board_id=board_id,
        entity_id=args.get("taskId"),
        payload={"fields": {"keyPoints": key_points, "needsDigest": True, "changeDate": now}},
        actor=_agent_actor(actor_id),
    )
    return {"taskId": args.get("taskId"), "undigested": undigested}


async def _claim_task(args: dict[str, Any]) -> Any:
    found = _find_task_or_throw(args.get("taskId"))
    task = found["task"]
    board_id = found["boardId"]
    _assert_notes_digested(task)
    agent = args.get("agent")
    agent = AGENT_ID if agent is None else agent
    now = iso_now()
    holder = task.get("claimedBy").strip() if isinstance(task.get("claimedBy"), str) else ""
    if holder and holder != agent and not store.is_claim_expired(task):
        raise ValueError(
            f"Task {task.get('key') or task.get('id')} is already claimed by {holder} and that claim is still live; "
            f"wait for it to expire or have {holder} release it."
        )
    fields = {"claimedBy": agent, "claimedAt": now, "changeDate": now}
    if not task.get("assignee"):
        fields["assignee"] = agent
    store.emit("task.updated", board_id=board_id, entity_id=args.get("taskId"), payload={"fields": fields}, actor=_agent_actor(AGENT_ID))
    if holder and holder != agent:
        return {"taskId": args.get("taskId"), "key": task.get("key") or "", "claimedBy": agent, "claimedAt": now, "tookOver": True, "previousHolder": holder, "message": f"Took over the expired claim from {holder}."}
    if holder == agent:
        return {"taskId": args.get("taskId"), "key": task.get("key") or "", "claimedBy": agent, "claimedAt": now, "renewed": True, "message": "Renewed the existing claim."}
    return {"taskId": args.get("taskId"), "key": task.get("key") or "", "claimedBy": agent, "claimedAt": now, "message": "Claimed."}


async def _claim_next(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    agent = args.get("agent")
    agent = AGENT_ID if agent is None else agent
    now_ms = _now_ms()
    task = store.next_ready_task(bid, now_ms)
    if not task:
        return {"claimed": False, "boardId": bid, "reason": "No ready task in Backlog or Human In The Loop."}
    holder = task.get("claimedBy").strip() if isinstance(task.get("claimedBy"), str) else ""
    at = iso_now()
    fields = {"claimedBy": agent, "claimedAt": at, "changeDate": at}
    if not task.get("assignee"):
        fields["assignee"] = agent
    store.emit("task.updated", board_id=bid, entity_id=task["id"], payload={"fields": fields}, actor=_agent_actor(AGENT_ID))
    result = {
        "claimed": True,
        "taskId": task.get("id"),
        "key": task.get("key") or "",
        "boardId": bid,
        "column": task.get("column"),
        "claimedBy": agent,
        "claimedAt": at,
    }
    if holder and holder != agent:
        result["tookOver"] = True
        result["previousHolder"] = holder
    return result


async def _release_task(args: dict[str, Any]) -> Any:
    found = _find_task_or_throw(args.get("taskId"))
    now = iso_now()
    store.emit(
        "task.updated",
        board_id=found["boardId"],
        entity_id=args.get("taskId"),
        payload={"fields": {"claimedBy": "", "changeDate": now}},
        actor=_agent_actor(AGENT_ID),
    )
    return {"taskId": args.get("taskId"), "claimedBy": ""}


async def _heartbeat_task(args: dict[str, Any]) -> Any:
    found = _find_task_or_throw(args.get("taskId"))
    task = found["task"]
    board_id = found["boardId"]
    if task.get("column") != IN_PROGRESS_COLUMN_ID:
        raise ValueError(
            f"Task {task.get('key') or task.get('id')} is not in In Progress; the five-minute claim window is not running for it, "
            "so a heartbeat would change nothing."
        )
    if not task.get("claimedBy") and not task.get("claimedAt"):
        raise ValueError(f"Task {task.get('key') or task.get('id')} has no claim; run claim_task first, or there is no claim to keep alive.")
    now = iso_now()
    store.emit("task.updated", board_id=board_id, entity_id=args.get("taskId"), payload={"fields": {"changeDate": now}}, actor=_agent_actor(AGENT_ID))
    return {"taskId": args.get("taskId"), "changeDate": now}


async def _list_skills(args: dict[str, Any]) -> Any:
    return [{"id": skill.get("id"), "name": skill.get("name"), "description": skill.get("description")} for skill in store.get_skills()]


async def _get_skill(args: dict[str, Any]) -> Any:
    skill_ref = args.get("skill")
    skills = store.get_skills()
    needle = str(skill_ref).lower()
    found = next((skill for skill in skills if skill.get("id") == skill_ref), None) or next(
        (skill for skill in skills if str(skill.get("name")).lower() == needle), None
    )
    if not found:
        raise ValueError(f"Skill not found: {skill_ref}")
    return found


async def _create_skill(args: dict[str, Any]) -> Any:
    skills = store.get_skills()
    skill = {
        "id": str(uuid.uuid4()),
        "name": str(args.get("name")),
        "description": args.get("description") or "",
        "content": args.get("content") or "",
        "order": len(skills) + 1,
    }
    store.set_skills([*skills, skill])
    return skill


async def _update_skill(args: dict[str, Any]) -> Any:
    skill_id = args.get("skillId")
    skills = store.get_skills()
    if not any(skill.get("id") == skill_id for skill in skills):
        raise ValueError(f"Skill not found: {skill_id}")
    nxt = [
        {
            **skill,
            "name": args.get("name") if args.get("name") is not None else skill.get("name"),
            "description": args.get("description") if args.get("description") is not None else skill.get("description"),
            "content": args.get("content") if args.get("content") is not None else skill.get("content"),
        }
        if skill.get("id") == skill_id
        else skill
        for skill in skills
    ]
    store.set_skills(nxt)
    return next((skill for skill in nxt if skill.get("id") == skill_id), None)


async def _delete_skill(args: dict[str, Any]) -> Any:
    skill_id = args.get("skillId")
    skills = store.get_skills()
    if not any(skill.get("id") == skill_id for skill in skills):
        raise ValueError(f"Skill not found: {skill_id}")
    store.set_skills([skill for skill in skills if skill.get("id") != skill_id])
    return {"deleted": skill_id}


async def _get_board_snapshot(args: dict[str, Any]) -> Any:
    snapshot = store.get_snapshot(_resolve_board(args.get("boardId")))
    tasks = [_without_removed_fields(task) for task in (snapshot.get("state", {}).get("tasks") or [])]
    return {**snapshot, "state": {**(snapshot.get("state") or {}), "tasks": tasks}}


async def _get_settings(args: dict[str, Any]) -> Any:
    return store.get_settings(_resolve_board(args.get("boardId")))


async def _update_settings(args: dict[str, Any]) -> Any:
    bid = _resolve_board(args.get("boardId"))
    fields = args.get("fields")
    if not isinstance(fields, dict):
        raise ValueError("fields must be an object")
    store.emit("settings.updated", board_id=bid, entity_id=bid, payload={"fields": fields}, actor=_agent_actor(AGENT_ID))
    return {"boardId": bid, "fields": fields}


async def _list_events(args: dict[str, Any]) -> Any:
    return store.get_recent_events(args.get("limit"))


async def _wait_for_event(args: dict[str, Any]) -> Any:
    since = args.get("since")
    since = since if is_number(since) else 0
    timeout = args.get("timeoutMs")
    bounded = max(1, min(store.MAX_WAIT_MS, timeout if is_number(timeout) else 15000))
    event = await store.wait_for_event(
        since=since,
        timeout_ms=bounded,
        type=args.get("type") or "",
        board_id=args.get("boardId") or "",
    )
    if not event:
        return {"timedOut": True, "seq": store.get_seq(), "since": since}
    return {
        "timedOut": False,
        "seq": event.get("seq"),
        "since": since,
        "event": {
            "seq": event.get("seq"),
            "type": event.get("type"),
            "boardId": event.get("board_id"),
            "entityId": event.get("entity_id"),
            "at": event.get("at"),
            "actor": event.get("actor"),
            "payload": event.get("payload"),
        },
    }


# ── Registry ──────────────────────────────────────────────────────────────────

_HANDLERS: dict[str, Callable[[dict[str, Any]], Awaitable[Any]]] = {
    "list_boards": _list_boards,
    "create_board": _create_board,
    "rename_board": _rename_board,
    "delete_board": _delete_board,
    "list_groups": _list_groups,
    "create_group": _create_group,
    "rename_group": _rename_group,
    "delete_group": _delete_group,
    "assign_board_to_group": _assign_board_to_group,
    "get_board": _get_board,
    "list_columns": _list_columns,
    "list_tasks": _list_tasks,
    "get_task": _get_task,
    "create_task": _create_task,
    "create_tasks": _create_tasks,
    "update_task": _update_task,
    "move_task": _move_task,
    "move_tasks": _move_tasks,
    "delete_task": _delete_task,
    "create_column": _create_column,
    "update_column": _update_column,
    "delete_column": _delete_column,
    "reorder_columns": _reorder_columns,
    "set_blocked_reason": _set_blocked_reason,
    "set_board_dates": _set_board_dates,
    "list_roadmap": _list_roadmap,
    "digest_key_points": _digest_key_points,
    "undigest_key_points": _undigest_key_points,
    "claim_task": _claim_task,
    "claim_next": _claim_next,
    "release_task": _release_task,
    "heartbeat_task": _heartbeat_task,
    "list_skills": _list_skills,
    "get_skill": _get_skill,
    "create_skill": _create_skill,
    "update_skill": _update_skill,
    "delete_skill": _delete_skill,
    "get_board_snapshot": _get_board_snapshot,
    "get_settings": _get_settings,
    "update_settings": _update_settings,
    "list_events": _list_events,
    "wait_for_event": _wait_for_event,
}

STR = {"type": "string"}
INT = {"type": "integer"}
BOOL = {"type": "boolean"}
STR_ARRAY = {"type": "array", "items": {"type": "string"}}


@dataclass(frozen=True)
class ToolSpec:
    name: str
    title: str
    description: str
    input_schema: dict[str, Any]


def _schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


TOOL_SPECS: list[ToolSpec] = [
    ToolSpec("list_boards", "List boards", "List all iterations (boards) with id, derived name and groupId. Every iteration belongs to a group.", _schema({})),
    ToolSpec("create_board", "Create board", "Create an iteration (board) inside a group. An iteration is named Iteration N from its position in the group and is not named by hand.", _schema({"groupId": {**STR, "description": "Group that will hold the iteration; defaults to the last group"}})),
    ToolSpec("rename_board", "Rename board", "Iterations are named Iteration 1, Iteration 2, ... from their position in a group and cannot be renamed by hand; this tool always refuses.", _schema({"boardId": STR}, ["boardId"])),
    ToolSpec("delete_board", "Delete board", "Delete an iteration (board) that is the last one in its group. Earlier iterations fold away and are kept, so only the last iteration of a group can be deleted. To remove a whole group together with its iterations, use delete_group — that is the deliberate exception.", _schema({"boardId": STR}, ["boardId"])),
    ToolSpec("list_groups", "List groups", "List the user-named groups and the mapping from each iteration to its group.", _schema({})),
    ToolSpec("create_group", "Create group", "Create a group: a user-named container that holds iterations. A group can be renamed.", _schema({"name": {**STR, "description": "Group name, as given by the user"}}, ["name"])),
    ToolSpec("rename_group", "Rename group", "Rename a group: a group is the user-named container that holds iterations. The numbered iterations inside it (Iteration 1, Iteration 2, ...) cannot be renamed.", _schema({"groupId": STR, "name": {**STR, "description": "New group name, as given by the user"}}, ["groupId", "name"])),
    ToolSpec("delete_group", "Delete group", "Delete a group and the iterations it holds. A board can never live outside a group, so its iterations are deleted with it — this is the deliberate exception to the rule that only a group's last iteration can be deleted.", _schema({"groupId": STR}, ["groupId"])),
    ToolSpec("assign_board_to_group", "Assign board to group", "Move an iteration into a group. Every iteration belongs to a group and cannot be left outside one: an empty groupId attaches it to the last group.", _schema({"boardId": STR, "groupId": STR}, ["boardId"])),
    ToolSpec("get_board", "Get board", "Get an iteration with its columns and tasks.", _schema({"boardId": STR})),
    ToolSpec("list_columns", "List columns", "List the five fixed columns of an iteration (id, name, order).", _schema({"boardId": STR})),
    ToolSpec(
        "list_tasks",
        "List tasks",
        "List tasks in an iteration, optionally filtered by column (id or name), a text search over title/description, claimedBy (exact match; an empty string selects unclaimed tasks), needsDigest (boolean) or ready (boolean; the state claim_next dispatches — Backlog or Human In The Loop, notes digested, and unclaimed or expired-claimed). Every task reports who holds the claim and when it was last active: claimedBy, claimedAt, changeDate, blockedReason and claimExpired.",
        _schema({"boardId": STR, "column": STR, "search": STR, "claimedBy": STR, "needsDigest": BOOL, "ready": BOOL}),
    ),
    ToolSpec("get_task", "Get task", "Get a single task by id: its title, description, the notes to the agent (keyPoints) and its claim state — who holds it (claimedBy), since when (claimedAt), when it was last active (changeDate), its blocked reason and whether the claim is expired (claimExpired).", _schema({"taskId": STR}, ["taskId"])),
    ToolSpec("create_task", "Create task", "Create a task in Backlog with a title and a description. Pass idempotencyKey to make the call safe to retry: a key that already resolved returns the existing task instead of creating a second one. Notes to the agent (keyPoints) belong to the human: no tool can add, edit or remove them, and the agent only reads and digests them.", _schema({"title": {**STR, "description": "Task title"}, "description": STR, "assignee": STR, "boardId": STR, "idempotencyKey": {**STR, "description": "Optional retry key; a key that already resolved returns the existing task"}}, ["title"])),
    ToolSpec(
        "create_tasks",
        "Create tasks",
        "Create a batch of tasks in one call: pass a board and a list of items, each with a title and an optional description. Every item lands in Backlog. Pass a per-item idempotencyKey to make retries safe: items whose key already resolved are skipped and reported as existing (idempotent: true), and skipped counts them. The whole batch is validated before anything is written — an empty title or a board that does not exist refuses the entire batch with an error naming the offending item, so a partial batch is never applied. Emits one task.created event per created task, not one batch event: the reducer and the SSE stream project event by event, so each task lands exactly as a single create_task would. Returns one result per item with the created id and key.",
        _schema(
            {
                "boardId": {**STR, "description": "Board that receives the tasks; defaults to the default board"},
                "tasks": {
                    "type": "array",
                    "description": "Tasks to create, in order; every item needs a non-empty title, description and assignee are optional",
                    "items": _schema({"title": STR, "description": STR, "assignee": STR, "idempotencyKey": {**STR, "description": "Optional retry key; an item whose key already resolved is skipped and reported as existing"}}),
                },
            },
            ["tasks"],
        ),
    ),
    ToolSpec("update_task", "Update task", "Update a task's title, description, assignee or blocked reason. Refused while another agent holds a live claim on the task, naming the holder. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it. The notes to the agent (keyPoints) cannot be added, edited or removed here, and this tool cannot clear needsDigest: only digest_key_points does that.", _schema({"taskId": STR, "title": STR, "description": STR, "assignee": STR, "blockedReason": STR, "agent": {**STR, "description": "Calling agent identity; defaults to the harness agent name"}, "expectedSeq": {**INT, "description": "Fail if the board has changed since this seq"}}, ["taskId"])),
    ToolSpec("move_task", "Move task", "Move a task to a column (id or name). Emits the full per-column ordering so the board converges. Refused while another agent holds a live claim on the task, naming the holder. Moving an unclaimed task into In Progress claims it for the caller, so it never lands there unowned. Moving a task into In Progress is refused while it has undigested notes from the human; run digest_key_points first. Entering In Progress counts as activity and restarts the task's five-minute sync window. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it.", _schema({"taskId": STR, "column": STR, "position": {**INT, "description": "0-based position within the target column; default appends"}, "agent": {**STR, "description": "Calling agent identity; defaults to the harness agent name"}, "expectedSeq": {**INT, "description": "Fail if the board has changed since this seq"}}, ["taskId", "column"])),
    ToolSpec("move_tasks", "Move tasks", "Move a batch of tasks to one target column (id or name) in a single call. The whole batch is validated before anything is moved — a task that does not exist, a column that is not one of the five, a task held by another agent under a live claim, or a move into In Progress while any item still has undigested notes refuses the entire batch with an error naming the offending item, so a partial batch is never applied. Reuses the exact checks move_task enforces, including the digest gate. Moving an unclaimed task into In Progress claims it for the caller, so it never lands there unowned. Emits one task.moved event per task, each carrying the full per-column ordering, not one batch event: the reducer and the SSE stream project event by event, so the board converges exactly as single moves would. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it. Returns one result per item.", _schema({"taskIds": {**STR_ARRAY, "description": "Task ids to move, in the order they should land in the target column"}, "column": {**STR, "description": "Target column id or one of the five fixed names"}, "agent": {**STR, "description": "Calling agent identity; defaults to the harness agent name"}, "expectedSeq": {**INT, "description": "Fail if the board has changed since this seq"}}, ["taskIds", "column"])),
    ToolSpec("delete_task", "Delete task", "Delete a task by id. A task in the Finished column cannot be deleted — the board keeps completed work, so tidying up can never erase it. Refused while another agent holds a live claim on the task, naming the holder. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it.", _schema({"taskId": STR, "agent": {**STR, "description": "Calling agent identity; defaults to the harness agent name"}, "expectedSeq": {**INT, "description": "Fail if the board has changed since this seq"}}, ["taskId"])),
    ToolSpec("create_column", "Create column", "Columns are fixed: Backlog, Human In The Loop, In Progress, Blocked, Finished. Adding a column is rejected.", _schema({"name": STR, "color": STR, "wipLimit": INT, "role": {"type": "string", "enum": ["done"]}, "boardId": STR}, ["name"])),
    ToolSpec("update_column", "Update column", "Set a column colour or WIP limit. Column names are fixed and cannot be changed.", _schema({"columnId": STR, "color": STR, "wipLimit": INT, "boardId": STR}, ["columnId"])),
    ToolSpec("delete_column", "Delete column", "Columns are fixed and cannot be deleted; this tool is rejected.", _schema({"columnId": STR, "boardId": STR}, ["columnId"])),
    ToolSpec("reorder_columns", "Reorder columns", "Columns are fixed and cannot be reordered; this tool is rejected.", _schema({"order": {"type": "array", "items": _schema({"id": STR, "order": {"type": "number"}}, ["id", "order"])}, "boardId": STR}, ["order"])),
    ToolSpec("set_blocked_reason", "Set blocked reason", "Record why a task is blocked, or clear it by passing an empty reason.", _schema({"taskId": STR, "reason": STR}, ["taskId"])),
    ToolSpec("set_board_dates", "Set iteration dates", "Set the start/end dates and the goal of an iteration. The dates and the goal show on the roadmap.", _schema({"boardId": STR, "startDate": STR, "endDate": STR, "goal": STR})),
    ToolSpec("list_roadmap", "List roadmap", "List iterations with dates, goal and task counts. Each iteration reports unfinishedTasks (tasks not in the Finished column) and isActive: the active iteration is the first one not fully finished, in group order, then by the iteration's position in its group. An iteration with no tasks is not fully finished.", _schema({})),
    ToolSpec("digest_key_points", "Digest key points", "Fold the human's notes (keyPoints) into the description: stamps digestedAt on the notes and clears the needsDigest flag. This is the only way to clear it; claim_task and moving into In Progress are refused until it runs. undigest_key_points reverses this by removing the digestedAt stamps and setting needsDigest again. Pass pointIds to stamp specific notes, or omit them to stamp every undigested note. Notes are never added, edited or removed here. Digesting also clears the task's isRework marker: taking the rework on is the action the marker asks for.", _schema({"taskId": STR, "pointIds": STR_ARRAY}, ["taskId"])),
    ToolSpec("undigest_key_points", "Undigest key points", "Reverse digest_key_points: removes the digestedAt stamp from the human's notes and sets needsDigest back to true, so claim_task and moving into In Progress are refused again until the notes are digested. Pass pointIds to restore specific notes, or omit them to restore every digested note. Notes are never added, edited or removed here.", _schema({"taskId": STR, "pointIds": STR_ARRAY, "agent": {**STR, "description": "Calling agent identity; defaults to the harness agent name"}}, ["taskId"])),
    ToolSpec("claim_task", "Claim task", "Claim a task for the current subagent: a hard lock. Refused while the task still has undigested notes from the human (run digest_key_points first) and refused when another agent holds a live claim, naming the holder. Re-claiming your own task is a renewal: the claim timestamp and changeDate are refreshed, and the result says renewed. A claim whose last activity is older than the five-minute window is expired; claiming over an expired claim succeeds as a takeover and the result says tookOver.", _schema({"taskId": STR, "agent": STR}, ["taskId"])),
    ToolSpec("claim_next", "Claim next task", "Atomically claim the next ready task for the calling agent, so a coordinator can dispatch without racing. Ready means: in Backlog or Human In The Loop, no undigested notes, and either unclaimed or holding an expired claim. Deterministic ordering rule: Backlog before Human In The Loop, then ascending task order, then task id. Returns claimed: false when nothing is ready; a takeover of an expired claim returns tookOver: true.", _schema({"boardId": STR, "agent": STR})),
    ToolSpec("release_task", "Release task", "Release a claimed task: clears claimedBy and keeps claimedAt so the claim duration stays derivable.", _schema({"taskId": STR}, ["taskId"])),
    ToolSpec("heartbeat_task", "Heartbeat task", "Keep a claim alive without changing anything else: writes only changeDate, so it counts as a sync and restarts the five-minute window. It never touches the description, the notes, the digests, the column or the claim. Allowed only for a task that is in In Progress and carries a claim, because that is the only state the stale-claim watchdog measures; every other state is refused.", _schema({"taskId": STR}, ["taskId"])),
    ToolSpec("list_skills", "List skills", "List the collaboration skills / usage guides the human wants the agent to follow on this board.", _schema({})),
    ToolSpec("get_skill", "Get skill", "Return the full text of one skill, by id or by name.", _schema({"skill": STR}, ["skill"])),
    ToolSpec("create_skill", "Create skill", "Create a collaboration skill: a usage guide the agent should follow.", _schema({"name": STR, "description": STR, "content": STR}, ["name"])),
    ToolSpec("update_skill", "Update skill", "Update a skill name, description or content.", _schema({"skillId": STR, "name": STR, "description": STR, "content": STR}, ["skillId"])),
    ToolSpec("delete_skill", "Delete skill", "Delete a skill by id.", _schema({"skillId": STR}, ["skillId"])),
    ToolSpec("get_board_snapshot", "Get raw board snapshot", "Return the projected read model for a board (boards, tasks, columns, settings) and current event seq. Tasks omit the removed comments and relationships fields.", _schema({"boardId": STR})),
    ToolSpec("get_settings", "Get board settings", "Return the settings object for a board.", _schema({"boardId": STR})),
    ToolSpec("update_settings", "Update board settings", "Merge fields into a board settings object (e.g. showChangeDate, locale).", _schema({"boardId": STR, "fields": {"type": "object", "additionalProperties": True}}, ["fields"])),
    ToolSpec("list_events", "List recent events", "Return the most recent domain events (the audit trail), oldest first.", _schema({"limit": INT})),
    ToolSpec(
        "wait_for_event",
        "Wait for the next event",
        "Wait until a domain event is appended after the sequence number you have already seen, then return it. Resolves on the next append rather than polling — no list_events loop. Optional type and boardId filters narrow the wait, for example to a worker's own board. When no matching event arrives within timeoutMs the wait ends cleanly with timedOut: true and the current seq; timeoutMs is capped at 30000 ms (default 15000). The append listener is removed when the wait ends, so repeated calls leak nothing.",
        _schema(
            {
                "since": {**INT, "description": "The seq you have already seen; the wait resolves on an event with a greater seq"},
                "timeoutMs": {**INT, "description": "Upper bound in milliseconds, capped at 30000; defaults to 15000"},
                "type": {**STR, "description": "Only resolve for this event type, e.g. task.updated"},
                "boardId": {**STR, "description": "Only resolve for events on this board"},
            },
            ["since"],
        ),
    ),
]

TOOLS: dict[str, ToolSpec] = {spec.name: spec for spec in TOOL_SPECS}

def _noop_broadcast() -> None:
    return None


# broadcast hook wired by the host app so rename_group can publish immediately.
_BROADCAST_GROUPS: Callable[[], None] = _noop_broadcast


def set_broadcast_groups(fn: Callable[[], None]) -> None:
    global _BROADCAST_GROUPS
    _BROADCAST_GROUPS = fn


def _broadcast_groups() -> None:
    _BROADCAST_GROUPS()


def build_mcp_tools() -> list[types.Tool]:
    return [
        types.Tool(name=spec.name, title=spec.title, description=spec.description, input_schema=spec.input_schema)
        for spec in TOOL_SPECS
    ]


async def call_tool(name: str, arguments: dict[str, Any] | None) -> types.CallToolResult:
    spec = TOOLS.get(name)
    if spec is None:
        return types.CallToolResult(
            content=[types.TextContent(type="text", text=f"Unknown tool: {name}")],
            is_error=True,
        )
    try:
        result = await _HANDLERS[name](arguments or {})
    except Exception as exc:  # noqa: BLE001 - tool errors are returned in-band
        return types.CallToolResult(content=[types.TextContent(type="text", text=str(exc))], is_error=True)
    text = result if isinstance(result, str) else json.dumps(result, indent=2, ensure_ascii=False)
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)])


TOOL_NAMES: list[str] = [spec.name for spec in TOOL_SPECS]

__all__ = ["TOOL_SPECS", "TOOLS", "TOOL_NAMES", "build_mcp_tools", "call_tool", "set_broadcast_groups"]
