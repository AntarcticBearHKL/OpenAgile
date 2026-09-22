# OpenAgile — Domain Model Context

> Hand-maintained source of truth. Update this file when entity schemas, workflows, or architecture
> boundaries change.

---

## 1. Core Domain Entities

Entity shapes are defined by the models in §2 (task, column, board). New entities are
constructed by the module that owns them (`storage-defaults.js` for default columns,
`tasks.js` for tasks), and every constructed entity must carry all fields the model defines.

### Glossary

**WIP limit** — the maximum number of Tasks a Column is *intended* to hold, stored as `wipLimit` on
the Column. `0` means unlimited (the default). A WIP limit is
**advisory, never enforced**: nothing blocks adding, dragging, importing, or syncing a Task into a
Column that is at or over its limit. It is a pull-system signal — reaching the limit means *stop
starting, start finishing* — surfaced only as a visual state on the board.

> **Why advisory and not a hard block.** Under event-sourced sync ([ADR-0004](docs/adr/0004-event-sourced-sync.md))
> a remote `task.created` / `task.moved` event arriving over SSE cannot be rejected without breaking
> convergence. Two devices offline can each add the 5th Task to a limit-5 Column and legitimately
> converge at 6. A limit enforced only on the local device would be a guarantee the sync model
> cannot keep, so it is not offered as one.

**At limit / over limit** — the two breach states. *At limit* is `taskCount === wipLimit`; *over
limit* is `taskCount > wipLimit`. A Column's count is measured **board-wide**. The **Finished**
Column is exempt: it is terminal and unbounded, and limiting it would block finishing work.

**Fixed columns** — every board has exactly five columns: **Backlog** (work the agent proposed),
**Human In The Loop** (the human's hand-entry point and the only column where a human adds a
task by hand), **In Progress** (what an agent is actively working; tasks there are read-only),
**Blocked** (work an agent could not finish and that needs a human decision, or work stuck on a
resource conflict) and **Finished** (completed work). Their ids, order, and the fifth column's
`role: "done"` are fixed; behaviour keys off those, never the display name. `name` is display-only,
and the fixed definitions are reimposed on every board at load, so renaming a fixed column's label
needs no migration.

**Group / Iteration** — a **Group** is a user-named container that can be renamed and holds
**Iterations**. An **Iteration** is a Board inside a group, numbered in order (Iteration 1,
Iteration 2, …) and never named by hand; a Board can never live outside a group. A group's leading
run of iterations whose tasks are all in Finished collapses behind one control.

---

## 2. Aggregate Roots and Boundaries

```
Board ──< Column ──< Task
       └─< Settings (1:1)
```

- **Board** is the aggregate root. No cross-board references exist.
- **Task** embeds the `keyPoints` collection (the notes to the agent); the description is the agent's reply surface.
- Every mutation is also recorded as an immutable **domain event** in the event store — the basis of
  sync and replay (see §9, and [ADR-0004](docs/adr/0004-event-sourced-sync.md)). The old inline task
  `activityLog` and board `BoardEvents` audit logs were removed in issue #110.

---

## 3. Storage Layer

All state is local-first, stored in **IndexedDB** (`openagile-db`, **version 2**). Event sourcing (#112)
added three object stores alongside the original `kv`:

| Object store | Content |
|---|---|
| `kv` | Coordination + small values: board list, active board, global settings, HLC node id |
| `read_model` | Per-board projections (tasks / columns / settings), keyed `{boardId}:{kind}` — what the UI renders |
| `events` | The domain-event log, keyed by event `id`; the `synced` flag marks events merged from another writer |
| `snapshots` | Local projection snapshots that bound replay and event GC |

The storage layer is split into three modules:

| Module | Responsibility |
|---|---|
| `idb-store.js` | IDB connection singleton, key helpers, fire-and-forget `schedulePersist()` / `scheduleReadModelPersist()` / `scheduleDelete()`, plus event helpers (`persistEvent`, `getUnsyncedEvents`, `markEventSynced`) |
| `board-serializer.js` | Board import normalizer — remaps non-UUID IDs, coerces fields on import or IDB migration |
| `storage.js` | In-memory `state` + all public CRUD functions. Imports from both above. Owns `state`/schedulers; wires them into the read-model projector. |
| `event-sourcing/read-model-projector.js` | `createReadModelProjector()` — the read-model projection host, extracted from `storage.js` ([#119](docs/adr/0005-reducer-sole-read-model-writer.md)). Subscribes to `EVENT_EMITTED` and folds domain events into the injected `state` via the pure reducer (the sole writer). |

**Main `kv` keys:**

| Key | Content |
|---|---|
| `kanbanBoards` | Board list array |
| `kanbanActiveBoardId` | Active board ID string |
| `openagile:settings:global` | Global (cross-board) settings object |
| `openagile:hlc:node` | Persisted Hybrid Logical Clock node id |

**Pattern:** `initStorage()` (async, called once at startup) → synchronous CRUD functions read/write
in-memory `state` → fire-and-forget IDB writes via `scheduleReadModelPersist()` → `renderBoard()`.

**Single write path into the read model** ([ADR-0005](docs/adr/0005-reducer-sole-read-model-writer.md)):
a local mutation in `tasks.js`/`columns.js` emits domain events and does **not** write the
read model directly. The read-model projector (`read-model-projector.js`, the reducer projection) is
the sole writer of `state`/`read_model`, for **both** local and remote (SSE/catch-up) events. Local events are emitted
**synchronously** by `scheduleDomainEvent()`, so the in-memory projection is updated before the
mutation returns / `renderBoard()` runs (instant UI); only the IDB event persist is async. Each
mutation's events are self-complete — they encode every read-model effect
(sibling reordering, derived `doneDate`)
so the projection reproduces the change from events alone. Deletes are hard removals via `task.deleted`
(no read-model tombstone).

**Key public functions:**

| Function | Role |
|---|---|
| `initStorage()` | Async bootstrap — opens IDB, loads all state into memory |
| `getActiveBoardId()` | Active board selector |
| `ensureBoardsInitialized()` | Guard called before any board operation |
| `loadTasksForBoard(id)` | Read task state for a board |
| `loadColumnsForBoard(id)` | Read column state for a board |
| `loadSettingsForBoard(id)` | Read board-scoped settings |
| `loadGlobalSettings()` / `saveGlobalSettings()` | Read/write cross-board app settings |
| `saveTasks()` / `saveTasksForBoard(id, tasks)` | Persist task array |
| `listBoards()` | All board metadata |
| `keyFor(boardId, kind)` | IDB key builder |

---

## 5. Event Bus

`client/src/modules/events.js` — a lightweight `EventTarget`-based bus that replaced the
`await import('./render.js')` circular-dependency workaround.

| Export | Purpose |
|---|---|
| `on(event, handler)` | Subscribe |
| `off(event, handler)` | Unsubscribe |
| `emit(event, detail)` | Publish |
| `BOARD_CHANGED` | `'board:changed'` — board-level structure changed |
| `DATA_CHANGED` | `'data:changed'` — projection changed (a domain event was applied); UI re-render trigger |
| `EVENT_EMITTED` | `'event:emitted'` — a domain event was persisted (local or remote); wakes the outbound queue and the reducer |

---

## 6. Feature Modules

| Module | Responsibility |
|---|---|
| `kanban.js` | Entry point — initialises storage, renders board |
| `boards.js` | Board lifecycle: create, rename, switch |
| `boards-modal.js` | Board selector / management modal |
| `columns.js` | Column collapse state helpers |
| `column-element.js` | Column DOM element factory |
| `tasks.js` | Task CRUD |
| `task-card.js` | Task card DOM element factory |
| `task-modal.js` | Task edit modal (title, description, notes to the agent) |
| `render.js` | Two render adapters behind one read model: `renderBoard()` (full rebuild — `innerHTML` reset + `initDragDrop()`) and `reconcileBoard()` (in-place patch — moves cards by id, reorders, collapsed titles, card meta, Finished-column virtualization). Plus the **drag-reconcile window** (`beginDragReconcile()`/`endDragReconcile()`) that routes a drop's `DATA_CHANGED` through reconcile so the just-dragged node is never detached. See §7 "Board Render Flow". |
| `dragdrop.js` | SortableJS initialization/teardown |
| `importexport.js` | Board JSON export/import with preflight validation |
| `reducer.js` | Pure event reducer — `applyEvent(state, event)` folds a domain event into projection state |
| `event-sourcing/emitter.js` | `emitDomainEvent()` / `scheduleDomainEvent()` — stamp (UUID + HLC), persist, emit `EVENT_EMITTED` |
| `event-sourcing/dispatcher.js` | `reduceEventAndNotify()` — runs the reducer and signals re-render |
| `event-sourcing/{hlc,snapshot}.js` | Hybrid Logical Clock stamps + local projection snapshots |
| `modals.js` | Modal coordination and shared modal state |
| `dialog.js` | `alertDialog` / `confirmDialog` helpers |
| `validation.js` | Field validators (column name, task, etc.) |
| `normalize.js` | Data normalization helpers (hex color, dates, string keys, etc.) |
| `settings.js` | Per-board settings load/save |
| `security.js` | Input sanitization |
| `theme.js` | Light/dark theme toggle |
| `icons.js` | Lucide icon hydration |
| `accordion.js` | Accordion UI component |
| `dom.js` | Shared DOM helpers |
| `utils.js` | `generateUUID()` and other pure utilities |
| `constants.js` | Domain constants: fixed column ids/roles, keybindings |

---

## 7. Key Workflows

### Board Render Flow
```
initStorage() → ensureBoardsInitialized() → renderBoard()
```

A projected `DATA_CHANGED` normally drives a full `renderBoard()` rebuild. A
**drag-drop** opens the drag-reconcile window first (`dragdrop.js` `onEnd`), so the
same `DATA_CHANGED` is routed through `reconcileBoard()` — a keyed in-place patch —
instead of the `innerHTML` teardown. This is why a drag-to-Finished no longer detaches
the node Chrome's DnD engine still holds. `reconcileBoard()` returns `false` (→ full
rebuild) for a structural column-set change.
```
drop onEnd → beginDragReconcile() → updateTaskPositionsFromDrop() → …DATA_CHANGED…
           → reconcileBoard() [patch in place]  → endDragReconcile()
```

### Column Management
```
createColumnElement → initializeColumnModalHandlers
  → addColumn | updateColumn | deleteColumn
  → emit(BOARD_CHANGED) → renderBoard()
```

### Import Preflight Flow
```
inspectImportPayload → buildImportConfirmationMessage → importTasks
  → normalizeBoardModelIds (board-serializer) → legacy ID remapping if needed
```

### Sync Flow (event-sourced)
```
[local mutation] → scheduleDomainEvent() (stamp UUID + sync HLC)
                 → emit(EVENT_EMITTED)  [synchronous]
   │             → persistEvent (synced=false)  [async, fire-and-forget]
   ├─ reducer: read-model-projector folds event into state (sole writer) → emit(DATA_CHANGED) → renderBoard()
   └─ outbound: the active transport forwards the event (a `.agileboard/` shard when a folder is
                linked, otherwise the local-server bridge)

[merged event] → folder-sync reconcile / local-server SSE → persist (synced=true) → emit(EVENT_EMITTED)
              → reducer projects into state → renderBoard()
```

---

## 8. Architecture Boundaries

| Boundary | Rule |
|---|---|
| Cross-board data | Use `loadTasksForBoard(id)` / `loadColumnsForBoard(id)` — never read or write another board's state |
| Rendering | All state changes must end with `renderBoard()` or an incremental sync helper |
| Circular deps | Use `events.js` bus for render triggers; do not use `await import('./render.js')` outside of initialization |
| Finished column | Use `isDoneColumn(col)` from `constants.js` — checks both `role === 'done'` and legacy `id === 'done'` |
| UUID | All entity IDs use `generateUUID()` from `utils.js`; no numeric or legacy string IDs post-migration |
| Keybindings | Never hardcode key strings; register in `DEFAULT_APP_KEYBINDINGS` in `constants.js` |
| Entity factories | Always use `createTask()`, `createColumn()`, etc. from `schema.js` — never construct entities ad-hoc |
| Domain events | Every entity mutation must emit a domain event via `scheduleDomainEvent()` (`event-sourcing/emitter.js`) so it syncs and replays — never mutate state silently. Event types are the `*.created`/`*.updated`/`*.deleted`/`*.moved` family handled by `reducer.js`. |
| Task deletion | Task delete is permanent: emit `task.deleted`, remove from the active task list, and let sync propagate deletion through the domain-event stream/tombstone model. ADR-0002's soft-delete mode was superseded by ADR-0004 and removed in issue #111. |

---

## 9. Event Sourcing

Mutations are recorded as immutable **domain events** — the source of truth for sync and replay. The
read model (§3) is a projection the reducer folds events into. Decision: [ADR-0004](docs/adr/0004-event-sourced-sync.md).

> The previous two-log audit trail (inline task `activityLog` + board `BoardEvents`, an Activity page,
> ADR-0001) was **removed in issue #110**. Its history now lives implicitly in the event stream,
> available to a future audit UI without a separate write path.

### Ordering — Hybrid Logical Clock

Each event carries an HLC stamp (`hlc`). `compareHlc()` gives a total order across devices; the reducer
re-sorts by HLC on replay, so insertion order is irrelevant. Node id persisted at
`openagile:hlc:node`; drift past 60 s is logged.

### Event Envelope

```json
{
  "id": "<uuid>",
  "type": "task.moved",
  "hlc": { /* HLC stamp */ },
  "at": "<ISO datetime>",
  "scope": "board",
  "board_id": "<board uuid | null for global>",
  "entity_id": "<id of the affected entity>",
  "actor": { "type": "human", "id": null },
  "payload": {
    "from_column": "<uuid>",
    "to_column": "<uuid>",
    "order": [{ "id": "<task uuid>", "column": "<column uuid>", "order": 1 }]
  }
}
```

`payload` (formerly `details`) carries the event data; for field changes, before/after values. Events
are persisted to the `events` IDB store with a `synced` flag.

### Actor Model

Every event carries `actor: { type: string, id: string | null }`.

| Value | Meaning |
|---|---|
| `{ type: "human", id: null }` | Current single-user (no identity) |
| `{ type: "agent", id: "claude-sonnet-4-6" }` | AI agent — identifies itself by model name |
| `{ type: "user", id: "<uuid>" }` | Future multi-user online mode |

AI agents are responsible for setting their own actor identity.

**`columnHistory` relationship:** Kept as-is on the task — independent of the
event stream.

---

## 10. Test Architecture

| Layer | Tool | Location |
|---|---|---|
| Unit | Vitest | `client/tests/unit/*.test.js` |
| DOM integration | Vitest + @testing-library/dom | `client/tests/dom/*.test.js` |
| API mocking | MSW | `client/tests/mocks/*.js` |

Key coverage areas: storage CRUD, UUID migration, import/export preflight,
notes to the agent (`keyPoints`), validation, normalization, and the event-sourcing
layer (HLC, reducer, snapshots, folder sync).
