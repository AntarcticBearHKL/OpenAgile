"""Store + tool behaviour: the ported domain logic against the 42 tools."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from agile_mcp import store
from agile_mcp.bridge import append_bridge_events
from agile_mcp.tools import call_tool

store.init_store()


def call(name: str, args: dict[str, Any] | None = None) -> Any:
    return asyncio.run(call_tool(name, args or {}))


def value(name: str, args: dict[str, Any] | None = None) -> Any:
    result = call(name, args)
    assert result.is_error is not True, result.content[0].text
    return json.loads(result.content[0].text)


def error_text(name: str, args: dict[str, Any] | None = None) -> str:
    result = call(name, args)
    assert result.is_error is True, "expected a tool error"
    return result.content[0].text


def _create_task(title: str, **extra: Any) -> dict[str, Any]:
    return value("create_task", {"title": title, **extra})


def test_default_board_has_the_five_fixed_columns() -> None:
    board = value("get_board", {"boardId": store.DEFAULT_BOARD_ID})
    assert [column["name"] for column in board["columns"]] == [
        "Backlog",
        "Human In The Loop",
        "In Progress",
        "Blocked",
        "Finished",
    ]
    assert board["columns"][4]["role"] == "done"


def test_snapshot_shape_and_columns() -> None:
    snapshot = value("get_board_snapshot", {"boardId": store.DEFAULT_BOARD_ID})
    assert set(snapshot.keys()) == {"seq", "boardId", "state"}
    assert set(snapshot["state"].keys()) == {"boards", "tasks", "columns", "settings"}
    assert len(snapshot["state"]["columns"]) == 5


def test_group_board_and_task_flow() -> None:
    group = value("create_group", {"name": "Py Port Group"})
    board = value("create_board", {"groupId": group["id"]})
    assert board["name"] == "Iteration 1"
    assert board["groupId"] == group["id"]

    created = _create_task("Port a task", boardId=board["id"], description="body")
    assert created["column"] == "00000000-0000-4000-8000-000000000030"
    assert created["key"].startswith("I1-")

    listed = value("list_tasks", {"boardId": board["id"], "search": "Port a task"})
    assert [task["id"] for task in listed] == [created["id"]]
    assert listed[0]["keyPoints"] == []


def test_rename_group_publishes_and_rename_board_refuses() -> None:
    group = value("create_group", {"name": "Before"})
    renamed = value("rename_group", {"groupId": group["id"], "name": "  After  "})
    assert renamed["name"] == "After"
    assert error_text("rename_group", {"groupId": "nope", "name": "x"}).startswith("Group not found")

    board = value("create_board", {"groupId": group["id"]})
    assert "cannot be renamed" in error_text("rename_board", {"boardId": board["id"], "name": "Nope"})


def test_digest_gate_blocks_claim_and_move_into_in_progress() -> None:
    board = value("create_board", {"groupId": value("create_group", {"name": "Digest Gate"})["id"]})
    task_id = "digest-task-1"
    store.append_events(
        [
            {
                "id": "digest-create-1",
                "type": "task.created",
                "hlc": {"wallTime": 1, "counter": 0, "nodeId": "n"},
                "at": "2026-01-01T00:00:00.000Z",
                "scope": "board",
                "board_id": board["id"],
                "entity_id": task_id,
                "payload": {"task": {"id": task_id, "title": "Guarded", "column": "00000000-0000-4000-8000-000000000030", "order": 1, "keyPoints": [{"id": "kp1", "text": "fold me"}], "needsDigest": True}},
            }
        ]
    )
    assert "digest_key_points" in error_text("claim_task", {"taskId": task_id})
    assert "digest_key_points" in error_text("move_task", {"taskId": task_id, "column": "00000000-0000-4000-8000-000000000031"})

    digested = value("digest_key_points", {"taskId": task_id, "pointIds": ["kp1"]})
    assert digested["digested"] == ["kp1"]
    assert value("claim_task", {"taskId": task_id, "agent": "agent-a"})["claimedBy"] == "agent-a"


def test_live_claim_refuses_another_agent_and_is_named() -> None:
    created = _create_task("Locked task")
    value("claim_task", {"taskId": created["id"], "agent": "agent-a"})
    message = error_text("claim_task", {"taskId": created["id"], "agent": "agent-b"})
    assert "agent-a" in message
    assert "still live" in message


def test_move_into_in_progress_auto_claims_the_caller() -> None:
    created = _create_task("Auto claim task")
    moved = value("move_task", {"taskId": created["id"], "column": "In Progress", "agent": "agent-z"})
    assert moved["columnName"] == "In Progress"
    task = value("get_task", {"taskId": created["id"]})["task"]
    assert task["claimedBy"] == "agent-z"
    assert task["claimedAt"] == task["changeDate"]


def test_done_date_is_derived_from_the_move() -> None:
    created = _create_task("Finish me")
    value("move_task", {"taskId": created["id"], "column": "Finished"})
    task = value("get_task", {"taskId": created["id"]})["task"]
    assert task["column"] == "00000000-0000-4000-8000-000000000033"
    assert task["doneDate"]


def test_delete_finished_task_is_refused_and_others_succeed() -> None:
    finished = _create_task("Keep me")
    value("move_task", {"taskId": finished["id"], "column": "Finished"})
    assert "cannot be deleted" in error_text("delete_task", {"taskId": finished["id"]})

    scratch = _create_task("Scratch")
    assert value("delete_task", {"taskId": scratch["id"]})["deleted"] == scratch["id"]
    assert store.find_task(scratch["id"]) is None


def test_create_tasks_batch_is_all_or_nothing_and_idempotent() -> None:
    board = value("create_board", {"groupId": value("create_group", {"name": "Batch Group"})["id"]})
    before = len(store.get_tasks(board["id"]))
    assert "title is required" in error_text("create_tasks", {"boardId": board["id"], "tasks": [{"title": "ok"}, {"title": "  "}]})
    assert len(store.get_tasks(board["id"])) == before

    created = value("create_tasks", {"boardId": board["id"], "tasks": [{"title": "One", "idempotencyKey": "batch-key"}, {"title": "Two"}]})
    assert created["created"] == 2
    retry = value("create_tasks", {"boardId": board["id"], "tasks": [{"title": "other", "idempotencyKey": "batch-key"}]})
    assert retry["skipped"] == 1
    assert retry["results"][0]["id"] == created["results"][0]["id"]


def test_reserve_task_key_number_is_monotonic() -> None:
    assert store.reserve_task_key_number("key-board", 100) == 101
    assert store.reserve_task_key_number("key-board", 100) == 102
    assert store.reserve_task_key_number("key-board", 500) == 501
    assert store.reserve_task_key_number("key-board", 10) == 502


def test_bridge_refusals_match_the_mcp_gate() -> None:
    board = value("create_board", {"groupId": value("create_group", {"name": "Bridge Group"})["id"]})
    task_id = "bridge-task-1"
    store.append_events(
        [
            {
                "id": "bridge-create-1",
                "type": "task.created",
                "hlc": {"wallTime": 2, "counter": 0, "nodeId": "n"},
                "at": "2026-01-01T00:00:00.000Z",
                "scope": "board",
                "board_id": board["id"],
                "entity_id": task_id,
                "payload": {"task": {"id": task_id, "title": "Bridge", "column": "00000000-0000-4000-8000-000000000030", "order": 1, "keyPoints": [{"id": "kp-open", "text": "still open"}], "needsDigest": True}},
            }
        ]
    )

    def bridge_event(type_: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": f"{type_}-{payload}",
            "type": type_,
            "hlc": {"wallTime": 3, "counter": 0, "nodeId": "n"},
            "at": "2026-01-01T00:00:03.000Z",
            "scope": "board",
            "board_id": board["id"],
            "entity_id": task_id,
            "payload": payload,
        }

    with pytest.raises(ValueError, match="task.moved"):
        append_bridge_events([bridge_event("task.updated", {"fields": {"column": "00000000-0000-4000-8000-000000000031"}})])
    with pytest.raises(ValueError, match="claim_task"):
        append_bridge_events([bridge_event("task.updated", {"fields": {"claimedBy": "forged"}})])
    with pytest.raises(ValueError, match="digest_key_points"):
        append_bridge_events([bridge_event("task.updated", {"fields": {"needsDigest": False}})])

    task = store.find_task(task_id)["task"]
    assert task["needsDigest"] is True
    assert task.get("claimedBy") is None


def test_wait_for_event_resolves_and_times_out() -> None:
    since = store.get_seq()
    store.emit("task.updated", board_id=store.DEFAULT_BOARD_ID, entity_id="waiter", payload={"fields": {}})
    immediate = value("wait_for_event", {"since": since, "timeoutMs": 50})
    assert immediate["timedOut"] is False
    assert immediate["seq"] == since + 1

    current = store.get_seq()
    timed_out = value("wait_for_event", {"since": current, "timeoutMs": 30, "type": "task.created", "boardId": "no-board"})
    assert timed_out == {"timedOut": True, "seq": current, "since": current}
    assert store.get_event_listener_count() == 0


def test_list_roadmap_reports_one_active_iteration() -> None:
    roadmap = value("list_roadmap", {})
    active = [row for row in roadmap if row["isActive"]]
    assert len(active) == 1


def test_compaction_archives_and_trims() -> None:
    before = store.get_archive_info()["archivedCount"]
    store.emit("task.updated", board_id=store.DEFAULT_BOARD_ID, entity_id="compact", payload={"fields": {}})
    result = store.compact_events()
    if result["compacted"]:
        assert result["archived"] > before
        assert store.get_events_since(0) == []


def test_skills_lifecycle() -> None:
    skill = value("create_skill", {"name": "Py Skill", "description": "d", "content": "c"})
    assert value("get_skill", {"skill": "Py Skill"})["id"] == skill["id"]
    updated = value("update_skill", {"skillId": skill["id"], "content": "c2"})
    assert updated["content"] == "c2"
    assert value("delete_skill", {"skillId": skill["id"]})["deleted"] == skill["id"]
    assert "Skill not found" in error_text("get_skill", {"skill": skill["id"]})


def test_stub_tools_are_rejected() -> None:
    for name, args in (
        ("create_column", {"name": "X"}),
        ("delete_column", {"columnId": "x"}),
        ("reorder_columns", {"order": []}),
        ("rename_board", {"boardId": "x"}),
    ):
        assert call(name, args).is_error is True


def test_settings_round_trip() -> None:
    value("update_settings", {"boardId": store.DEFAULT_BOARD_ID, "fields": {"locale": "zh"}})
    assert value("get_settings", {"boardId": store.DEFAULT_BOARD_ID})["locale"] == "zh"
