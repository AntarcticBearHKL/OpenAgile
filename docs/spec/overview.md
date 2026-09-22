# Specification Overview

## Product Scope

OpenAgile is a local-first kanban application. All application state lives in the browser and can be exported to or imported from JSON files.

## Specification Index

All canonical specs live under `docs/spec/`. Start here when adding, changing, or reviewing any feature.

### Core Architecture

| Spec | Purpose |
|---|---|
| `docs/spec/data-models.md` | Canonical shapes for board, task, and column |
| `docs/spec/storage.md` | IDB persistence model, in-memory state pattern, storage key layout, migration logic |
| `docs/adr/0004-event-sourced-sync.md` | **Architecture decision (current sync)** — pure event sourcing + HLC replaces whole-record LWW; offline-first. Read this first for sync. |

### Features

| Spec | Purpose |
|---|---|
| `docs/spec/board-ui.md` | Main board layout, column/card rendering, mobile behavior |
| `docs/spec/tasks.md` | Task CRUD, notes to the agent, the digest workflow, claim timing, card display rules |
| `docs/spec/columns.md` | Fixed columns, column UI, WIP limits, Finished column invariants |
| `docs/spec/settings.md` | Per-board settings fields and persistence |
| `docs/spec/sub-tasks.md` | Retired sub-task model — notes to the agent replaced it |
| `docs/spec/import-export.md` | Board JSON export/import format and ID-remapping rules |
| `docs/spec/sync.md` | Local folder sync: linking a `.agileboard/` folder, the shard layout, merge rules and the status control |


### Testing

| Spec | Purpose |
|---|---|
| `docs/spec/testing-strategy.md` | Canonical test stack, folder layout, naming conventions, layer goals |
| `docs/spec/testing.md` | Test scripts, IDB unit test setup, fixture conventions |

### Governance

| Resource | Purpose |
|---|---|
| `docs/specification-kanban.md` | Spec index, update policy, code-to-spec ownership map — read first before any change |
| `docs/adr/` | Architecture decision records — one file per significant architectural decision |

## Technology Rules and Principles

- Only vanilla CSS, JavaScript, and HTML
- Minimal to no dependencies:
  - `lucide` for tree-shaken icons via `src/modules/icons.js`
- Storage: browser **IndexedDB** via the `idb` wrapper (migrated from localStorage)
- Data persistence: JSON import/export to local disk
- No server, no frameworks
- Build tooling: Vite with ES modules
- Frontend package root: `client/` (`npm install`, `npm run dev`, and `npm run build` run from there)

## Entry Points

- `src/kanban.js` / `src/index.html` - main board UI, wires handlers, calls `renderBoard()`

**Every entry point must call `await initStorage()` before accessing any storage functions.**

## Module Map

- `src/modules/schema.js` - canonical factory functions for all domain objects (`createTask`, `createColumn`, `createBoard`)
- `src/modules/render.js` - centralized board rendering (`renderBoard`) plus the keyed in-place patch (`reconcileBoard`)
- `src/modules/idb-store.js` - IDB singleton, key helpers (`keyFor`, `getBoardEventsKey`), `schedulePersist`, `scheduleDelete`
- `src/modules/board-serializer.js` - board import ID-remapping (`normalizeBoardModelIds`)
- `src/modules/storage.js` - in-memory state, all CRUD helpers (`load*`/`save*`), `initStorage()`, migration, default data
- `src/modules/tasks.js` - task CRUD, task ordering, and the rework move back to Backlog
- `src/modules/columns.js` - column collapse state helpers
- `src/modules/boards.js` - board management
- `src/modules/modals.js` - modal open/close wiring and Escape/backdrop behavior
- `src/modules/dialog.js` - confirm and alert dialog helpers
- `src/modules/icons.js` - Lucide icon registration and `renderIcons()`
- `src/modules/settings.js` - per-board settings modal and persistence
- `src/modules/dateutils.js` - date formatting helpers
- `src/modules/accordion.js` - reusable collapsible accordion component
- `src/modules/importexport.js` - board JSON export/import normalization
- `src/modules/theme.js` - theme toggle and persistence
- `src/modules/validation.js` - form validation helpers
- `src/modules/utils.js` - UUID generation and shared utilities
- `src/modules/normalize.js` - data normalization: color (`isHexColor`, `defaultColumnColor`), dates, string keys
- `src/modules/security.js` - HTML escaping (`escapeHtml`) and byte formatting utilities
- `src/modules/dom.js` - minimal DOM construction helper (`el()` factory)
- `src/modules/events.js` - lightweight event bus replacing circular dynamic imports
- `src/modules/constants.js` - domain constants (fixed column IDs, defaults, keybindings)
- `src/modules/task-card.js` - task card DOM element builder
- `src/modules/task-modal.js` - task edit/create modal logic
- `src/modules/column-element.js` - column DOM element builder
- `src/modules/boards-modal.js` - manage boards modal logic
- `src/modules/folder-sync.js` - `.agileboard/` folder transport (File System Access API): outbound shard append, inbound shard merge
- `src/modules/folder-sync-ui.js` - Settings control for linking a folder and reading sync status

### Event sourcing (`src/modules/event-sourcing/`)

- `hlc.js` - Hybrid Logical Clock: monotonic stamps with a persisted node id; `compareHlc` total ordering
- `emitter.js` / `dispatcher.js` - emit domain events from feature modules and dispatch them into the reducer + IDB event store
- `snapshot.js` - client-side board snapshots that bound replay

## Data Flow

Mutations generally follow:

```text
load -> modify -> save -> renderBoard()
```

Many modules call `renderBoard()` through the `events.js` bus or dynamic imports to avoid circular dependencies.

## Rendering and UI Foundations

- `renderBoard()` clears and rebuilds the board from persisted state
- Columns are sorted by `column.order`
- Tasks are sorted within each column by `task.order`
- Lucide icons are re-rendered after dynamic DOM updates

## CSS Architecture

Styles are organized under `src/styles/` with `src/styles/index.css` importing files in cascade order:

- `tokens.css` - theme variables
- `base.css` - element resets
- `utilities.css` - utility classes
- `layout.css` - shell layout
- `responsive.css` - media-query overrides
- `components/buttons.css`
- `components/icons.css`
- `components/column.css`
- `components/card.css`
- `components/forms.css`
- `components/modals.css`
- `components/accordion.css`

The app uses CSS custom properties and `html[data-theme]` for theming.

## Icons

- Icons are imported and registered only through `src/modules/icons.js`
- After adding dynamic markup with `data-lucide`, call `renderIcons()`

## Default Data

- Fixed columns: `Backlog`, `Human In The Loop`, `In Progress`, `Blocked`, `Finished`
- Backlog holds work the agent proposed; Human In The Loop is the human's hand-entry point; In Progress is what an agent is actively working; Blocked is work an agent could not finish and that needs a human decision or is stuck on a resource conflict; Finished is completed work
- The default board is created with the fixed columns and no tasks

## Footer

- Footer reminds users that data lives in the browser and should be exported
