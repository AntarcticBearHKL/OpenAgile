# Data Models

## Board Model

```javascript
{
  id: "uuid",
  name: "Board Name",
  createdAt: "YYYY-MM-DDTHH:MM:SSZ"
}
```

## Task Model

```javascript
{
  id: "uuid",
  key: "BRD-1",
  title: "task title",
  description: "optional longer description",
  assignee: "agent or human name",
  keyPoints: [
    { id: "uuid", text: "note text", at: "YYYY-MM-DDTHH:MM:SSZ", digestedAt: "YYYY-MM-DDTHH:MM:SSZ" }
  ],
  needsDigest: boolean,
  isRework: boolean,
  claimedBy: "agent-id",
  claimedAt: "YYYY-MM-DDTHH:MM:SSZ",
  column: "column-uuid",
  order: number,
  creationDate: "YYYY-MM-DDTHH:MM:SSZ",
  changeDate: "YYYY-MM-DDTHH:MM:SSZ",
  doneDate: "YYYY-MM-DDTHH:MM:SSZ",
  blockedAt: "YYYY-MM-DDTHH:MM:SSZ" | null,
  blockedReason: "",
  columnHistory: [
    { column: "column-uuid", at: "YYYY-MM-DDTHH:MM:SSZ" }
  ],
  deleted: boolean
}
```

### Task Field Notes

- `title` is the only required field; a task needs only a title and a description to be created
- `keyPoints` are the notes to the agent (the human's input) and the agent may only read them: each entry is `{ id, text, at }`, `text` is required, and there is no done flag. `digestedAt` is stamped by `digest_key_points` once the agent folds the note into the description
- `needsDigest` is set when the human appends a note while the task is in Backlog or Human In The Loop, and cleared by `digest_key_points`; it means the agent must fold the notes into the description before starting work. Only `digest_key_points` clears it or stamps `digestedAt` — the browser event bridge refuses a client event that would do either while a note is pending
- `isRework` is set when the human appends a note to a Finished task; the task returns to Backlog, the move is emitted like any other move, and the agent must digest the new notes before redoing the work — digesting them clears the marker
- Legacy `acceptanceCriteria` arrays are read as notes to the agent: `text` is kept and the old `done` flags are dropped
- `assignee` is who the task is assigned to; `claim_task` sets it when empty, and `claimedBy`/`claimedAt` record the claim (releasing keeps `claimedAt` so the claim duration stays derivable)
- `creationDate` records when the task was created; it is never shown in the UI
- `changeDate` updates on task save; the five-minute claim watchdog measures from the later of `changeDate` and the time the task entered its current column, so entering In Progress restarts the window
- `doneDate` exists only while the task is in the Finished column
- `blockedAt`/`blockedReason` record why a task is blocked; leaving Blocked clears both
- `columnHistory` is appended when a task changes columns
- `key` is the per-board `PREFIX-N` identifier (the slimmed card does not render it)
- `deleted` marks internal tombstones/deleted records; normal read functions filter `deleted: true`
- The task carries no `priority`, `dueDate`, task `labels`, `subTasks`, `attachments`, `customFields`, `annotations`, `comments`, `relationships`, `type`, `estimate`, or `parentId`; older exported files that still carry them are read with those fields dropped on import
- The task no longer carries an inline `activityLog` — the audit-trail feature was removed (issue #110); mutation history now lives in the event stream (see [ADR-0004](../adr/0004-event-sourced-sync.md))

## Column Model

```javascript
{
  id: "uuid",
  name: "Column Name",
  color: "#hexcolor",
  role: "done" | "",
  collapsed: boolean,
  wipLimit: number,
  order: number,
  deleted: boolean
}
```

### Column Notes

- `collapsed` defaults to `false`; `wipLimit` defaults to `0` (unlimited) and is advisory only
- All column IDs are UUIDs
- The column with `role: "done"` is permanent and cannot be deleted
- Legacy imported or migrated column id `done` is remapped to a UUID-backed column with `role: "done"`
- `deleted` marks internal tombstones/deleted records

### Fixed Columns

The board always has exactly five columns — `Backlog`, `Human In The Loop`, `In Progress`, `Blocked`, `Finished` —
with fixed ids and order:

- Backlog holds work the agent proposed; the agent's queue
- Human In The Loop is the human's entry point and the only column where a human can add a task by hand
- In Progress is what an agent is actively working; tasks there are read-only
- Blocked is work an agent could not finish and that needs a human decision, or work stuck on a resource conflict
- Finished is completed work; it carries `role: "done"` and is the source for completion and cycle-time statistics

`name` is display-only: the fixed definitions are reimposed on every board at load time, so renaming
a fixed column's display label needs no data migration.

## Domain Event Model

> The standalone `ActivityLogEntry` model (inline task `activityLog` + board events) was **removed**
> with the audit-trail feature (issue #110). Mutations are now recorded as **domain events** in the
> event-sourced stream. See [ADR-0004](../adr/0004-event-sourced-sync.md) for the event schema,
> HLC ordering, and reducer.

## Settings Model

Board settings are stored per board and include timestamp visibility and locale.

Key persisted fields include:

- `showChangeDate`
- `locale`

