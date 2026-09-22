# Testing

## Standard Test Stack

- `Vitest` for unit tests in `tests/unit/`
- `Vitest` plus `jsdom` and `@testing-library/dom` for DOM integration tests in `tests/dom/`, with `MSW` mocking API behavior from `tests/mocks/`
- `node harness/test.mjs` for harness tests

The canonical folder and naming conventions live in `docs/testing-strategy.md`.

## Test Scripts

- `npm test` - run unit and DOM suites in sequence
- `npm run test:unit` - run unit tests only
- `npm run test:dom` - run DOM integration tests only
- `node harness/test.mjs` - run the harness tests
- `npm run test:overview` - regenerate `tests/TEST-OVERVIEW.md` from test source

## IDB Unit Test Setup

Storage tests are split across two files:

- `tests/unit/storage.test.js` — synchronous unit tests for all CRUD functions (work entirely against in-memory state, no IDB interaction needed)
- `tests/unit/storage-idb.test.js` — async tests for IDB-specific paths that `storage.test.js` cannot exercise:
  - `initStorage()` loading state from a real (fake-IDB) database
  - Multi-board and legacy single-board localStorage → IDB migration
  - Cross-session persistence: write in session A, reload in session B
  - `deleteBoard` cleaning up IDB entries
  - Cross-board read helpers (`loadTasksForBoard`, `loadColumnsForBoard`, etc.)
  - Corrupt IDB resilience

### IDB test infrastructure

- `fake-indexeddb` (dev dep) polyfills `globalThis.indexedDB` in Node.js via `tests/unit/setup.js` (`import 'fake-indexeddb/auto'`).
- `beforeEach` in `storage-idb.test.js` calls `resetLocalStorage()` (which calls `_resetStorageForTesting()`) **and** `await deleteDB('openagile-db')` to give each test a completely empty database.
- `_resetStorageForTesting()` calls `_db.close()` before nulling `_db` so `deleteDB()` is never blocked by an open connection.
- `_flushPersistsForTesting()` awaits `Promise.all([..._pendingPersists])` before cross-session assertions; avoids timing races from fire-and-forget IDB writes.

### Cross-session roundtrip pattern

```js
await initStorage();
ensureBoardsInitialized();
saveTasks([{ id: 't1', title: 'Persisted task', ... }]);
await _flushPersistsForTesting();      // wait for IDB writes to settle
const boardId = getActiveBoardId();
_resetStorageForTesting();             // drop in-memory state; IDB intact
await initStorage();                   // reload from IDB (new session)
setActiveBoardId(boardId);
expect(loadTasks().some(t => t.title === 'Persisted task')).toBe(true);
```

## Current Coverage Focus

- `tests/TEST-OVERVIEW.md` is the generated AI-readable test inventory. It lists every detected test case by file, test layer, suite path, and source line.
- The overview also includes filename-based gap heuristics for source modules and spec files without obvious named coverage. These heuristics are a fast triage aid, not a coverage guarantee.
- Board management flows, including the reconstructed board-create dialog
- Task creation and validation
- Task deletion flows: permanent delete confirmation removes the card; cancel leaves the card unchanged
- Task card content: title, description preview, notes to the agent, and the `needsDigest`/`isRework` marker
- Task modal: title, description and the notes-to-the-agent list, and the read-only lock on an In Progress task
- Notes-to-the-agent workflow: digest flags on append, Finished-to-Backlog rework, and `digest_key_points`
- Finished-column virtualization behavior
- Claim timing and the stale-claim watchdog
- The browser event bridge: the digest gate on a move into In Progress and on client digests/claims, and the local/same-origin request checks
- IDB storage: cross-session persistence, migration, and data integrity
- Event sourcing: HLC, reducer, outbound queue, realtime/catch-up, snapshots, and the sync indicator
