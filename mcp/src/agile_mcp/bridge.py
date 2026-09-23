"""Admission rules for the browser bridge — the client's ``POST /api/events``
channel into the same log the MCP tools write. The client keeps publishing its
legitimate events; a request is refused when it would reach a state the workflow
forbids, so the browser path and the MCP path enforce the same rules.

Origin exposure is rewritten for a statically hosted client: the Node harness
required loopback ``Host`` + ``Origin == Host`` + ``Sec-Fetch-Site: same-origin``,
which blocks a Cloudflare Pages page entirely. Here the request is accepted when
its ``Origin`` is in the ``OPENAGILE_ORIGINS`` allowlist, or when no ``Origin``
is present (a non-browser local client); the bearer token is validated by the
host middleware before this gate runs. All the workflow refusals are preserved
verbatim.
"""

from __future__ import annotations

from typing import Any

from .constants import IN_PROGRESS_COLUMN_ID
from .store import append_events, find_task, pending_notes, pending_notes_message


def bridge_request_denial(origin: Any, allowed_origins: list[str]) -> str | None:
    """Cross-origin admission: an allowlisted Origin, or none at all.

    Returns ``None`` when the request may proceed, otherwise the refusal message.
    """
    if isinstance(origin, str) and origin != "":
        if origin not in allowed_origins:
            return f"The event bridge refuses an origin that is not allowlisted (Origin: {origin})."
    return None


def _moved_column(event: dict[str, Any]) -> str:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    order = payload.get("order") if isinstance(payload.get("order"), list) else []
    entry = next((item for item in order if isinstance(item, dict) and item.get("id") == event.get("entity_id")), None)
    if entry and isinstance(entry.get("column"), str):
        return entry["column"]
    return payload.get("to_column") if isinstance(payload.get("to_column"), str) else ""


def _stamped_ids(task: Any) -> set[Any]:
    points = task.get("keyPoints") if isinstance(task, dict) and isinstance(task.get("keyPoints"), list) else []
    return {point.get("id") for point in points if isinstance(point, dict) and point.get("digestedAt")}


def _stamped_note_refusal(already_stamped: set[Any], incoming: Any, ref: Any) -> str | None:
    if not isinstance(incoming, list):
        return None
    for point in incoming:
        if not isinstance(point, dict) or not point.get("digestedAt"):
            continue
        if point.get("id") not in already_stamped:
            reference = (ref or {}).get("key") or (ref or {}).get("id") if isinstance(ref, dict) else None
            return (
                f"Task {reference}: notes are digested by the agent through digest_key_points, "
                "which folds them into the description first — the browser cannot stamp digestedAt."
            )
    return None


def _move_refusal(event: dict[str, Any]) -> str | None:
    if _moved_column(event) != IN_PROGRESS_COLUMN_ID:
        return None
    found = find_task(event.get("entity_id"))
    return pending_notes_message(found["task"]) if found else None


def _update_refusal(event: dict[str, Any]) -> str | None:
    found = find_task(event.get("entity_id"))
    if not found:
        return None
    task = found["task"]
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    fields = payload.get("fields")
    if not isinstance(fields, dict):
        return None

    ref = task.get("key") or task.get("id")
    if "column" in fields:
        return f"Task {ref}: a column change is a task.moved event — task.updated may not write the column field."
    if "claimedBy" in fields or "claimedAt" in fields:
        return f"Task {ref}: claims belong to the agent — claim_task is the only way to claim a task."

    note_refusal = _stamped_note_refusal(_stamped_ids(task), fields.get("keyPoints"), task)
    if note_refusal:
        return note_refusal

    if "keyPoints" in fields or "needsDigest" in fields:
        nxt = {**task, **fields}
        if nxt.get("needsDigest") is not True and len(pending_notes(nxt)) > 0:
            return (
                f"Task {ref}: the event would leave undigested notes with needsDigest cleared; "
                "only digest_key_points may clear the flag."
            )

    return None


def _create_refusal(event: dict[str, Any]) -> str | None:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    task = payload.get("task")
    if not isinstance(task, dict):
        return None

    note_refusal = _stamped_note_refusal(set(), task.get("keyPoints"), task)
    if note_refusal:
        return note_refusal

    ref = task.get("key") or task.get("id")
    if task.get("needsDigest") is not True and len(pending_notes(task)) > 0:
        return (
            f"Task {ref}: a task with undigested notes must carry needsDigest — "
            "only digest_key_points may clear the flag."
        )
    if task.get("column") == IN_PROGRESS_COLUMN_ID:
        return pending_notes_message(task)
    return None


def refused_message(event: dict[str, Any]) -> str | None:
    if event.get("type") == "task.moved":
        return _move_refusal(event)
    if event.get("type") == "task.updated":
        return _update_refusal(event)
    if event.get("type") == "task.created":
        return _create_refusal(event)
    return None


def append_bridge_events(batch: Any) -> list[dict[str, Any]]:
    events = batch if isinstance(batch, list) else [batch]
    for event in events:
        if not isinstance(event, dict) or not event.get("id") or not event.get("type"):
            continue
        message = refused_message(event)
        if message:
            raise ValueError(message)
    return append_events(events)
