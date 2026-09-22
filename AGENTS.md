# OpenAgile — Agent & Developer Guide

> **This file is the source of truth for `CLAUDE.md` and `GEMINI.md`** (both are symlinks here).
> Edit `AGENTS.md` directly; the symlinks pick up changes automatically.

OpenAgile is a local-first Kanban board that runs entirely in the browser. No server is required for
the core app. All data persists in **IndexedDB** (`openagile-db`).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS (ES modules), HTML, CSS |
| Build | Vite 7 |
| Tests | Vitest (unit + DOM), MSW (API mocks) |
| Runtime storage | IndexedDB via `idb` library |
| UI libs | Lucide icons, SortableJS |

---

## Directory Structure

```
client/             Frontend app (the main product)
  src/
    modules/        Feature modules: board, tasks, drag-drop, …
    kanban.js       Entry point — initialises storage, renders board
    index.html      Main board page
    activity.html   Board event log page
  tests/
    unit/           Vitest pure-unit tests
    dom/            Vitest + @testing-library/dom integration tests
    mocks/          MSW API mocks shared by Vitest suites
supervisor/         Board supervisor — drives the board with short-lived worker turns
docs/
  adr/              Architecture Decision Records
  spec/             Feature specifications
  user/             User-facing documentation (guides, FAQs, etc.)
CONTEXT.md          Domain model — read before working on any feature
CHANGELOG.md        Keep updated under [Unreleased] as you work
```

---

## Dev Commands

All commands run from `client/`:

```bash
npm run dev          # Vite dev server → http://localhost:5173
npm run build        # Production build → client/dist/
npm run preview      # Serve the production build locally
npm test             # Full suite: unit + DOM
npm run test:unit    # Vitest unit tests only
npm run test:dom     # Vitest DOM integration tests only
```

Run the full test suite before opening a PR.

---

## Local Server Hygiene

Never start a long-lived server from a tool call. The call waits for the process to exit, so the
agent stalls and a stray server keeps the port busy for hours. Launch detached instead
(`harness/start-bg.ps1` / `harness/dev-bg.ps1`) or use a command that terminates on its own.

For a visual check, serve the build on the sandbox port and shut it down when done:

```bash
npm run preview -- --port 4321 --strictPort
```

---

## Architecture Rules

Read `CONTEXT.md` for the full domain model, entity schemas, and key workflows.
Check `docs/adr/` for recorded architectural decisions before making structural changes.

| Rule | Detail |
|---|---|
| Board is aggregate root | All CRUD is scoped to the active board via `getActiveBoardId()` |
| No cross-board mutation | Use `loadTasksForBoard(id)` / `loadColumnsForBoard(id)` — never read or write another board's state |
| State → render | Every state change must end with `renderBoard()` or an incremental sync helper |
| Circular dep guard | Use dynamic `await import('./render.js')` only for render calls; all other imports must be top-level static |
| `done` column | `id === 'done'` is permanent; never delete or reorder it past the last position |
| Entity IDs | Always `generateId()` from `utils.js` — no numeric or legacy string IDs |
| Keybindings | Register in `DEFAULT_APP_KEYBINDINGS` or `DEFAULT_EDITOR_KEYBINDINGS` — never hardcode key strings |
| Storage init | `initStorage()` is async; call it once at startup before any board operation |
| Audit trail (dual log) | Column moves write to both `columnHistory` (CFD/lead-time) **and** `activityLog` (audit). Both writes are intentional — see ADR-0001. |

---

## Coding Conventions

- Default to **no comments**. Add one only when the WHY is non-obvious: a hidden constraint, a subtle invariant, or a workaround for a specific bug.
- No docstrings or multi-line comment blocks.
- Validate only at system boundaries (user input, external APIs). Trust internal code and framework guarantees.
- Prefer editing existing files; don't add abstractions beyond what the task requires.
- AI agents must set the `actor` field on every audit event they create: `{ type: "agent", id: "<model-name>" }`.

---

## Test Layers

| Layer | Tool | Path |
|---|---|---|
| Unit | Vitest | `client/tests/unit/` |
| DOM integration | Vitest + @testing-library/dom | `client/tests/dom/` |
| API mocking | MSW | `client/tests/mocks/` |

Key coverage areas: storage CRUD, UUID migration, import/export preflight,
claim timing, the digest gate, validation, normalization.
