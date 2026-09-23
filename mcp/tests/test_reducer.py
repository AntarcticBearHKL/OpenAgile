"""Reducer conformance vectors.

Each vector is a list of domain events and the projected read model it must
produce. The same vectors can be run through the JS reducer
(``client/src/modules/reducer.js``) and diffed against these expectations.

Run with::

    npx vitest run   # (or the harness test suite) over the same event lists
"""

from __future__ import annotations

from typing import Any

from agile_mcp.constants import (
    BACKLOG_COLUMN_ID,
    BLOCKED_COLUMN_ID,
    FINISHED_COLUMN_ID,
    IN_PROGRESS_COLUMN_ID,
    STABLE_COLUMNS,
)
from agile_mcp.reducer import apply_event, apply_events, create_projection_state

BOARD = "board-1"
OTHER_BOARD = "board-2"


def evt(type_: str, entity_id: str, *, board_id: str | None = BOARD, scope: str = "board", payload: dict[str, Any] | None = None, wall: int = 0, counter: int = 0, node: str = "n", eid: str | None = None) -> dict[str, Any]:
    return {
        "id": eid or f"{type_}:{entity_id}:{wall}:{counter}:{node}",
        "type": type_,
        "hlc": {"wallTime": wall, "counter": counter, "nodeId": node},
        "at": f"2026-01-01T00:00:{wall % 60:02d}.000Z",
        "scope": scope,
        "board_id": board_id if scope == "board" else None,
        "entity_id": entity_id,
        "payload": payload or {},
    }


def seed_board() -> dict[str, Any]:
    state = create_projection_state()
    events = [evt("board.created", BOARD, payload={"board": {"id": BOARD, "name": "Iteration 1"}})]
    events += [evt("column.created", column["id"], payload={"column": column}) for column in STABLE_COLUMNS]
    return apply_events(state, events)


def _task(task_id: str, **fields: Any) -> dict[str, Any]:
    return {"task": {"id": task_id, **fields}}


def test_create_projection_state_defaults() -> None:
    state = create_projection_state()
    assert state["boards"] == []
    assert state["tasks"] == []
    assert state["columns"] == []
    assert state["groups"] == []
    assert state["boardGroups"] == {}
    assert state["skills"] == []
    assert state["settings"] == {}
    assert state["appliedEventIds"] == set()
    assert state["taskTombstones"] == set()


def test_board_and_columns_project() -> None:
    state = seed_board()
    assert [board["id"] for board in state["boards"]] == [BOARD]
    assert [column["id"] for column in state["columns"]] == [column["id"] for column in STABLE_COLUMNS]
    assert state["columns"][4]["role"] == "done"


def test_column_created_is_deduped_by_entity_id() -> None:
    state = seed_board()
    again = apply_event(state, evt("column.created", STABLE_COLUMNS[0]["id"], payload={"column": STABLE_COLUMNS[0]}))
    assert len(again["columns"]) == 5


def test_task_created_and_updated() -> None:
    state = seed_board()
    state = apply_event(state, evt("task.created", "t1", payload=_task("t1", title="Do it", column=BACKLOG_COLUMN_ID, order=1)))
    assert state["tasks"][0]["title"] == "Do it"
    state = apply_event(state, evt("task.updated", "t1", payload={"fields": {"description": "folded", "changeDate": "2026-01-02T00:00:00.000Z"}}))
    assert state["tasks"][0]["description"] == "folded"
    assert state["tasks"][0]["title"] == "Do it"


def test_task_moved_applies_order_and_history_and_done_date() -> None:
    state = seed_board()
    state = apply_event(state, evt("task.created", "t1", payload=_task("t1", title="A", column=BACKLOG_COLUMN_ID, order=1, creationDate="2026-01-01T00:00:00.000Z")))
    state = apply_event(
        state,
        evt(
            "task.moved",
            "t1",
            payload={"order": [{"id": "t1", "column": FINISHED_COLUMN_ID, "order": 1}]},
            eid="move-1",
        ),
    )
    task = state["tasks"][0]
    assert task["column"] == FINISHED_COLUMN_ID
    assert task["doneDate"] == "2026-01-01T00:00:00.000Z"
    assert task["columnHistory"][0] == {"column": BACKLOG_COLUMN_ID, "at": "2026-01-01T00:00:00.000Z"}


def test_task_moved_out_of_done_clears_done_date() -> None:
    state = seed_board()
    state = apply_event(state, evt("task.created", "t1", payload=_task("t1", column=FINISHED_COLUMN_ID, order=1, doneDate="2026-01-01T00:00:00.000Z", columnHistory=[{"column": FINISHED_COLUMN_ID, "at": "2025-12-31T00:00:00.000Z"}])))
    state = apply_event(state, evt("task.moved", "t1", payload={"order": [{"id": "t1", "column": BACKLOG_COLUMN_ID, "order": 1}]}, eid="move-back"))
    assert "doneDate" not in state["tasks"][0]


def test_task_moved_reorders_siblings_it_names() -> None:
    state = seed_board()
    for task_id, order in (("a", 1), ("b", 2)):
        state = apply_event(state, evt("task.created", task_id, payload=_task(task_id, column=BACKLOG_COLUMN_ID, order=order)))
    state = apply_event(
        state,
        evt(
            "task.moved",
            "b",
            payload={"order": [{"id": "b", "column": BACKLOG_COLUMN_ID, "order": 1}, {"id": "a", "column": BACKLOG_COLUMN_ID, "order": 2}]},
            eid="swap",
        ),
    )
    orders = {task["id"]: task["order"] for task in state["tasks"]}
    assert orders == {"a": 2, "b": 1}


def test_task_deleted_is_a_hard_removal_with_tombstone() -> None:
    state = seed_board()
    state = apply_event(state, evt("task.created", "t1", payload=_task("t1", column=BACKLOG_COLUMN_ID)))
    state = apply_event(state, evt("task.deleted", "t1", eid="del-1"))
    assert state["tasks"] == []
    assert "t1" in state["taskTombstones"]
    # a later update for a tombstoned task is ignored
    after = apply_event(state, evt("task.updated", "t1", payload={"fields": {"title": "zombie"}}))
    assert after["tasks"] == []


def test_global_group_lifecycle() -> None:
    state = create_projection_state()
    state = apply_event(state, evt("group.created", "g1", scope="global", payload={"group": {"id": "g1", "name": "Alpha", "order": 1}}))
    state = apply_event(state, evt("group.updated", "g1", scope="global", payload={"fields": {"name": "Beta"}}))
    assert state["groups"][0]["name"] == "Beta"
    state = apply_event(state, evt("board.group.assigned", BOARD, scope="global", payload={"group_id": "g1"}))
    assert state["boardGroups"][BOARD] == "g1"
    state = apply_event(state, evt("group.deleted", "g1", scope="global"))
    assert state["groups"][0]["deleted"] is True
    assert state["boardGroups"][BOARD] is None


def test_board_group_assigned_requires_the_key() -> None:
    state = create_projection_state()
    unchanged = apply_event(state, evt("board.group.assigned", BOARD, scope="global", payload={}))
    assert unchanged["boardGroups"] == {}


def test_skill_lifecycle_and_settings_update() -> None:
    state = create_projection_state()
    state = apply_event(state, evt("skill.created", "s1", scope="global", payload={"skill": {"id": "s1", "name": "S", "order": 1}}))
    state = apply_event(state, evt("skill.updated", "s1", scope="global", payload={"fields": {"content": "body"}}))
    assert state["skills"][0]["content"] == "body"
    state = apply_event(state, evt("skill.deleted", "s1", scope="global"))
    assert state["skills"][0]["deleted"] is True

    board_state = seed_board()
    board_state = apply_event(board_state, evt("settings.updated", BOARD, payload={"fields": {"locale": "en", "columnSummaries": {"x": 1}}}))
    assert board_state["settings"] == {"locale": "en"}


def test_unknown_event_type_is_ignored() -> None:
    state = seed_board()
    assert apply_event(state, evt("label.created", "l1", payload={"label": {}}))["tasks"] == []


def test_apply_events_orders_by_hlc_then_counter_then_node() -> None:
    state = create_projection_state()
    later_wall = evt("board.created", BOARD, payload={"board": {"id": BOARD, "name": "Late"}}, wall=20)
    earlier_wall = evt("board.created", OTHER_BOARD, payload={"board": {"id": OTHER_BOARD, "name": "Early"}}, wall=10)
    # deliberately out of order; HLC decides the replay order
    state = apply_events(state, [later_wall, earlier_wall])
    assert [board["id"] for board in state["boards"]] == [OTHER_BOARD, BOARD]


def test_already_applied_event_is_not_applied_twice() -> None:
    state = seed_board()
    event = evt("task.created", "t1", payload=_task("t1", column=BACKLOG_COLUMN_ID), eid="once")
    state = apply_event(state, event)
    state = apply_event(state, event)
    assert len(state["tasks"]) == 1
