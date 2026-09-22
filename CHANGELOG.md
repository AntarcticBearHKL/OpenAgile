# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A cold-start agent skill, so a freshly installed agent can find out how to work this board without being told: the built web app serves a static `skill/openagile.md` bootstrap document plus a machine-readable `skill/agent.json` (`protocolVersion` 1), and the local MCP serves the same document contextualised with the live group, iteration, board and fixed-column ids at `GET /skill/openagile.md?group=<name>`.
- Task cards show who claimed the task and how long it has been running, counted from the claim rather than from the card being created.
- A server-side watchdog that moves a claimed task from In Progress to Blocked when the agent has not synced for five minutes, with the reason recorded on the card. Any update to the task restarts the window, and moving the card to Finished or Blocked yourself stops the clock before the watchdog ever sees it.
- The HIL column can add a task by hand, in the board and swim lane views, so a human can capture work before an agent picks it up. No other column offers an add control.
- Settings can link a local `.agileboard/` folder: while linked, this browser appends its domain events to its own shard in the folder and merges the shards the MCP and other writers appended, with a one-line status readout (folder, pending events, last merged event, errors) and a manual sync action. The control is always visible; on browsers without the File System Access API it stays disabled and explains that automatic sync needs desktop Chrome or Edge.
- A project-agnostic supervisor (`supervisor/`) for driving the board with short-lived worker processes. It owns the claim and heartbeats for the whole time a task is in flight, runs a configured worker command as a child process with the task context in `OPENAGILE_*` environment variables, folds the worker's stdout into the description, and moves the task to Finished — or to Blocked with a reason when the worker fails, times out, or exits successfully without a report that can be verified. It keeps its own append-only JSONL journal as the durable audit trail, idempotency map and persisted lease table, because `list_events` is truncated by compaction; it reconciles the tasks it held on startup, so a crashed supervisor never leaves a task stranded In Progress and unclaimed; it schedules Human In The Loop ahead of Backlog rather than using `claim_next`'s ordering, which prefers agent-proposed work to the human's; and it can create its own group and iteration from `groupName` / `groupId` with `createBoardIfMissing`, so onboarding a new repository needs nothing but a config file. The only project-specific inputs are the board, the agent name and the worker command.

### Changed

- The built client is origin-agnostic: every `/api/*` call resolves through one optional local-service base URL (`window.__OPENAGILE__`, an `openagile-api-base` meta tag, or `localStorage`), and the static agent skill links itself relatively, so `client/dist` can be hosted at a domain root or any sub-path with no backend and no rebuild.
- Deleting a board group now deletes the iterations inside it, instead of ungrouping them at the root. The group's delete button says how many iterations it will take with it.
- Clicking a group name in the sidebar now collapses or expands that group, the same as its chevron. Double-clicking the name still renames it.
- Iteration rows in the sidebar are indented consistently under their group, so the parent/child hierarchy reads clearly.
- The fourth board column is now called Finished instead of Archived. Its id and its done-column role are unchanged, so existing boards rename themselves on load.
- The In-Progress read-only lock and the Blocked-column detection now key off the fixed column ids instead of the column name, which is what makes the rename safe.
- The skills the board ships are now written in Chinese, and they document the claim-timing contract: a claim starts the clock, any task update restarts the five-minute window, and the agent is expected to move the card to Finished or Blocked itself.
- The skills and the documentation describe the slimmed task model instead of the old fields, so an agent that reads them is no longer told to use a priority, a due date, a label or a sub-task.
- The Backlog add-task row is now a neutral surface with a solid hairline, and the column controls around it were unified. A dashed border means "placeholder or drop target" everywhere else in this interface, which is what made that button read as a drop zone.
- The Backlog add-task control moved out of the column footer and into the column header, using the same icon button the swimlane view already used. The same action used to be two different controls in two different places; now it is one, and the column header and footer controls share a single surface, border, radius, spacing and state language.
- The dialog action area paints nothing of its own any more: the footer is neither filled nor blurred, and only the hairline above the actions remains. A translucent fill double-stacked over the dialog and brightened it, while the backdrop blur pulled the lighter page in from outside the dialog edge, which is why a white sheet kept appearing behind the buttons.
- The board canvas no longer paints a dot grid; it is plain paper now. The two dot tokens went with it.
- The board has five fixed columns now, with HIL (Human In The Loop) second, and HIL is the only column where a task can be added by hand - Backlog is for work an agent proposes.
- Acceptance criteria became key points: an append-only list the human writes, with no done flag. The description belongs to the agent and the key points belong to the human, and appending one sets needsDigest so the agent folds it into the description before starting; adding one to a finished task sends it back to Backlog marked as rework.
- Task cards show one column of content: title, description and key points.
- The task dialog is one column now and shows only the title, the description and the list of notes to the agent. The status chip, the type and estimate fields, the comment thread and the relationship search are gone from it.
- Corrected the naming rule the wrong way round: a group is named by the user and stays renameable, while an iteration is a board inside a group that is numbered in order and cannot be named by hand.
- Every row in the header controls menu now sits on one shared box: the same height, the same left and right padding, one radius and even gaps. The Swim Lanes row was a content-box label, so it overflowed the menu and pushed its toggle past every other row's right edge, and its divider and extra margin made the gaps uneven.
- The top-right controls menu and its phone full-screen drawer were retired, and its two remaining actions became direct icon buttons in the app bar: the light/dark theme toggle and the Settings button. Swim Lanes, the board dropdown, Manage Boards and Labels had already left the menu, so two rows were all that remained and neither needed a menu to hold it; the theme still persists and Settings still opens the same modal.
- The agent skill no longer says that groups and skills are out-of-band and absent from the event log: they are event-sourced (`group.*`, `skill.*` and `board.group.assigned` at global scope) and do appear in `list_events`. It also states the real tool count, measured against the running harness, and lists the removed label tools in its stale-tool-cache warning.
- The agent skill documents the new lock, auto-claim, `expectedSeq`, `idempotencyKey`, `undigest_key_points`, watchdog-reason and archive semantics, and corrects the two statements the fixes below invalidated: task keys are no longer reused, and compaction no longer loses history outright.
- `AGENTS.md` no longer lists acceptance criteria and comments among the test coverage areas; neither field exists in the task model any more.
- The project is renamed from `kanvana` to **OpenAgile** throughout: repository references, documentation, the deployment example paths, and the Content-Security-Policy `connect-src`, which no longer allow-lists the removed backend host. The local checkout directory name is unchanged.
- The project is released under the **MIT License**, replacing the previous O'Saasy terms. The `license` field in `client/package.json` and `harness/package.json` follows, and both READMEs point at the new licence.

### Removed

- The Labels feature, which had outlived its last consumer: the board-level registry, the `labels.js` / `labels-modal.js` / `label-edit-modal.js` modules, the Manage Labels and label-editor modals, `components/labels.css`, the `label.created` / `label.updated` / `label.deleted` events and their reducer handling, the `{boardId}:labels` read-model key, the default label scaffolding, the snapshot/sync/import/export plumbing, and the `list_labels` / `create_label` / `update_label` / `delete_label` MCP tools. Tasks never carried a label list and the swimlane grouping that read them had already been removed, so labels maintained data nothing displayed; legacy stored label data is dropped rather than honoured.
- The Swim Lanes view and its grouping settings, with the header toggle, the Settings section and the renderer behind it. The board is always the plain column view now, and legacy lane settings and task lane fields are dropped on import rather than honoured.
- The board dropdown in the header. Switching boards was already covered by the sidebar and by the Manage Boards modal (`Ctrl+B`), which lists every board with an Open button, so the header select was a duplicate control that rendered as an empty row in the menu.
- The Template picker in the New Iteration / Create New Board dialog and the built-in board templates it offered. New boards and iterations are always created blank now.
- Adding tasks by hand from every column except HIL. Tasks are created by agents through the API; the Backlog, In Progress, Blocked and Finished columns no longer offer an Add task row (board and swimlane view).
- The notifications feature: the top-right notification control, its dialog and the supporting code, styles and storage.
- The in-app Help modal and the standalone Roadmap and Legal/Impressum pages, with their three header menu entries, so the app builds from a single HTML entry point again. The roadmap data itself is untouched: iteration start/end dates, goals, `set_board_dates` and the MCP `list_roadmap` tool all remain - only the page that rendered them is gone.
- The Manage Boards entry in the controls menu. The modal and its `Ctrl+B` shortcut still work, so creating, opening, exporting, importing, deleting and editing iterations are all unchanged - only the toolbar button is gone.
- The stale prebuilt output directory at the repository root. The build has written to client/dist for a long time, and the old directory still carried code for features that no longer exist.
- The optional PocketBase cloud backend and everything that existed to serve it: the `backend/` image, hooks and migrations; the `devops/` nginx and container files; the root `Dockerfile`, both `docker-compose` files, `.dockerignore` and `.env.example`; and `docs/spec/backend-storage-pb.md`.
- Online mode in the client: `sync.js`, `authsync.js`, the PocketBase realtime subscription, the outbound push queue, the snapshot uploader, the sync indicator, the login and session UI with its styles, the `pocketbase` dependency, and the tests that only covered them. The app is purely local now — IndexedDB plus the optional `.agileboard/` folder sync, which is untouched.
- The fork's upstream scaffolding and generated artifacts: the `agents/` contributor notes, `.github/copilot-instructions.md` and the pull-request template, `CODE_OF_CONDUCT.md`, the `graphify-out/` analysis output, `.playwright/`, the historical `docs/temp/`, `docs/plans/` and root `plans/`, the orphaned `docs/example-boards/` templates, and `msw`, which only existed to mock the removed backend.
- The consolidated refactor-findings audit document. Its actionable items were either already applied or belonged to a refactor that was not taken on, so keeping a stale copy would have been misleading.

### Fixed

- The buttons at the bottom of every dialog sat on a white bar. The footer was applying the modal's own translucent glass colour on top of the modal, which composited to almost opaque white; it is now transparent, so the footer matches the dialog and the sticky blur still frosts content scrolling behind it.
- Task keys were reused after a delete. A deleted task is hard-removed from the read model rather than tombstoned, so the key allocator could not recover the highest number ever issued and the next task took the freed key; keys now come from a persisted monotonic counter, seeded from the log on load, so a deleted task never hands its key to the next one. Keys were never unique across groups, so reports should still cite the task `id`.
- Moving a task into In Progress without claiming it first produced a state nothing could reach: the watchdog only measures a claimed task, and `claim_next` only looks at Backlog and Human In The Loop, so an unclaimed In Progress task was never auto-blocked, never dispatched and never timed. `move_task` and `move_tasks` now claim an unclaimed task for the caller as it enters the column.
- The claim was a hard lock only for `claim_task` itself: `update_task`, `move_task`, `move_tasks` and `delete_task` wrote regardless of who held the task, so any agent could edit, move or delete work another agent was holding. Those tools now take an optional `agent` and refuse a write while a different agent holds a live claim, naming the holder.
- The board had no optimistic concurrency, so two writers silently overwrote each other — and the human's web UI is a second writer the server cannot serialize. `update_task`, `move_task`, `move_tasks` and `delete_task` now accept `expectedSeq` (read it from `get_board_snapshot`) and fail with a `Conflict` instead of clobbering, which is what makes a concurrent whole-column reorder safe.
- The watchdog overwrote the blocked reason: auto-blocking an In Progress task wrote its canned "no agent sync" message over whatever reason was already on the card. It now writes that reason only when the card has none, and always records `blockedAt`. It still never clears the claim.
- Compaction destroyed audit history: folding the log into a snapshot dropped every event at the five-thousand-event mark and forgot their ids too. The events are now appended to `.agileboard/events-archive.ndjson` before the log is cleared, and the running count is persisted in `state.json`.
- Creating a task was not idempotent, so a retried `create_task` / `create_tasks` could double-create — and a duplicate `*.created` event was silently dropped, so a caller could believe it had created something the server discarded. Both tools now accept an `idempotencyKey`; a key that already resolved returns the existing task with `idempotent: true`, and the batch form skips and counts the ones it deduplicated.
- Every event an agent wrote carried the same actor, so the log could not say which agent did what. The write tools now take a per-call `agent` that becomes the event's `actor.id`, while tools called without one keep the process-wide default.
- Iterations were numbered from the count of boards in the group, so moving a board between groups could leave two boards both named `Iteration 2`. The number now follows the highest suffix already in the group.
- A board bound to a group that had been deleted still reported that group id, so the sidebar could group a board under an id nothing resolves to. Board reads now report such a binding as ungrouped.
- Digesting a note was irreversible: `digest_key_points` stamped the notes as digested and there was no way back, so a hasty digest froze the note and cleared the gate that stops work starting. `undigest_key_points` reverses it, and the agent skill now says so.
- The advisory lock lease was not tunable next to the five-minute claim window it has to be reconciled with. It now reads `OPENAGILE_LOCK_STALE_MS` and keeps the 30-minute default.

## [3.1.2] - 2026-09-03

### Fixed

- WIP colors now apply only to counter badges.

## [3.1.1] - 2026-09-03

### Fixed

- remove top column edge wip color from the column's accent colour
- Prevent CI-only startup render storms from event-log backfill, persist column edits before reload, and serialize consecutive drag-drop reconciliation.

## [3.1.0] - 2026-09-01

### Added

- Added per-column WIP limits. Each column carries a `wipLimit` (0 = unlimited) set in the Add Column and Edit Column modals. The column header counter shows `count/limit`, turning amber at the limit and red above it, and a column over its limit takes a red top edge so the breach stays readable when the header is collapsed or squeezed on mobile. Being at the limit is normal operation, so it is signalled by the counter alone — no top edge to compete with the column's accent colour. Limits are advisory and never block adding, dragging, importing, or syncing a task: under event-sourced sync a remote event cannot be rejected without breaking convergence, so a hard block would be a guarantee the sync model cannot keep. The Done column is exempt, counts are measured board-wide across swimlanes, and limits ride the existing `column.updated` event with no new event type.

### Changed

- Simplified the mobile board header into a single top row. On Samsung S23-sized screens the visible header now stays to logo or board name plus notifications and menu, while search and account or sync controls open in the mobile menu overlay instead of stacking across three persistent rows.
- Expanded the mobile controls menu into a full-screen overlay with an explicit close button so the search field, sync or account status, and board actions open at the top of the viewport instead of starting far down the screen.

### Fixed

- ci fix
- Fixed Online Mode losing some boards across devices after local snapshots. Board snapshots now only consider and garbage-collect events from their own board scope, so one board's snapshot cannot erase unsynced history for other boards before it reaches PocketBase.
- Fixed the legacy full-pull sync helper leaving pulled boards invisible locally by merging remote board rows into the local board list before returning.

## [3.0.8] - 2026-08-31

### Added

- Added a deterministic real-Chromium large-board performance harness for 400-task and 1,000-task standard and swimlane boards. It separately budgets synthetic IndexedDB fixture backfill, startup, real SortableJS pointer-drop latency, live cards, post-GC retained DOM nodes, JavaScript heap, render counts, and browser crashes locally and in CI.

### Changed

- The `fetch-air-lake-temperatures` cron no longer records Faaker See; it now tracks Wörthersee water temperature and Viktring air temperature only. Existing `air_lake_temperatures` rows for Faaker See are left in place.

## [3.0.7] - 2026-08-02

### Fixed

- Fixed the `fetch-air-lake-temperatures` cron aborting with `ReferenceError: formatViennaTimestamp is not defined`. PocketBase's JSVM re-executes each hook callback in a fresh, isolated VM, so the date helpers declared at file scope in `backend/pb_hooks/air_lake_temperatures.pb.js` were never in scope at run time. They now live inside the `cronAdd` callback.

## [3.0.6] - 2026-08-01

### Removed

- Purged pre-event-sourcing rows from the PocketBase `events` collection (migration `1746100012`). They carried no `hlc` and no `scope` and used the old activity-log vocabulary (`task.column_moved`, `task.label_added`, …), so catch-up dropped them, the projector dropped them, and the reducer logged `Unknown event type` for every one on each device that pulled.

### Fixed

- Fixed local boards and tasks never reaching PocketBase. Events are only emitted going forward, so anything already in IndexedDB when event sourcing landed had no event log at all — it was invisible to sync while the header still read `Live ●` (queue depth 0 means "nothing queued", which a device with zero events also satisfies). A one-shot backfill (`event-sourcing/backfill.js`, run from `initStorage()`) now emits `board.created` / `column.created` / `label.created` / `task.created` for every pre-existing entity that has no `*.created` event yet, in an order a replaying device can rebuild from. Dedup is board-scoped, since column ids like `done` repeat across boards.
- Fixed boards deleted on one device reappearing on another. `applyBoardDeleted` records a soft-delete tombstone, but `listBoards()` returned every board regardless — unlike `loadTasksForBoard` / `loadColumnsForBoard` / `loadLabelsForBoard`, which all filter `deleted`. A device replaying `board.deleted` resurrected the board.
- Fixed snapshots being upload-only. `uploadSnapshot()` deletes the server events a snapshot covers, but nothing ever read one back, so a device joining after that GC pulled a log with the board's history already deleted and reconstructed nothing. Catch-up now hydrates from the newest server snapshot per scope (`downloadSnapshot()` / `downloadAllSnapshots()`) before replaying newer events, advancing `lastSeenHlc` to the snapshot's HLC. The read model is written through the projector (`hydrate()`), which stays its sole writer per ADR-0005.
- Fixed events left unsynced when a tab closes sitting in IndexedDB until the user happened to make an edit. `initSyncQueue()` now drains on startup when authenticated, matching `initRealtime()`, which already caught up on load.

## [3.0.5] - 2026-07-31

### Changed

- Made `dragdrop-done-crash.spec.js` deterministic on headless CI: it now drags via stepped `page.mouse` events instead of `locator.dragTo()`, which fired `dragstart`/`dragover` faster than SortableJS promotes `Sortable.active` and intermittently reverted the drop before `onEnd` ran. Same fix the 300-task perf spec already used.

## [3.0.4] - 2026-07-31

### Changed

- `render.js` now exposes two render adapters behind one read model — `renderBoard()` (full rebuild) and `reconcileBoard()` (in-place patch). The drop path's manual `syncTaskCounters`/`syncCollapsedTitles`/`syncMovedTaskDueDate` pass is gone; those helpers are now `reconcileBoard()`'s implementation, and the dead `syncTaskCounters` export was removed. Covered by `tests/dom/reconcile.test.js` (10 behaviors) plus the real-Chrome `dragdrop-done-crash.spec.js`.

### Fixed

- Fixed the Chrome renderer crash on drag-to-Done at its root cause instead of racing its timing. The `requestAnimationFrame`/`setTimeout` barriers of 3.0.1–3.0.3 only moved *when* the teardown fired; the crash returned because the barrier was racing Chrome's drag-finalize IPC, which is unobservable from JS. The mechanism itself is now removed: a drop opens a **drag-reconcile window** (`beginDragReconcile()`/`endDragReconcile()` in `render.js`), so the `DATA_CHANGED` the move emits is routed through the new `reconcileBoard()` adapter — a keyed, in-place DOM patch — instead of `renderBoard()`'s `innerHTML` reset. The just-dragged node Chrome still references is never detached, and Sortable is never re-initialised mid-`onEnd`. `reconcileBoard()` mirrors the full render (card moves/reorder, counters, collapsed titles, due dates, Done virtualization, board filter, notifications) and falls back to a full rebuild for swimlane mode or a structural column-set change.

## [3.0.3] - 2026-07-30

### Fixed

- Fixed Online Mode sync getting stuck at `Syncing… (N)` after login: `auth-changed` now starts an outbound event drain for pre-existing offline events, and the sync indicator rerenders on queue status changes when events finish, retry, or pause.

## [3.0.2] - 2026-07-30

### Fixed

- Fixed Chrome renderer crash on first drag-to-Done: the single `requestAnimationFrame` barrier was insufficient on Windows Chrome because Chrome's DnD browser-process IPC response arrives as a new task after the frame paints, not during the RAF. The barrier is now `requestAnimationFrame(() => setTimeout(resolve, 0))` — the RAF yields past `dragend`'s synchronous dispatch, and the nested `setTimeout(0)` yields past the frame paint into the next task-queue slot, after the IPC has settled and Chrome has released its references to the dragged nodes.
- Fixed drag/drop teardown leaks when the board re-renders or reinitializes during an active drag: Sortable cleanup now clears task and column drag body classes, pointer listeners, autoscroll state, collapsed drop-zone state, and hover classes. Done-column drops also avoid a redundant top-pin event because the primary drop handler already orders Done tasks through state.

## [3.0.1] - 2026-07-30

### Fixed

- Fixed Chrome renderer crash on second consecutive drag-to-Done: `onEnd` now defers all state mutations to the next animation frame (`requestAnimationFrame`) before calling `scheduleDomainEvent`, preventing `renderBoard()`'s synchronous `innerHTML` reset from detaching nodes that Chrome's DnD engine still holds references to.
- Fixed `dragdrop.spec.js` `should drag task from In Progress to Done` test with the 300-task performance fixture: replaced `dragTo` with `page.mouse` events and a 50 ms yield. Playwright's `dragTo` fires `dragstart` and `dragover` via CDP in rapid succession; SortableJS defers setting `Sortable.active` to the next event-loop tick (`setTimeout(0)` in `_dragStarted`), so `_onDragOver` saw a null `Sortable.active` and reverted every drop into a non-empty Done column. The `page.mouse` approach gives the timer time to fire between moves.

## [3.0.0] - 2026-07-16

### Added

- Event-sourced sync foundation: HLC module with persisted node IDs and IndexedDB v2 stores for events, snapshots, and reducer read models.
- Event-sourced reducer foundation with idempotent handlers for task, label, column, board, settings, subtask, and relationship events; feature modules now emit persisted domain events while keeping offline behavior intact.
- Snapshot module with local GC: periodic board snapshots written to IndexedDB; old events pruned after each snapshot; configurable snapshot interval.
- Event-sourced sync backend schema and outbound push queue (issue #112): PocketBase `events` collection extended with `hlc`/`scope`/`entity_id`, nullable `board`, `details`→`payload`, immutable updates; new `snapshots` collection; legacy collections locked read-only. Client `sync-queue` drains unsynced events to PocketBase in HLC order with a 5-deep in-flight cap, 500 ms debounce, three-tier retry (network backoff, auth-pause, permanent 4xx), online-event resume, and no-rollback semantics.
- Inbound realtime sync (issue #114): a PocketBase SSE subscription applies remote events live across devices, plus a launch/reconnect catch-up pull so a just-opened device converges without manual sync.
- Board scaffolding now emits domain events with a stable default board id (issue #114): a new device and an existing one converge on the same default board without a board-sharing handshake.
- Header sync-state indicator (issue #115): a single live indicator replaces the manual Sync button — `Live ●` (green) when online and synced, `Syncing… (N)` (yellow) while events drain, `⚠ N unsynced` (orange) when retrying or paused, and `Offline` (gray) when offline or signed out; updates without a page reload.

### Changed

- Reducer is now the sole writer of the read model (issue #118, ADR-0005): local mutations emit domain events only — the direct `save*()` read-model writes were removed. Events are projected synchronously on the local path so the UI stays instant, while remaining HLC-ordered for sync. Domain events were made self-complete so the read model reproduces from events alone: relationship inverses now emit for the target task, task creation/reorder emit the sibling-order change, `doneDate` is derived in the move reducer, swimlane drag reassignments emit their field changes, and subtask title edits propagate. This also fixes latent cross-device gaps where relationship inverses and column order never synced. Deletes are hard removals via `task.deleted` (no read-model tombstone).
- Read-model projection extracted from the `storage.js` god module into a dedicated `event-sourcing/read-model-projector.js` (issue #119, ADR-0005): `createReadModelProjector()` receives the in-memory `state` + schedulers by injection and owns `EVENT_EMITTED` subscription and projection. Behavior-preserving — the reducer stays pure and remains the sole read-model writer; no change to projection semantics, dedup, or snapshot scheduling.

### Removed

- Activity log feature retired: `activity.html`, `activity-log.js`, `activity-log-ui.js`, and `activity.js` removed; navigation links and all write-paths cleaned from tasks, columns, labels, storage, import/export, and sync modules.
- ADR-0001 (dual-log audit trail) superseded by ADR-0004 (domain-event stream).
- Online Mode PocketBase sync PRD documenting the current Go Online, auth, manual sync, auto-sync, and no-merge V1 contract.
- Global `softDeleteEnabled` setting and "Soft-delete tasks" toggle in App Settings.
- "Purge deleted tasks" settings action and `runPurge` flow.
- Settings UI now separates App-level settings from Board-level settings, making global preferences distinct from per-board configuration.
- Sync branching on `softDeleteEnabled` and `pendingHardDeletes`; deletion propagation now follows the domain-event stream/tombstone model.

### Fixed

- Sync documentation now matches current Online Mode behavior: failed PocketBase health probes disable "Go Online" and show the probed health URL.
- Health probe URL now correctly uses `VITE_PB_URL` (e.g. `https://pb.kanvana.com/api/health`) instead of resolving relative to the app origin, preventing false "unreachable" reports.
- Login modal now shows the HTTP status code and backend URL on 5xx errors instead of a generic "Something went wrong" message.
- Sync server unreachability now shows a modal notification with the full backend URL so users know immediately when login/sync is unavailable rather than seeing a silent failure.
- Fixed desktop task drag autoscroll so long task lists scroll vertically while dragging a card near the list edge.
- Fixed Impressum page overflow so the legal content can scroll vertically on desktop and mobile.
- Fixed sub-task font size.
- Fixed missing scale icon for the legal/impressum page.
- Deleting a board while signed in now also deletes the mapped PocketBase board and its board-scoped columns, labels, tasks, relationships, and events before removing the local board.
- Board changes from another device now refresh the board selector live (issue #114): remotely created or renamed boards appear in the dropdown without a reload.
- Event-sourced PocketBase migration fixed for PocketBase v0.38.1 (issue #114): `events.board` is stored as TEXT (a client-side local UUID, not a `openagile_boards` relation), so board-scoped events no longer fail validation; uses the v0.38.1 field API (`removeByName`/`add`).
- Added a follow-up PocketBase migration that defensively repairs deployed databases where `events.board` is still a relation, preventing `validation_missing_rel_records` failures when signed-in users save task changes.
- Corrected the frontend reverse-proxy URL in the Nginx configuration.
- Vite now loads the `client/.env.local` (dev) and `client/.env.production` (build) files: `envDir` was previously resolving to `client/src/`, so `VITE_PB_URL` was silently ignored and the app fell back to the same origin; the production build now correctly targets `https://pb.kanvana.com`. The Playwright e2e configs pin `VITE_PB_URL=/` so the sandboxed browser stays same-origin via the `/api` proxy.

## [2.0.0] - 2026-05-16

### Added

- `schema.js` — canonical factory functions (`createTask`, `createColumn`, `createLabel`, `createBoard`, `createSubTask`, `createRelationship`, `createActivityLogEntry`) that initialize all domain object fields to their documented defaults; `RELATIONSHIP_TYPES` and `ACTIVITY_ACTOR_TYPES` constants exported from the same module
- `activity-log.js` `createActivityEvent` now includes an `id` (UUID) field on every entry for deterministic PocketBase sync deduplication
- PocketBase migrations: `sub_tasks` (json), `swimlane_label_id` (text), `deleted` (bool) fields added to the `tasks` collection
- PocketBase migrations: `role` (text) and `deleted` (bool) fields added to the `columns` collection
- PocketBase migrations: `deleted` (bool) field added to the `labels` collection
- PocketBase `task_relationships` collection — stores directed relationship edges (type, task, target_task) with board-scoped ownership; replaces the previous JSON-only approach for cross-task queries and real-time subscriptions
- PocketBase `events` collection — unified event log for task-level `activityLog` and board-level `boardEvents`; task relation is optional so board events are first-class

### Changed

- Split `storage.js` into three modules: `idb-store.js` (IDB plumbing and key helpers), `board-serializer.js` (board import ID-remapping via `normalizeBoardModelIds`), and `storage.js` (in-memory state, CRUD, init, migration). No behavior change; `getBoardEventsKey` and `_flushPersistsForTesting` remain importable from `storage.js` via re-export.
- Moved `defaultColumnColor` to `normalize.js` alongside `isHexColor`.
- `sync.js` `pushBoardFull` and `pullAllBoards` now round-trip all task fields (`subTasks`, `swimlaneLabelId`, `deleted`), column `role`/`deleted`, label `deleted`, task relationships via the `task_relationships` collection, and activity log entries + board events via the `events` collection; legacy entries without an `id` are skipped during event sync
- `sync.js` syncMap extended with `task_relationships` and `events` buckets; existing stored sync maps are backfilled with empty buckets on load
- Restored the root production `Dockerfile` used by CI/GHCR builds and aligned the production Docker compose PocketBase service with the repository backend image.

### Fixed

- Fixed the CI Docker build path so `docker/build-push-action` can find the production Dockerfile and push the `prod` image target.
- Fixed Docker build context exclusions so local frontend dependencies and build output are not copied into production image builds.
- Fixed `sync.test.js` mock missing `loadBoardEvents` and `saveBoardEvents` exports added to `storage.js`; updated `pullAllBoards` test cases to mock the two new parallel PocketBase fetches (`task_relationships`, `events`)
- Fixed `activity-log.test.js` assertion to include the `id` field now returned by `createActivityEvent`
- Fixed CI workflow installing `firefox` Playwright browser while `playwright.config.js` only configures a `chromium` project; changed install step to `chromium`

## [1.7.1] - 2026-05-15

### Added

- Quick board switch: clicking the board name in the header (`#brand-text`) opens the Manage Boards modal
- `Ctrl+B` global keyboard shortcut opens the Manage Boards modal (ignored when an input/textarea/select is focused)
- Arrow key navigation (`ArrowDown`/`ArrowUp`) cycles through board items in the open Manage Boards modal; `Enter` activates the highlighted board and closes the modal
- `showBoardsModal` exported from `boards-modal.js` and re-exported via `modals.js`
- User-facing keyboard shortcut documentation with a complete shortcut table in `docs/user/keybindings.md`

### Fixed

- Add secret with production pocketbase url  VITE_PB_URL: ${{ secrets.VITE_PB_URL }}

## [1.7.0] - 2026-05-09

### Added

- Added Udami web analytics for openagile gdpr compliant no tracking web analytics, so I know how many people visit.
- Soft-delete for tasks, columns, and labels: `deleteTask`, `deleteColumn`, `deleteLabel` now mark entities with `deleted: true` instead of hard-removing them; all read paths (`loadTasks`, `loadColumns`, `loadLabels`, board-scoped variants) filter deleted records so callers never see them
- `loadDeletedTasksForBoard(boardId)`, `loadDeletedColumnsForBoard(boardId)`, `loadDeletedLabelsForBoard(boardId)` — sync layer access to soft-deleted records before purge
- `purgeDeleted(boardId)` — hard-removes all `deleted: true` records from IDB for a given board; called by sync layer after confirmed PocketBase deletes
- `saveColumnsForBoard(boardId, columns)`, `saveTasksForBoard(boardId, tasks)`, `saveLabelsForBoard(boardId, labels)`, `saveSettingsForBoard(boardId, settings)` — board-scoped write fns in `storage.js`; used by pull to write data for any board without changing the active board
- `sync.js` — PocketBase sync module: `isAuthenticated`, `ensureAuthenticated` (returns false on refresh failure), `loginUser`, `registerUser` (no auto-login), `logoutUser`, `loginWithProvider`, `pushBoardFull(boardId)` (loads data from storage, upserts live entities, hard-deletes soft-deleted entities from PocketBase, calls `purgeDeleted`), `pullAllBoards` (fetches all boards, maps PB IDs to local IDs, writes via board-scoped storage fns, preserves active board)
- `auth-changed` custom event dispatched on `pb.authStore.onChange`
- `kanban.js` entry point now calls `initializeAuthSyncUI()` and `initializeAutoSync()` after `initializeBoardsUI()` — auth/sync fully live on page load
- `authsync.js` — auth/sync UI orchestration: `initializeAuthSyncUI()` wires login/logout/sync/pull handlers; PocketBase health probe on init (disables `#login-btn` with tooltip when unreachable); registration shows confirm-email message and returns to login mode (no auto-login); push calls `pushBoardFull(boardId)` per board + `enableAutoSync` + `scheduleAutoSync`; pull calls `pullAllBoards` + `renderBoard` + `initializeBoardsUI`; `alert()` replaced with `alertDialog`; `auth-changed` event updates UI
- Login modal (`#login-modal`) in `index.html`: email/social tabs, email login form with signup toggle, Google/Apple/Microsoft provider buttons, `#auth-message` status region
- Header auth controls in `index.html`: `#login-btn` (Go Online), `#user-info` chip with `#user-name` + `#sync-btn` + `#logout-btn` (hidden until logged in)
- `hideLoginModal()` exported from `modals.js`; login-modal added to Escape key handler
- `icons.js`: added `Cloud`, `RefreshCw`, `LogOut`, `Chrome`, `Apple`, `LayoutGrid` icons
- `auth.css` — auth and sync UI component styles using design tokens: `.user-info`, `.user-name`, `.login-tabs`, `.login-tab`, `.login-pane`, `.auth-message`, `.social-providers`, `.login-provider-btn`, `#sync-btn` spin animation, `.btn-text`; imported in `styles/index.css`
- `autosync.js` — per-board debounced auto-sync: `scheduleAutoSync(boardId)` debounces 700ms per board, per-board in-flight guard with queue, `kanban-local-change` listener scoped to boardId, `initializeAutoSync()` registers listener + catch-up push on page load, `isAutoSyncEnabled/enableAutoSync/disableAutoSync` feature flag; replaces global single-timer approach with per-board Map state
- `npm run test:overview` generates `tests/TEST-OVERVIEW.md`, an AI-readable inventory of test files, test cases, source plan links, and heuristic coverage gaps

### Changed

- chore: update version in README and enhance audit trail documentation fixed drift in spec
- `docker-compose.yml`: PocketBase service now builds from `devops/local/backend/Dockerfile`, port corrected to `8090`, healthcheck fixed to `http://localhost:8090/api/health`, data volume path corrected to `/pocketbase/data`
- nginx `default-dev.conf`: PocketBase upstream corrected from `pocketbase:80` to `pocketbase:8090`
- `kanban-local-change` custom event emitted from `saveTasks`, `saveColumns`, `saveLabels` with `{ boardId, entity }` detail — foundation for scoped auto-sync trigger
- Unit test window event mock in `tests/unit/setup.js` to support `CustomEvent` assertions in Node environment
- PocketBase backend Dockerfile at `devops/local/backend/Dockerfile` — builds from `adrianmusante/pocketbase:latest` with migrations baked in
- PocketBase JS migrations for all four collections (`boards`, `columns`, `labels`, `tasks`) with owner-only access rules (`owner = @request.auth.id` on all CRUD operations); migrations baked into Docker image at `/pocketbase/migrations/`

## [1.6.0] - 2026-05-01

### Added

- Audit trail: two-log architecture — each task now carries an embedded `activityLog` array; a separate per-board event store (`events:{boardId}` in IDB) records board-level events (column mutations, task deletions, column moves)
- `activity-log.js`: `createActivityEvent()` constructs validated event envelopes; `appendTaskActivity()` and `appendBoardEvent()` write to the appropriate store; `DEFAULT_HUMAN_ACTOR` constant for UI-driven mutations
- All task mutations now emit typed events: `task.created`, `task.title_changed`, `task.description_changed`, `task.priority_changed`, `task.due_date_changed`, `task.label_added`, `task.label_removed`, `task.relationship_added`, `task.relationship_removed`; column mutations emit `column.created`, `column.renamed`, `column.deleted`, `column.reordered`; task and column deletions emit `task.deleted`
- `activity-log-ui.js`: `formatActivityEvent()` converts any event to a human-readable string; `createTaskActivitySection()` returns a collapsible accordion for the task modal (collapsed by default, events newest-first)
- Task edit modal now includes a collapsible Activity section at the bottom of the right column showing the task's full history
- Board Activity page (`activity.html`) lists all board-level events newest-first with an empty state when no events exist; accessible via the Activity nav button in the header
- `normalizeActivityLog()` in `normalize.js` strips structurally invalid activity log entries on load
- Board export/import round-trips both `activityLog` per task and the board event store; malformed entries are dropped silently on import
- `deleteBoard()` now removes the associated board event store key to prevent orphaned IDB entries
- Docker Compose stack: nginx (static file server + PocketBase proxy) + PocketBase service (`spectado/pocketbase`)
- `Dockerfile`: multi-stage build — `node:20-alpine` builder stage bakes Vite output into `nginx:alpine` prod image
- `docker-compose.yml`: main compose file for local and VPS deployment
- `.env.example`: documented environment variables (NGINX_PORT, PB_VERSION, IMAGE_TAG)
- `nginx/nginx.conf` + `nginx/conf.d/default.conf`: nginx config with PocketBase proxy, security headers (X-Frame-Options, X-Content-Type-Options, Referrer-Policy), static asset caching
- `.dockerignore`: lean build context
- CI `ci.yml`: replaces `deploy.yml`; adds Docker multi-arch build + GHCR push (npm audit gate) before FTP deploy
- CI `deploy-docker.yml`: SSH-based VPS deployment triggered after successful CI build
- URLs in task descriptions are automatically rendered as clickable links on task cards — links open in a new tab and do not trigger the edit modal. Only `http://` and `https://` URLs are linkified; rendering uses DOM APIs (no innerHTML) for XSS safety.
- Live link preview strip in the task modal: when a `http://` or `https://` URL is present in the description field, clickable chips appear below the textarea in real time — no need to save first. Duplicate URLs are deduplicated. The strip hides itself when no URLs are present.

### Changed

- CI: replaced `deploy.yml` with `ci.yml` (docker-build + ftp-deploy jobs); FTP deploy now gated on Docker build success
- CI: all workflows standardized to Node 20
- Docker development now runs the frontend from `client/` in Vite dev mode via `docker compose up`, and the Dockerfile build paths now match the frontend package and nginx config locations
- Docker development now uses a single `docker-compose.yml`; the former `docker-compose.override.yml` dev settings were folded into the main compose file
- Board, column, label, and task model IDs are now normalized to UUIDs. The permanent Done column is identified by `role: "done"` so its ID can also be a UUID, while legacy imports, templates, and migrated storage rewrite old string IDs and references automatically.

### Fixed

- Docker Compose dev startup no longer throws `Error: spawn xdg-open ENOENT`; the containerized Vite command now disables browser auto-open (`--open false`)
- Docker Compose dev startup no longer fails with `npm ERR! enoent Could not read package.json`; the container now mounts the actual frontend package root at `/app`

## [1.5.0] - 2026-04-03

### Added

- RAID template board for project management and customer labels with label groups
- Legal/Impressum page (`impressum.html`) with publisher info, privacy policy, and obfuscated email reveal
- "Legal/Impressum" link at the bottom of the control menu with visual separator
- Label text color is now automatically set to black or white based on perceived luminance of the label background color for better readability

### Changed

- Label search in the task modal now highlights the first matching label and supports keyboard navigation (Arrow Up/Down to move highlight, Enter to toggle selection and clear search)
- When no labels match the search query, the "Create label" button is auto-highlighted and navigable with keyboard (Enter opens Create Label modal with search text pre-filled; arrow keys can move between it and any partial matches); after creation the new label is auto-added and the search box is cleared
- Updated `docs/spec/overview.md` to reflect IndexedDB storage (was still referencing localStorage in three places) and added all missing modules to the module map (normalize, security, dom, events, constants, task-card, task-modal, column-element, column-modal, boards-modal, labels-modal, swimlane-renderer, impressum)
- Updated `docs/specification-kanban.md` ownership map to include all current modules with their corresponding spec files
- Replaced the header's Lucide kanban icon with the OpenAgile SVG logo while keeping the brand text bound to the active board name
- **Storage backend migrated from `localStorage` to IndexedDB** (`idb` wrapper, `openagile-db` database). All board data now persists in a key-value IDB object store (`kv`) instead of localStorage, removing the hard 5–10 MB browser limit. Writes are non-blocking (async fire-and-forget). One-time automatic migration runs on first load for existing users.
- Added `initStorage()` async entry point called once per page load in `kanban.js`, `reports.js`, and `calendar.js` before any board rendering. All other storage functions remain synchronous via in-memory state.
- Added `loadTasksForBoard(id)`, `loadColumnsForBoard(id)`, `loadLabelsForBoard(id)`, `loadSettingsForBoard(id)` helpers for cross-board reads (used by board export).
- Added non-blocking quota monitoring: logs a console warning when IDB usage exceeds 80% of the browser's storage quota.
- Unit tests now use `fake-indexeddb` to polyfill IDB in Node.js; `_resetStorageForTesting()` resets in-memory state between tests. The reset function closes the IDB connection before nulling it so subsequent `deleteDB()` calls in test teardown are never blocked.
- Added `_flushPersistsForTesting()` export that awaits all in-flight IDB writes (`_pendingPersists` Set) before assertions run, eliminating timing races in cross-session roundtrip tests.
- Added `tests/unit/storage-idb.test.js` — 19 tests covering IDB-specific paths: fresh-start behaviour, cross-session persistence for tasks/columns/labels/settings/boards, `deleteBoard` IDB cleanup, multi-board and legacy single-board localStorage migration, idempotent re-migration guard, corrupt IDB resilience, and cross-board read helpers (`loadTasksForBoard` etc.).
- Renamed the project from "personal-kanban" to "openagile"  openagile == "Kanban" + "nirvana" # smooth flow
- Renamed link in page footer to Github Docs instead of "Documentation"
- Documentation .md docs to refer to openagile better reflect new name within the documentation.
- Migrated all E2E tests from localStorage to IndexedDB seeding and assertions (`swimlanes-persistence`, `swimlanes-dnd`, `swimlanes-toggle`, `subtasks`, `create-task`, `dragdrop`); added `readIDBValue` / `readIDBSettings` helpers to `swimlanes.helpers.js`

### Fixed

- Sub-task inline edit: pressing Escape no longer saves the edited value (blur handler was committing after cancel)


## [1.4.0] - 2026-03-30

### Added (1.4.0)

- Sub-tasks: lightweight checklist items inside tasks with inline creation, completion tracking, drag-to-reorder, inline editing, and a donut progress indicator on task cards

### Changed (1.4.0)

- Sub-task progress indicator on task cards redesigned from a linear progress bar to an inline donut circle visualization with `completed/total Done` label in the footer row
- Relationship indicator row on task cards is now right-aligned
- Task cards are fully clickable to open the edit modal — click anywhere on the card except the delete button to edit; drag-and-drop remains unaffected

## [1.3.0] - 2026-03-30

### Added (1.3.0)

- Task relationships: link tasks together with typed relationships — **Prerequisite** (another task must complete first), **Dependent** (this task is needed by another), and **Related** (general connection).
- Relationships are bidirectional — adding a relationship automatically creates the inverse on the target task; removing one removes the inverse.
- Relationship badges displayed in the task edit modal as color-coded pills showing type and short ID (e.g. `prerequisite #ae2ry`). Clicking the short ID opens the linked task directly.
- Autocomplete search in the modal to find tasks by short ID (`#ae6a`) or title text; already-linked tasks show their current type and can be replaced by selecting them with a new type.
- Task cards show a `git-branch` icon with `relationships (N)` count when one or more relationships exist.
- New spec document `docs/spec/relationships.md` covering data model, bidirectional sync rules, UI behavior, and normalization.

### Changed (1.3.0)

- Import and export are now unified under Manage Boards; the main board toolbar no longer shows separate import/export buttons.
- Board export now includes `exportMeta` metadata with app version, schema version, and export timestamp.
- Export and import now share the same strict structural validation path for board payload integrity checks.
- Unknown task-column references now return explicit manual repair guidance (add missing `columns[].id` entries or remap `task.column` to an existing id) instead of only a generic error.

## [1.2.3] - 2026-03-23

### Fixed (1.2.3)

- Swimlane active column width set to 100% to fit window flexibly and responsiveness

## [1.2.2] - 2026-03-22

### Added (1.2.2)

- Quick-access swim lane toggle in the board controls menu for enabling/disabling swim lanes without opening Settings.
- Drag-and-drop swim lane ordering in Settings modal — reorder lanes for any grouping mode, persisted per board.

### Changed (1.2.2)

- Swimlane row collapse button now shows only the chevron icon by default; the bordered box appears only on hover.
- Removed colored left-border accent from swimlane row headers.
- Import preflight review now checks JSON schema and file size before saving any board data, then asks for confirmation with a summary of imported counts and warnings.
- Added a built-in AI Agent Ops starter board template with beginner-friendly columns, pre-labeled starter tasks, and grouped Agent/Workstream/Artifact labels for managing 2-5 parallel agents.
- Reports now escape user-controlled tooltip content, swimlane action buttons no longer rely on HTML injection for icons, and the app pages send a stricter Content Security Policy.
- The main README now highlights the AI Agent Ops starter template near the top to better attract agent-building users to the project.

### Fixed (1.2.2)

### Removed (1.2.2)

## [1.2.1] - 2026-03-22

### Added (1.2.1)

- Documented and standardized the project test architecture around `Vitest`, `@testing-library/dom`, `MSW`, and `Playwright`, including a dedicated testing strategy reference and folder naming convention.
- Added a split canonical specification set under `docs/spec/`, with `docs/specification-kanban.md` now acting as the spec index, governance entrypoint, and code-to-spec ownership map.
- Added a pull request template and a CI spec-sync check that requires spec and changelog updates when files under `src/` change.

### Fixed (1.2.1)

- Swimlane columns now expand to fill available window width, matching the non-swimlane board layout behavior.

### Changed (1.2.1)

- `npm test` now runs the full unit, DOM integration, and Playwright end-to-end suites in sequence.
- Added dedicated `npm run test:dom` and `npm run test:e2e` scripts for the standardized split between DOM integration and browser journey coverage.
- Added initial DOM and MSW scaffold files with passing example tests to establish the new `tests/dom/` and `tests/mocks/` workflow.
- Contributor guidance in `CLAUDE.md`, `.github/copilot-instructions.md`, and `docs/readme.md` now points to the new split specification structure instead of a single monolithic spec file.

### Removed (1.2.1)

## [1.2.0] - 2026-03-21

### Added (1.2.0)

- Toggleable swim lane board view with label, label-group, and priority grouping, sticky lane headers, `No Group` fallback lane, and persisted per-board settings
- Swim lane-aware drag and drop that updates persisted lane assignment and allows moves across lanes, columns, or both in one gesture
- Swim lane test coverage: pure logic unit tests plus Playwright integration tests for toggle/rendering, drag-drop movement, and settings persistence
- Accordion-style swim lane collapse/expand controls with persisted per-board collapsed lane state
- Label-group swim lane configuration now lets the user pick a specific label group so each label value in that group renders as its own swim lane row
- Per-cell collapse/expand toggles in swim lane view allowing individual swimlane-column cells to be collapsed independently of row and column collapse
- Add-task button in each swim lane cell that creates a task in the target column and automatically assigns the correct label or priority based on the swimlane

### Fixed (1.2.0)

- Swim lane task cards now display the same column accent colors (left color bar, hover tint, border color) as standard column view
- Collapsed workflow columns in swim lane view now accept drag-and-drop with visual hover feedback (dashed outline), matching standard column view behavior

### Changed (1.2.0)

- Swim lane row headers now render as a full-width bar above the row of column cells instead of a sidebar column, with `sticky; left: 0` positioning so the header stays pinned to the left viewport edge during horizontal scrolling
- Collapsed workflow column headers in swim lane view now show only the collapse/expand toggle, hiding the title, task counter, and add-task button
- Removed the "Swim Lane" corner cell from the swim lane grid header
- Board rendering now supports a swim lane grid mode while keeping the existing column-only layout unchanged when the feature is off
- Board import/export now preserves swim lane settings and explicit task lane assignments
- Swim lane controls moved out of the board toolbar into the Settings modal
- Expanded swim lane rows now hide done-column cards by default to keep lanes compact while preserving Done as a drag-and-drop target
- Swim lane workflow headers now stay visible during vertical scrolling, and column collapse continues to work while swim lanes are enabled
- In priority-grouped swim lanes, dragging a task between lanes now updates the task priority to match the target lane
- Collapsed swim lane rows now render as a single compact bar spanning all columns, showing chevron, lane name, active count, and done count in one horizontal line
- Swim lane row toggle button moved to the left of the lane name for consistent expand/collapse control placement
- Mobile swim lane layout switched from CSS grid to flex so lane headers (36px vertical strip) stay sticky-visible on the left edge while swiping through 85vw snap-scrolling columns

### Removed (1.2.0)

## [1.1.4] - 2026-02-19

### Added (1.1.4)

### Changed (1.1.4)

- Release automation switched to PR-first flow: `Generate Release` now opens/updates a release PR, and `Publish Release` publishes tag + GitHub Release automatically after merge to `main`

### Removed (1.1.4)

## [1.1.3] - 2026-02-19

### Added (1.1.3)

- Same-day completions report section: KPIs (this week, last week, avg per week) and a 12-week bar sparkline showing tasks created and completed on the same day

### Changed (1.1.3)

- Tasks in the Done column no longer show overdue/urgency countdown styling; due date is displayed without countdown text in neutral styling. Updates immediately on drag-drop.
- Column color picker now displays hex color code alongside the color selector, matching the label editor UX
- Added a quick-access Notifications bell beside the menu button while keeping Notifications in the controls dropdown; both buttons now show the same live notification count badge and open the same modal
- Improved drag-drop performance for Done column: disabled internal sorting of done (tasks always placed at top of done) and eliminated redundant localStorage reads during drop operations
- Added a manual GitHub Actions release pipeline (`Generate Release`) that runs build, bumps version/changelog, pushes commit and tag, and publishes a GitHub Release with changelog notes

### Removed (1.1.3)

## [1.1.2] - 2026-02-14

### Added (1.1.2)

- Create Board modal now includes a Template dropdown to create a new board from a built-in template (or start blank)

### Changed (1.1.2)

- Task edit modal redesigned with 2-column layout on desktop
  - Left column: title, description, priority, due date, column selector
  - Right column: labels section
  - Modal width increased to 850px on desktop for better space utilization
  - Remains single-column on mobile devices for optimal touch interaction
- Active labels in task modal now wrap to multiple lines instead of horizontal scrolling when many labels are selected
- Manage Boards modal now closes immediately after clicking "Open" on a board

### Removed (1.1.2)

## [1.1.0] - 2026-02-14

The jump to 1.1.0 reflects a substantial release with many new features, quality-of-life improvements, and stronger end-to-end test coverage.

### Added (2026-02-14)

- Due date countdown timer showing time remaining in task footer
  - Countdown displays beside due date in format "Due MM/DD/YYYY (countdown)"
  - Shows months and days for periods ≥ 30 days (e.g., "2 months 5 days", "1 month")
  - Shows only days for periods < 30 days (e.g., "5 days", "tomorrow", "today")
  - Three-tier color coding for quick visual prioritization (configurable in Settings):
    - Red: within urgent threshold (default: < 3 days to due)
    - Amber: within warning threshold (default: 3-10 days to due)
    - Default: beyond warning threshold (default: > 10 days to due)
  - Overdue tasks show "overdue by X days" or "overdue by X months Y days"
- Countdown color threshold settings in Settings modal
  - Urgent threshold: customize when countdown shows red (default: 3 days)
  - Warning threshold: customize when countdown shows amber (default: 10 days)
  - Per-board configuration allows different workflows for different boards
- Shared date utility module (`dateutils.js`) for consistent countdown calculations across features

### Changed (2026-02-14)

- Dragging tasks onto collapsed columns now highlights the column with a dashed outline and drops the task at the top of that column
- Task drag now auto-scrolls within tall columns so tasks can be dropped beyond the visible viewport
- Mobile task drag now auto-scrolls the column as you drag toward the top or bottom edge

### Removed (2026-02-14)


## [1.0.13] - 2026-02-10

### Added (1.0.13)

- Calendar page (`calendar.html`) showing a one-month due-date calendar with per-day counts and a clickable list of tasks due on the selected date (each task link opens the task on the board); linked from the main menu

### Changed (1.0.13)

- Task description textarea in task modal now supports vertical resizing (user can drag to expand height while width stays fixed)
- Reports page layout updated so each section has more space; on mobile, sections are swipeable like columns
- Reports lead time chart now shows Completed as blue bars, with Avg lead time and Trend as lines
- Calendar now highlights overdue due-date counts and overdue tasks in red
- Reports and Calendar pages now honor the saved theme (including dark mode)

### Removed (1.0.13)

## [1.0.12] - 2026-02-09

### Added (1.0.12)

- Playwright E2E test suite (`npm test`) covering boards, task creation/validation, and drag/drop performance scenarios.

### Changed (1.0.12)

- Drag/drop now prefers native HTML5 drag-and-drop on non-touch pointers (keeps SortableJS fallback for touch/coarse pointers) to improve first-drag reliability on desktop and compatibility with Playwright automation.
- Modals now keep the action buttons (Cancel/Save/Close) sticky at the bottom while the modal content scrolls, preventing the actions from flowing off-screen.
- Task priority now supports `urgent` (above high) and `none` (below low), and the default priority is now `none`.

### Removed (1.0.12)

## [1.0.11] - 2026-02-06

### Added (1.0.11)

- **Performance optimization**: Incremental task drop updates avoid full board re-render, dramatically improving drag-drop speed into columns with 100+ tasks
- **Done column virtualization**: Initially renders 50 tasks with "Show more" button to load additional batches, enabling smooth performance with 300+ completed tasks
- **Test infrastructure**: Playwright E2E tests with performance fixtures (300+ tasks) to ensure drag-drop completes in <1 second
- Test scripts: `npm test`, `npm run test:ui`, `npm run test:debug`
- Test fixture generator: `tests/fixtures/generate-fixture.js` creates performance test boards with 300+ tasks
- "Show more" button styling for virtualized task lists in Done column
- Task title now clamps to a single line with ellipsis on cards

### Changed (1.0.11)

- Drag-drop now uses `updateTaskPositionsFromDrop()` for targeted updates instead of full `renderBoard()`, reducing post-drop work from O(n*m) to O(affected columns only)
- Task `columnHistory` only updates when task changes columns (not for reorders within same column), reducing unnecessary data writes
- Label loading optimized: pre-loads labels into Map once per render instead of repeated `loadLabels()` calls per task
- Task counters and collapsed column titles sync incrementally after drop without DOM rebuild
- Notifications refresh only when tasks move between columns (not on reorder)
- `createTaskElement()` now accepts pre-loaded labels map as optional parameter for performance
- Task card layout: due date and age render together in the footer bottom row
- Reports bundle size reduced by switching ECharts to modular imports (only required charts/components)

### Removed (1.0.11)

## [1.0.10] - 2026-02-06

### Changed (1.0.10)

- Refactored monolithic `design.css` (2,285 lines) into a modular CSS architecture under `src/styles/` with 16 focused files organized by concern (tokens, base, layout, utilities, responsive, and 10 component files)
- Manage Labels modal now uses an accordion to group labels; first group expanded by default, others collapsed
- Extracted reusable accordion component (`src/modules/accordion.js`, `src/styles/components/accordion.css`) with generic `createAccordionSection(title, items, expanded, renderItem)` API
- Board-level task search now also matches label group names (e.g., searching "People" shows all tasks with labels in the People group)

## [1.0.9] - 2026-02-06

### Added (1.0.9)

- Label groups: labels can now have an optional group field for organizational grouping (e.g. People, Activities)
- Manage Labels modal displays labels organized by group with uppercase section headers
- Task modal label picker shows labels organized by group
- Label create/edit modal includes a group input with autocomplete suggestions from existing groups
- Label search now matches against group names in both Manage Labels and task label picker

## [1.0.8] - 2026-02-06

### Added (1.0.8)

- Label create/edit modal now shows an editable hex color code field next to the color picker, kept in bidirectional sync
- Hex color input validation prevents saving labels with invalid color codes

## [1.0.7] - 2026-02-01

### Added (1.0.7)

- Label search in task editor now shows a full-width "No label found 'X' - Create label" button when no matches are found, allowing users to quickly create a new label with the search term as the pre-filled name
- Form validation for task title and column name fields: both fields are now required and display a red error state with explanatory message when submitted empty
- Validation module (`src/modules/validation.js`) for reusable form field validation functions

### Changed (1.0.7)

### Removed (1.0.7)

## [1.0.6] - 2026-01-31

### Added (1.0.6)

- Reports dashboard: Cumulative Flow Diagram (CFD) stacked area chart showing task count by column over time.
- Task edit modal now includes a small X close button in the top-right.

### Changed (1.0.6)

- Tasks now track `columnHistory` to support cumulative flow reporting.
- Reports page layout redesigned as a fixed dashboard grid with reports-specific styles (no page scrolling).
- Collapsed columns now display the task count in the header (e.g., "To Do (5)")
- Notifications upcoming window (days) is now configurable per board in Settings (default: 3)
- Theme toggle now shows the sun icon when dark mode is active
- Notification banner on desktop now fills a single row with as many tasks as fit before showing a “more” indicator
- Notification banner now refits its task count when the window is resized
- update bump version automagically

### Removed (1.0.6)

## [1.0.5] - 2026-01-25

### Added (1.0.5)

- Column menu now includes a "Sort" option to sort tasks by due date (earliest first) or priority (high to low)
- Notification banner showing tasks due within 2 days or overdue, positioned below the header
- Notifications modal accessible via bell icon in the board menu, listing all urgent tasks
- Notification badge on bell icon showing count of tasks needing attention
- Notification banner close (X) button to hide the banner
- Notifications modal toggle to show/hide the notification banner

### Changed (1.0.5)

- Age is now shown as an example `1y 6M 40d` not simply only `5d`
- Fix: correct column order calculation when adding a new column so that done remains in last order
- Notification banner layout/scroll behavior refined for desktop and mobile

## [1.0.4] - 2026-01-17

### Added (1.0.4)

- Footer now shows the app version
- Reports dashboard now includes weekly lead time (creation → done) bar chart with a trend line
- Reports dashboard now includes weekly completion KPIs and a completed-per-week sparkline

## [1.0.3] - 2026-01-17

### Added (1.0.3)

- Tasks now track `doneDate` when moved into the Done column

### Changed (1.0.3)

- The Done column is now permanent and cannot be deleted

## [1.0.2] - 2026-01-17

### Added (1.0.2)

- Manage Boards modal now includes an "Add Board" button (opens the Create New Board modal)
- Manage Boards modal now includes an inline export button per board (download icon)
- Manage Boards modal now includes an "Import Board" button
- Reports page (reports.html) with an ECharts calendar heatmap of daily updates for the active board (last 365 days)
- Settings toggles to show/hide task priority and show/hide task due date
- Task modal label picker now includes a + button to open Manage Labels and return to the open task
- Edit Task modal now includes an "Open in full page" button (fullscreen icon)
- Manage Labels modal now includes a search field to filter labels
- Columns can now be collapsed into a ~20px bar via a new toggle button (left of the drag handle)

### Changed (1.0.2)

- Creating a board while the Manage Boards modal is open immediately refreshes the boards list to show the new active board
- Board creation entry point moved from the controls dropdown into Manage Boards
- New tasks are inserted at the top of the column (instead of appended to the bottom)
- Export function now includes the board name and replaces any spaces with _ (underscore)
- Label names are now limited to 40 characters (UI prevents longer input and shows an alert)
- Creating/editing a label now warns on duplicate names (case-insensitive, e.g. "Important" vs "important")

### Removed (1.0.2)

- Page refresh/leave warning (`beforeunload`) prompt
- "New Board" button from the controls dropdown menu

## [1.0.0] - 2026-01-11

First public release. No backend. No tracking. No cloud, fully local in your own browser, no-server-required personal kanban board with localStorage persistence. Backup with a single click Export to JSON.

### Added (1.0.0)

- Settings modal (toggle age/updated timestamp, select locale; included in export/import)

## [0.0.1] - 2026-01-05

### Added (0.0.1)

- v0.1 first commits
- dark and light theme
- AI agent guidance via `.github/copilot-instructions.md`
- Board-level task search filter (matches label name, task title, or description)
- Show/expand all tasks when >12 tasks in a column

### Changed (0.0.1)

- build process to use Vite
- create ECMA Script Modules
- security try check for import and export json configurations and data
- Limit task card description text to ~2 lines (prevents overly tall cards)
- On mobile, keep the task modal label list height-capped with a scrollbar (instead of expanding to full height)
- Board-level task search also matches task priority text (low/medium/high)
- Task model now includes `changeDate`, updated on task save (edit, move)
- Task cards display `changeDate` as localized date+time and computed age (e.g. `0d`, `3d`, `2M`)
- Import/export JSON now includes `boardName` and import applies it to the active board
- Import now creates a new board (no overwrite)
- Default task priority is now `low` (configurable per board in Settings)

[Unreleased]: https://github.com/AntarcticBearHKL/Oh-My-OpenBoard/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/AntarcticBearHKL/Oh-My-OpenBoard/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/AntarcticBearHKL/Oh-My-OpenBoard/compare/v1.2.3...v1.3.0
