"""Domain constants — port of ``client/src/modules/constants.js`` and the fixed
column / board seeds from ``harness/src/store.mjs``.

The reducer keys behaviour off these ids and roles, never the display names.
"""

from __future__ import annotations

from typing import Any

# Same stable id the browser seeds on first run, so both sides converge by id.
DEFAULT_BOARD_ID = "00000000-0000-4000-8000-000000000001"

LEGACY_DONE_COLUMN_ID = "done"
DONE_COLUMN_ROLE = "done"
DONE_COLUMN_ID = LEGACY_DONE_COLUMN_ID

STABLE_COLUMNS: list[dict[str, Any]] = [
    {"id": "00000000-0000-4000-8000-000000000030", "name": "Backlog", "color": "#3583ff", "order": 1},
    {"id": "00000000-0000-4000-8000-000000000034", "name": "Human In The Loop", "color": "#8b5cf6", "order": 2},
    {"id": "00000000-0000-4000-8000-000000000031", "name": "In Progress", "color": "#f59e0b", "order": 3},
    {"id": "00000000-0000-4000-8000-000000000032", "name": "Blocked", "color": "#ef4444", "order": 4},
    {"id": "00000000-0000-4000-8000-000000000033", "name": "Finished", "color": "#16a34a", "order": 5, "role": DONE_COLUMN_ROLE},
]

# Alias kept for parity with constants.js's FIXED_COLUMNS export.
FIXED_COLUMNS = STABLE_COLUMNS

BACKLOG_COLUMN_ID = STABLE_COLUMNS[0]["id"]
HUMAN_IN_THE_LOOP_COLUMN_ID = STABLE_COLUMNS[1]["id"]
IN_PROGRESS_COLUMN_ID = STABLE_COLUMNS[2]["id"]
BLOCKED_COLUMN_ID = STABLE_COLUMNS[3]["id"]
FINISHED_COLUMN_ID = STABLE_COLUMNS[4]["id"]


def is_done_column(column: Any) -> bool:
    """Port of ``isDoneColumn`` — role ``done`` or the legacy ``id === 'done'``."""
    if not isinstance(column, dict):
        return False
    return column.get("role") == DONE_COLUMN_ROLE or column.get("id") == LEGACY_DONE_COLUMN_ID
