# Tasks

## Create and Edit

- Tasks are created by agents through the API (`create_task`), which always lands in Backlog; a human adds a task by hand only through the Human In The Loop column's add control
- Agents can build a whole wave in one call with `create_tasks` (a board plus a list of items, each a title with an optional description): every item lands in Backlog and the result carries the created `id` and `key` per item. The batch validates every item before writing — one empty title or a missing board creates nothing — and emits one `task.created` event per task, not a batch event, because the reducer and the SSE stream project event by event
- Dialog creation always lands in Human In The Loop: the create dialog has no column picker
- Create and edit form fields, in one column: title (required, validated inline with red error styling), description, and the notes-to-the-agent list. The dialog shows nothing else
- The dialog is the whole task surface: the title, the description and the notes-to-the-agent list. The model has no priority, no due date, no task labels, no sub-tasks, no attachments and no custom fields
- The description belongs to the agent; the notes to the agent (field `keyPoints`) belong to the human and the agent may only read them
- Write access is keyed to the fixed column id, never the display name: only a task in Human In The Loop is fully editable. Outside Human In The Loop the agent's title and description render as read-only content, not form fields, and the notes list is the only editable part
- A task in In Progress is fully view-only — the whole form is locked while a subagent works it and the notes control is visibly unavailable, so a note cannot be added there
- Notes are appended one at a time in a single input: type a note, press Enter, the line joins the list and the input clears for the next note. A note can be removed before saving; a note is `{ id, text, at }` and has no done flag
- The notes list is the only human-to-agent channel in the dialog; the description is the agent's reply surface
- The edit modal shows the task key as read-only header context. It has no column chip and no claimant chip
- Edit mode opens with existing task values prefilled
- The edit modal includes a fullscreen action on larger screens and a dedicated close button

## Placement and Ordering

- New tasks are inserted at the top of Human In The Loop with `order = 1`
- The UI cannot move a task between columns: only the agent moves a card, through the MCP tools (`move_task`, `move_tasks`, `claim_next`)
- Storage keeps task ordering flattened per column

## Claim Timing and the Stale-Claim Watchdog

- `claim_task` is a hard lock: it is refused when another agent holds a live claim and the refusal names the holder. Re-claiming the same task as the same agent renews the claim (refreshes `claimedAt` and `changeDate`) instead of conflicting
- A claim whose last activity is older than the five-minute window is expired. `list_tasks` and `get_task` report `claimedBy`, `claimedAt`, `changeDate`, `blockedReason` and `claimExpired`, so an orchestrator can see who holds a task and whether the holder has gone quiet; `list_tasks` also filters by `claimedBy`, `needsDigest` and `ready`
- Claiming over an expired claim succeeds as a takeover and the result says `tookOver`; a live foreign claim is always refused. The watchdog never clears a claim — it only moves a stale In Progress task to Blocked
- `claim_next` picks and claims the next ready task for the calling agent in one step. Ready means in Backlog or Human In The Loop, notes digested, and unclaimed or expired-claimed; the deterministic order is Backlog before Human In The Loop, then ascending task `order`, then task id
- A waiter does not poll `list_events`: `wait_for_event` takes the last `seq` the caller has seen and resolves when a later event is appended, optionally filtered by `type` or `boardId`, so a worker can wait for change on its own board. No matching event within the bounded `timeoutMs` (ceiling 30000 ms) resolves cleanly with `timedOut: true`; the append listener is registered per call and removed when the wait settles, so repeated waits leave nothing behind
- A claim (`claim_task`) starts a five-minute sync window; any update that bumps `changeDate` (a description edit, a digest, a re-claim, or `heartbeat_task`) restarts it, and so does entering In Progress: the sweep measures from the later of `changeDate` and the time the task entered its current column (`columnHistory`), so a move can never leave a just-started task looking stuck
- `heartbeat_task` is the low-cost sync for an agent that is still working but has nothing to change: it writes only `changeDate` and leaves the description, the notes, the digests, the column and every other field untouched. It is allowed only for a claimed task in In Progress — the only state the watchdog measures — and refused everywhere else
- The harness sweeps every 30 seconds and moves a claimed In Progress task whose last sync is older than five minutes to Blocked, exactly as an agent move does: it emits `task.moved` with the column ordering (recorded in `columnHistory`) and a `task.updated` that carries the blocked fields
- The server sets `blockedAt` and `blockedReason` to `Auto-blocked: no agent sync for over 5 minutes.`
- The sweep keys off the fixed In Progress and Blocked column ids, never column names, and only touches tasks that carry a claim marker (`claimedBy` or `claimedAt`); unclaimed, fresh, and already-blocked tasks are left alone
- An agent that moves the card to Finished or Blocked itself stops the clock before the watchdog ever sees the task
- The threshold is `CLAIM_STALE_MS` (five minutes) in `harness/src/store.mjs`; the interval is 30 seconds, started once at server boot

## Card Display

- A task card shows exactly what the task is: title, description preview, and the notes-to-the-agent list (field `keyPoints`), stacked vertically. The card conveys no other status than the column it sits in — the key/code, claimant, elapsed timer, notes indicator and blocked badge were removed
- Two markers stay because someone must act on them: `needsDigest` (the human changed the task and the agent has not folded the note into the description) and `isRework` (the task came back from Finished). They render only in Backlog, Blocked and Finished — keyed to the fixed column ids — as a coloured pill that also carries a lucide icon and its label text, so the meaning survives colour-blindness and holds up in both themes. They are not decoration
- Clicking anywhere on a task card opens the edit modal, except the delete button which triggers deletion
- Titles are clamped to one line and descriptions to a short preview
- URLs (`http://` or `https://`) in the description are rendered as clickable `<a>` links that open in a new tab (`target="_blank" rel="noopener noreferrer"`); clicking a link does not open the edit modal. Plain-text editing in the modal is unchanged — linkification is display-only on the card.
- In the task modal (add and edit), a live link preview strip appears below the description textarea whenever one or more `http://`/`https://` URLs are detected. Each unique URL renders as a clickable chip that opens in a new tab. The strip updates on every keystroke/paste and hides itself when no URLs are present. Existing URLs are shown immediately when the edit modal opens.

## Notes to the Agent and the Digest Workflow

- A note (field `keyPoints`) is `{ id, text, at }`; `text` is required and `at` is the timestamp the human added it. There is no done flag
- Notes are human-authored: the task tools and the agent surface expose them read-only. The agent must not add, edit or delete them
- Appending a note while the task is in Backlog, Human In The Loop or Blocked sets `needsDigest` on the task: the agent must fold the notes into the description before starting work
- While a task has undigested notes the agent must not start it: `claim_task` and a `move_task` into In Progress are refused with a message telling the agent to run `digest_key_points` first. Moving a task to any other column is unaffected
- The batch move runs the same digest gate over the whole batch: `move_tasks` (a list of task ids plus one target column) refuses the entire batch and appends nothing when any task does not exist, the column is not one of the five, or one of the tasks would enter In Progress with undigested notes; the error names the offending item
- The same gate holds on the browser event bridge: `POST /api/events` refuses, with `422` and the refusal message in the JSON body, a client `task.moved` whose target is In Progress while the task has `needsDigest` or an undigested note, a `task.updated` or `task.created` that would stamp `digestedAt` on a note the agent has not digested or clear `needsDigest` while a note is still pending, a `task.updated` that writes `column` (a move is a `task.moved`), and a `task.updated` that writes `claimedBy`/`claimedAt` (a claim is `claim_task`). A refused request appends nothing; if one event of a batch is refused, the whole batch is
- The bridge accepts local requests only: a loopback remote address, a loopback `Host`, a same-origin `Origin` when one is present, and `Sec-Fetch-Site: same-origin` when the browser sends it. It has no token, so it does not stop a local process from posting; the MCP tools remain the agent's path
- Appending a note to a task in Finished moves the task back to Backlog, sets `isRework`, and emits the move exactly like a normal move (`task.moved` with the full column ordering plus a `task.updated` with the flag), so history and the projector stay consistent
- The agent digests notes through `digest_key_points` (MCP): each digested note gets `digestedAt` and the task's `needsDigest` is cleared. It is the only way to clear the flag — no other task tool or browser event can. Omitting note ids stamps every undigested note; an already-stamped note keeps its original stamp. Digesting also clears `isRework`: the agent has taken the rework on
- `needsDigest` and `isRework` are ordinary task fields: they ride `task.updated` events and survive reload, snapshot hydration and event replay
- Legacy `acceptanceCriteria` arrays are read as notes, keeping `text` and dropping the old `done` flags; older exports and stored tasks import without error

## Comments

- There is no comment thread in the dialog: the notes list is the only human-to-agent channel and the description is the agent's reply surface

## Relationships

- Task relationships are not part of the product: there is no relationship search in the dialog and no relationship indicator on the card

## Task Deletion

### Confirmation

Clicking the delete button on a task card always shows a confirmation dialog before any action is
taken.

- Dialog title: "Delete task?"
- Dialog message: "This will permanently delete the task. There is no undo."
- Confirm button: "Delete"

### Permanent delete

- The task is immediately and irreversibly removed from local storage (IndexedDB).
- A `task.deleted` domain event is emitted before the task is removed.
- The event-sourced reducer records a tombstone so later stale events cannot resurrect the task.

## Task List Size Controls

- A column's task list scrolls independently when it overflows
- The Finished column virtualizes large lists: the first 50 completed tasks render, then a "Show more (N remaining)" button grows the batch by 50

## Update Requirements

Update this file when you change:

- task fields or validation
- task card layout or meta rules
- task ordering or card movement
- task modal fields or notes-list UX
- the notes-to-the-agent digest workflow (`needsDigest`, `isRework`, `digestedAt`)
- deletion confirmation wording or event propagation
- claim timing rules or the stale-claim watchdog
