# Personal Kanban Board Specification

This file is the entrypoint to the canonical application specification. Detailed product, data, and workflow rules live in focused files under `docs/spec/`.

## Canonical Spec Map

- `docs/spec/overview.md` - architecture, technology rules, module map, rendering foundations, CSS architecture
- `docs/spec/data-models.md` - persisted models and settings shape
- `docs/spec/storage.md` - IDB persistence model, storage keys, migration
- `docs/spec/board-ui.md` - board shell, controls, modals, rendering, warnings, drag/drop behavior
- `docs/spec/tasks.md` - task model usage, notes to the agent, the digest workflow, claim timing, card display, ordering
- `docs/spec/columns.md` - fixed columns, column UI, WIP limits, Finished rules
- `docs/spec/settings.md` - per-board settings
- `docs/spec/import-export.md` - board JSON import/export rules and compatibility expectations
- `docs/spec/sub-tasks.md` - retired sub-task model; notes to the agent replaced it
- `docs/spec/audit-trail.md` - two-log audit trail design, event types, actor model, storage keys, UI entry points
- `docs/spec/sync.md` - local folder sync: linking a `.agileboard/` folder, shard layout, merge rules, status control
- `docs/spec/testing.md` - testing stack, scripts, and coverage focus

## Update Policy

- Every code change that adds, changes, or removes product behavior must update `CHANGELOG.md` in the same work session.
- Every code change that affects functionality, data shape, storage, UI behavior, or workflow rules must also update the relevant file in `docs/spec/` in the same work session.
- Update this index file when the spec structure, ownership map, or update process changes.
- If contributor workflow or module structure changes, also update `CLAUDE.md`.

## Ownership Map

Use this mapping to decide which spec files to update alongside code changes.

- `src/modules/idb-store.js` -> `docs/spec/storage.md`
- `src/modules/board-serializer.js` -> `docs/spec/storage.md`, `docs/spec/import-export.md`, `docs/spec/data-models.md`
- `src/modules/storage.js` -> `docs/spec/storage.md`, `docs/spec/data-models.md`
- `src/modules/importexport.js` -> `docs/spec/import-export.md`, `docs/spec/storage.md`, `docs/spec/data-models.md`
- `src/modules/tasks.js` -> `docs/spec/tasks.md`, `docs/spec/data-models.md`
- `src/modules/normalize.js`, `src/modules/task-modal.js`, `src/modules/task-card.js` -> `docs/spec/tasks.md` and any other affected feature spec files
- `src/modules/columns.js`, `src/modules/column-element.js`, `src/modules/column-modal.js` -> `docs/spec/columns.md`
- `src/modules/boards.js`, `src/modules/boards-modal.js` -> `docs/spec/board-ui.md`
- `src/modules/settings.js` -> `docs/spec/settings.md`
- `src/modules/render.js`, `src/modules/dragdrop.js`, `src/index.html`, `src/activity.html`, `src/styles/**` -> `docs/spec/board-ui.md` and any affected feature spec files
- `src/modules/dom.js`, `src/modules/events.js`, `src/modules/constants.js`, `src/modules/security.js`, `src/modules/utils.js` -> `docs/spec/overview.md`
- `src/modules/dialog.js`, `src/modules/modals.js` -> `docs/spec/board-ui.md`
- `src/modules/theme.js`, `src/modules/icons.js` -> `docs/spec/overview.md`, `docs/spec/board-ui.md`
- `src/modules/activity-log.js`, `src/modules/activity-log-ui.js`, `src/modules/activity.js` -> `docs/spec/audit-trail.md`
- `src/modules/folder-sync.js`, `src/modules/folder-sync-ui.js` -> `docs/spec/sync.md`
- `tests/**`, `playwright.config.js`, `vitest*.config.js` -> `docs/spec/testing.md` and `docs/testing-strategy.md` when strategy or naming conventions change

## Contributor Workflow

When making a change:

1. Identify the affected code area.
2. Update the matching `docs/spec/*.md` file or files.
3. Update `CHANGELOG.md` under `Unreleased`.
4. Update this index only if the spec structure, ownership map, or process changed.

## Related Docs

- `docs/testing-strategy.md` - deeper testing architecture and naming conventions
- `CLAUDE.md` - contributor workflow and repository guidance
