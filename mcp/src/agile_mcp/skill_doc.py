"""Agent bootstrap document + companion JSON — port of
``harness/src/skill-doc.mjs``.

The static ``openagile.md`` / ``agent.json`` are shipped as package data and the
live group/iteration/column context is injected into the ``live-context`` marker.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from .constants import DEFAULT_BOARD_ID
from .store import DATA_DIR, get_boards, get_columns, get_groups

PROTOCOL_VERSION = 1
SKILL_VERSION = "1.0.0"
LIVE_CONTEXT_MARKER = "<!-- openagile:live-context -->"
DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:8787/mcp"

_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "skill")
_SKILL_FILE = os.path.join(_DATA_DIR, "openagile.md")
_AGENT_FILE = os.path.join(_DATA_DIR, "agent.json")


def _read_static_file(path: str, label: str) -> str:
    if not os.path.exists(path):
        raise FileNotFoundError(f"{label} is missing; expected {path}")
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _manifest_group_hint() -> str:
    try:
        with open(os.path.join(DATA_DIR, "manifest.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
        hint = manifest.get("group") if isinstance(manifest, dict) else None
        if hint is None and isinstance(manifest, dict):
            hint = manifest.get("defaultGroup")
        return hint.strip() if isinstance(hint, str) else ""
    except (OSError, ValueError):
        return ""


def _argv_group_hint() -> str:
    argv = sys.argv
    if "--group" in argv:
        index = argv.index("--group")
        if index + 1 < len(argv) and isinstance(argv[index + 1], str):
            return argv[index + 1].strip()
    for arg in argv:
        if isinstance(arg, str) and arg.startswith("--group="):
            return arg[len("--group="):].strip()
    return ""


def requested_group(selector: Any) -> dict[str, str]:
    query = selector.strip() if isinstance(selector, str) else ""
    if query:
        return {"value": query, "source": "group query parameter"}
    env = (os.environ.get("OPENAGILE_GROUP") or "").strip()
    if env:
        return {"value": env, "source": "OPENAGILE_GROUP"}
    flag = _argv_group_hint()
    if flag:
        return {"value": flag, "source": "--group"}
    manifest = _manifest_group_hint()
    if manifest:
        return {"value": manifest, "source": ".agileboard/manifest.json"}
    return {"value": "", "source": "default: the last group on the board"}


def _find_group(groups: list[dict[str, Any]], value: str) -> dict[str, Any] | None:
    if not value:
        return groups[-1] if groups else None
    for group in groups:
        if group.get("id") == value:
            return group
    for group in groups:
        if group.get("name") == value:
            return group
    for group in groups:
        if str(group.get("name") or "").lower() == value.lower():
            return group
    return None


def board_key_prefix(name: Any) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9 ]", " ", str(name or "")).strip()
    words = [word for word in re.split(r"\s+", cleaned) if word]
    letters = "".join(word[0] for word in words) if len(words) >= 2 else (words[0] if words else "BRD")[:3]
    return letters.upper()[:4] or "BRD"


def live_context(selector: Any) -> str:
    groups = get_groups()
    requested = requested_group(selector)
    value = requested["value"]
    source = requested["source"]
    group = _find_group(groups, value)

    if not group:
        available = (
            ", ".join(f'"{entry.get("name")}"' for entry in groups)
            if groups
            else "none yet — create the first one with create_group"
        )
        target = f'group "{value}"' if value else "any group"
        return "\n".join(
            [
                "## Your live context",
                "",
                f"> **NOTICE — no live context available.** The MCP could not resolve {target} (resolved from {source}).",
                f"> Available groups: {available}.",
                "> This is the generic bootstrap document; it contains no live board or column IDs.",
                "> Resolve the group first: call `list_groups`, then fetch `GET /skill/openagile.md?group=<name>` again.",
                "",
            ]
        )

    boards = [board for board in get_boards() if (board.get("groupId") or "") == group.get("id")]
    if boards:
        board_rows = "\n".join(
            f"| {board.get('name')} | `{board.get('id')}` | `{board_key_prefix(board.get('name'))}-1`, "
            f"`{board_key_prefix(board.get('name'))}-2`, … |"
            for board in boards
        )
    else:
        board_rows = "| _no iteration yet_ | — | create one with `create_board` |"
    column_rows = "\n".join(
        f"| {column.get('name')} | `{column.get('id')}` |"
        for column in get_columns(boards[0].get("id") if boards else DEFAULT_BOARD_ID)
    )
    all_boards = get_boards()
    first_board = all_boards[0] if all_boards else None

    return "\n".join(
        [
            "## Your live context",
            "",
            f"Resolved group: **{group.get('name')}** — id `{group.get('id')}` (resolved from {source}).",
            "",
            "Iterations (boards) in this group:",
            "",
            "| iteration | boardId | task keys |",
            "|---|---|---|",
            board_rows,
            "",
            "Fixed columns — identical ids and order on every board (`move_task` accepts the id or the name):",
            "",
            "| column | id |",
            "|---|---|",
            column_rows,
            "",
            (
                f"Always pass `boardId` explicitly; an omitted `boardId` falls back to "
                f"`{first_board.get('name')}` (`{first_board.get('id')}`), which may not be the iteration you mean."
                if first_board
                else "Always pass `boardId` explicitly; an omitted `boardId` falls back to the default board, which may not be the iteration you mean."
            ),
            "",
        ]
    )


def render_skill_doc(group: Any = "") -> str:
    base = _read_static_file(_SKILL_FILE, "skill/openagile.md")
    context = live_context(group)
    if LIVE_CONTEXT_MARKER in base:
        return base.replace(LIVE_CONTEXT_MARKER, context, 1)
    return f"{base.rstrip()}\n\n{context}"


def render_agent_json(origin: Any = "") -> dict[str, Any]:
    base = json.loads(_read_static_file(_AGENT_FILE, "skill/agent.json"))
    root = origin.rstrip("/") if isinstance(origin, str) else ""
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "skillVersion": SKILL_VERSION,
        "mcpEndpointHint": f"{root}/mcp" if root else (base.get("mcpEndpointHint") or DEFAULT_MCP_ENDPOINT),
        "docs": (
            {"skill": f"{root}/skill/openagile.md", "agent": f"{root}/skill/agent.json"}
            if root
            else base.get("docs")
        ),
    }
