"""Pure event reducer — port of ``client/src/modules/reducer.js`` and
``client/src/modules/projection-task-handlers.js``.

The browser and this server fold the identical domain events, so a faithful port
matters more than idiomatic Python: the same 19 handlers, the same camelCase
keys on the projection state, and the same HLC ordering on replay.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from .constants import is_done_column
from .util import is_number

logger = logging.getLogger("openagile.reducer")


def create_projection_state(seed: dict[str, Any] | None = None) -> dict[str, Any]:
    seed = seed or {}
    return {
        "boards": list(seed["boards"]) if isinstance(seed.get("boards"), list) else [],
        "tasks": list(seed["tasks"]) if isinstance(seed.get("tasks"), list) else [],
        "columns": list(seed["columns"]) if isinstance(seed.get("columns"), list) else [],
        "groups": list(seed["groups"]) if isinstance(seed.get("groups"), list) else [],
        "boardGroups": dict(seed["boardGroups"]) if isinstance(seed.get("boardGroups"), dict) else {},
        "skills": list(seed["skills"]) if isinstance(seed.get("skills"), list) else [],
        "settings": dict(seed["settings"]) if isinstance(seed.get("settings"), dict) else {},
        "appliedEventIds": set(seed["appliedEventIds"]) if isinstance(seed.get("appliedEventIds"), set) else set(),
        "taskTombstones": set(seed["taskTombstones"]) if isinstance(seed.get("taskTombstones"), set) else set(),
    }


def _clone_state(state: dict[str, Any]) -> dict[str, Any]:
    tasks: list[dict[str, Any]] = []
    for task in state["tasks"]:
        cloned = dict(task)
        if isinstance(task.get("relationships"), list):
            cloned["relationships"] = [dict(entry) for entry in task["relationships"]]
        if isinstance(task.get("columnHistory"), list):
            cloned["columnHistory"] = list(task["columnHistory"])
        tasks.append(cloned)
    return {
        **state,
        "boards": list(state["boards"]),
        "tasks": tasks,
        "columns": [dict(column) for column in state["columns"]],
        "groups": [dict(group) for group in state["groups"]],
        "boardGroups": dict(state["boardGroups"]),
        "skills": [dict(skill) for skill in state["skills"]],
        "settings": dict(state["settings"]),
        "appliedEventIds": set(state["appliedEventIds"]),
        "taskTombstones": set(state["taskTombstones"]),
    }


def _payload(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload")
    return payload if isinstance(payload, dict) else {}


def _fields(event: dict[str, Any]) -> dict[str, Any]:
    fields = _payload(event).get("fields")
    return fields if isinstance(fields, dict) else {}


def _entity(event: dict[str, Any]) -> Any:
    return event.get("entity_id")


def _update_task_by_id(
    state: dict[str, Any], task_id: Any, updater: Callable[[dict[str, Any]], dict[str, Any]]
) -> dict[str, Any]:
    if task_id in state["taskTombstones"]:
        return state
    return {
        **state,
        "tasks": [updater(task) if task.get("id") == task_id else task for task in state["tasks"]],
    }


def apply_relationship_added(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    relationship = _payload(event).get("relationship")
    if not isinstance(relationship, dict):
        return state

    def updater(task: dict[str, Any]) -> dict[str, Any]:
        relationships = task.get("relationships") if isinstance(task.get("relationships"), list) else []
        exists = any(
            entry.get("targetTaskId") == relationship.get("targetTaskId") and entry.get("type") == relationship.get("type")
            for entry in relationships
        )
        if exists:
            return task
        return {**task, "relationships": [*relationships, dict(relationship)]}

    return _update_task_by_id(state, _entity(event), updater)


def apply_relationship_removed(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    payload = _payload(event)
    target_task_id = payload.get("targetTaskId")
    relationship_type = payload.get("relationship_type")

    def updater(task: dict[str, Any]) -> dict[str, Any]:
        relationships = task.get("relationships") if isinstance(task.get("relationships"), list) else []
        return {
            **task,
            "relationships": [
                entry
                for entry in relationships
                if not (entry.get("targetTaskId") == target_task_id and entry.get("type") == relationship_type)
            ],
        }

    return _update_task_by_id(state, _entity(event), updater)


def apply_column_created(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if any(column.get("id") == _entity(event) for column in state["columns"]):
        return state
    payload = _payload(event)
    body = payload.get("column") if isinstance(payload.get("column"), dict) else payload.get("fields")
    return {**state, "columns": [*state["columns"], {"id": _entity(event), **(body or {})}]}


def apply_column_updated(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    fields = _fields(event)
    return {
        **state,
        "columns": [({**column, **fields} if column.get("id") == _entity(event) else column) for column in state["columns"]],
    }


def apply_board_created(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if any(board.get("id") == _entity(event) for board in state["boards"]):
        return state
    payload = _payload(event)
    body = payload.get("board") if isinstance(payload.get("board"), dict) else payload.get("fields")
    return {**state, "boards": [*state["boards"], {"id": _entity(event), **(body or {})}]}


def apply_board_updated(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    fields = _fields(event)
    return {
        **state,
        "boards": [({**board, **fields} if board.get("id") == _entity(event) else board) for board in state["boards"]],
    }


def apply_board_deleted(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    return {
        **state,
        "boards": [({**board, "deleted": True} if board.get("id") == _entity(event) else board) for board in state["boards"]],
    }


def apply_group_created(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if any(group.get("id") == _entity(event) for group in state["groups"]):
        return state
    payload = _payload(event)
    body = payload.get("group") if isinstance(payload.get("group"), dict) else payload.get("fields")
    return {**state, "groups": [*state["groups"], {"id": _entity(event), **(body or {})}]}


def apply_group_updated(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    fields = _fields(event)
    return {
        **state,
        "groups": [({**group, **fields} if group.get("id") == _entity(event) else group) for group in state["groups"]],
    }


def apply_group_deleted(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    return {
        **state,
        "groups": [({**group, "deleted": True} if group.get("id") == _entity(event) else group) for group in state["groups"]],
        "boardGroups": {
            board_id: (None if group_id == _entity(event) else group_id)
            for board_id, group_id in state["boardGroups"].items()
        },
    }


def apply_board_group_assigned(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    payload = _payload(event)
    if "group_id" not in payload:
        return state
    return {**state, "boardGroups": {**state["boardGroups"], _entity(event): payload.get("group_id")}}


def apply_skill_created(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if any(skill.get("id") == _entity(event) for skill in state["skills"]):
        return state
    payload = _payload(event)
    body = payload.get("skill") if isinstance(payload.get("skill"), dict) else payload.get("fields")
    return {**state, "skills": [*state["skills"], {"id": _entity(event), **(body or {})}]}


def apply_skill_updated(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    fields = _fields(event)
    return {
        **state,
        "skills": [({**skill, **fields} if skill.get("id") == _entity(event) else skill) for skill in state["skills"]],
    }


def apply_skill_deleted(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    return {
        **state,
        "skills": [({**skill, "deleted": True} if skill.get("id") == _entity(event) else skill) for skill in state["skills"]],
    }


def apply_settings_updated(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    fields = _fields(event)
    nxt = {**state["settings"], **fields}
    nxt.pop("columnSummaries", None)
    return {**state, "settings": nxt}


# ── Task sub-handlers (projection-task-handlers.js) ───────────────────────────


def apply_task_created(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if _entity(event) in state["taskTombstones"] or any(task.get("id") == _entity(event) for task in state["tasks"]):
        return state
    payload = _payload(event)
    body = payload.get("task") if isinstance(payload.get("task"), dict) else payload.get("fields")
    return {**state, "tasks": [*state["tasks"], {"id": _entity(event), **(body or {})}]}


def apply_task_updated(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if _entity(event) in state["taskTombstones"]:
        return state
    fields = _fields(event)
    return {
        **state,
        "tasks": [({**task, **fields} if task.get("id") == _entity(event) else task) for task in state["tasks"]],
    }


def apply_task_moved(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    if _entity(event) in state["taskTombstones"]:
        return state
    order = _payload(event).get("order")
    order = order if isinstance(order, list) else []
    order_by_task_id = {entry.get("id"): entry for entry in order if isinstance(entry, dict)}

    tasks: list[dict[str, Any]] = []
    for task in state["tasks"]:
        entry = order_by_task_id.get(task.get("id"))
        if entry is None:
            tasks.append(task)
            continue

        entry_order = entry.get("order")
        next_task = {
            **task,
            "column": entry.get("column") if isinstance(entry.get("column"), str) else task.get("column"),
            "order": entry_order if is_number(entry_order) else task.get("order"),
        }

        if task.get("id") == _entity(event) and task.get("column") != next_task.get("column"):
            history = (
                list(task["columnHistory"])
                if isinstance(task.get("columnHistory"), list) and task["columnHistory"]
                else [{"column": task.get("column"), "at": task.get("creationDate") or task.get("changeDate") or event.get("at")}]
            )
            history.append({"column": next_task.get("column"), "at": event.get("at")})
            next_task["columnHistory"] = history

            # Derive doneDate from the move so it replays from events alone (ADR-0005):
            # entering the done column stamps it, leaving clears it.
            was_done = is_done_column(_find_column(state["columns"], task.get("column")))
            is_done = is_done_column(_find_column(state["columns"], next_task.get("column")))
            if is_done and not was_done:
                next_task["doneDate"] = event.get("at")
            elif was_done and not is_done:
                next_task.pop("doneDate", None)

        tasks.append(next_task)

    return {**state, "tasks": tasks}


def apply_task_deleted(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    next_tombstones = set(state["taskTombstones"])
    next_tombstones.add(_entity(event))
    return {
        **state,
        "tasks": [task for task in state["tasks"] if task.get("id") != _entity(event)],
        "taskTombstones": next_tombstones,
    }


def _find_column(columns: list[dict[str, Any]], column_id: Any) -> dict[str, Any] | None:
    for column in columns:
        if column.get("id") == column_id:
            return column
    return None


_HANDLERS: dict[str, Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]] = {
    "task.created": apply_task_created,
    "task.updated": apply_task_updated,
    "task.moved": apply_task_moved,
    "task.deleted": apply_task_deleted,
    "relationship.added": apply_relationship_added,
    "relationship.removed": apply_relationship_removed,
    "column.created": apply_column_created,
    "column.updated": apply_column_updated,
    "board.created": apply_board_created,
    "board.updated": apply_board_updated,
    "board.deleted": apply_board_deleted,
    "group.created": apply_group_created,
    "group.updated": apply_group_updated,
    "group.deleted": apply_group_deleted,
    "board.group.assigned": apply_board_group_assigned,
    "skill.created": apply_skill_created,
    "skill.updated": apply_skill_updated,
    "skill.deleted": apply_skill_deleted,
    "settings.updated": apply_settings_updated,
}


def apply_event(state: dict[str, Any], event: dict[str, Any]) -> dict[str, Any]:
    event_id = event.get("id")
    if event_id in state["appliedEventIds"]:
        return state

    handler = _HANDLERS.get(event.get("type"))
    if handler is None:
        logger.warning("Unknown event type: %s", event.get("type"))
        return state

    nxt = handler(_clone_state(state), event)
    nxt["appliedEventIds"].add(event_id)
    return nxt


def apply_events(state: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    def sort_key(event: dict[str, Any]) -> tuple[float, float, str]:
        hlc = event.get("hlc") if isinstance(event.get("hlc"), dict) else {}
        wall = hlc.get("wallTime")
        counter = hlc.get("counter")
        node = hlc.get("nodeId")
        return (
            wall if is_number(wall) else 0,
            counter if is_number(counter) else 0,
            node if isinstance(node, str) else "",
        )

    ordered = sorted(events, key=sort_key)
    result = state
    for event in ordered:
        result = apply_event(result, event)
    return result
