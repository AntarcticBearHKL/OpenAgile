# Columns

## Fixed Columns

The board always has exactly five fixed columns, in this order:

| Column | Semantics |
|---|---|
| Backlog | Work the agent has proposed; the agent's queue |
| Human In The Loop | The human's entry point and the only column where a human can add a task by hand |
| In Progress | What an agent is actively working; tasks are read-only there |
| Blocked | Work an agent could not finish and that needs a human decision, or work stuck on a resource conflict |
| Finished | Completed work; carries the done-column `role` |

- The fixed definitions (id, name, order, role) are reimposed on every board at load, so an existing board gains Human In The Loop without losing its columns or tasks; `name` is display-only and behaviour keys off the fixed ids, never the display name
- Human In The Loop has the fixed id `00000000-0000-4000-8000-000000000034` and order 2
- Task-dialog write access is keyed to the fixed column id: Human In The Loop is the only fully editable column; Backlog, Blocked and Finished keep the agent's title and description read-only and let the human edit only the notes list; In Progress is fully view-only. A task with undigested notes is refused as a start (`claim_task`, a move into In Progress) until `digest_key_points` clears the flag; the browser event bridge (`POST /api/events`) refuses the same move, and the batch `move_tasks` refuses the whole batch when any task fails the gate
- The Finished column keeps `role: "done"` and the fixed id `00000000-0000-4000-8000-000000000033`
- A claimed task that sits in In Progress with no update for five minutes is moved to Blocked by the server watchdog, with the reason recorded on the task (see [tasks.md](tasks.md))

## Column UI

- Columns are fixed: the board has no add, edit, delete, or reorder controls for columns, and the column tools reject create/delete/reorder
- Each column header shows the column name
- The Human In The Loop column additionally renders an add-task control in its board header; no other column has one
- A long task list scrolls within its column; the Finished column adds a "Show more (N remaining)" control when its list exceeds the virtualization batch

## WIP Limits

- Each column stores an advisory `wipLimit`; `0` means unlimited (the default)
- WIP limits are never enforced: nothing blocks adding, importing, or syncing a task into a column at or over its limit

## Color Behavior

- Each column has a hex color; the stored color is reapplied at load and the column accent is reused by task cards in that column
- Colors are set through the column tools; the board UI does not expose column color editing

## Finished Column Rules

- The column with `role: "done"` is permanent and cannot be deleted
- Appending a note to a task in Finished returns it to Backlog as rework (see [tasks.md](tasks.md))
