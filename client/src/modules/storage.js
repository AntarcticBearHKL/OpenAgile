import { initHlc } from './event-sourcing/hlc.js';
import { _flushDomainEventsForTesting } from './event-sourcing/emitter.js';
import { _resetSnapshotSchedulerForTesting } from './event-sourcing/snapshot.js';
import { backfillEventLog } from './event-sourcing/backfill.js';
import {
  openStore,
  KV_STORE,
  READ_MODEL_STORE,
  keyFor,
  readModelKeyFor,
  _flushPersistsForTesting as _flushIdbPersistsForTesting,
  _resetIdbForTesting,
} from './idb-store.js';
import {
  state,
  globalState,
  taskCacheByBoard,
  BOARDS_KEY,
  ACTIVE_BOARD_KEY,
  GLOBAL_PROJECTION_KEY,
  LEGACY_COLUMNS_KEY,
  LEGACY_TASKS_KEY,
  safeParseArray,
  safeParseObject,
} from './storage-state.js';
import { normalizeIdbState, migrateFromLocalStorage } from './storage-migration.js';
import { readModelProjector } from './storage-projector.js';
import { listBoards } from './storage-boards.js';
import {
  loadColumnsForBoard,
  loadTasksForBoard,
  loadSettingsForBoard,
} from './storage-cross-board.js';

// Re-export the frozen public surface. Every consumer keeps importing from
// ./storage.js unchanged; the DOM suite mock factories enumerate these names.
export { listBoards, getBoardById, getActiveBoardName, mergeBoardsFromRemote, getActiveBoardId, setActiveBoardId, ensureBoardsInitialized } from './storage-boards.js';
export { createBoard, renameBoard, updateBoardFields, deleteBoard } from './storage-board-mutations.js';
export { getDoneColumnId, isDoneColumnId, loadColumns, saveColumns, loadTasks, saveTasks } from './storage-entities.js';
export { loadSettings, saveSettings } from './storage-settings.js';
export { loadTasksForBoard, loadColumnsForBoard, loadSettingsForBoard, loadDeletedTasksForBoard, loadDeletedColumnsForBoard, purgeDeleted, saveColumnsForBoard, saveTasksForBoard, saveSettingsForBoard } from './storage-cross-board.js';

// ── Public initialisation ──────────────────────────────────────────────────────

/**
 * Must be called once at app startup (before any board renders).
 * Opens the IDB database, migrates from localStorage if needed, and loads all
 * board data into the in-memory state so subsequent reads are synchronous.
 */
export async function initStorage() {
  const db = await openStore();
  await initHlc();

  // Migrate from localStorage if IDB is empty but localStorage has data.
  const idbBoards = await db.get(KV_STORE, BOARDS_KEY);
  const hasLocalStorageData = Boolean(
    localStorage.getItem(BOARDS_KEY) ||
    localStorage.getItem(LEGACY_COLUMNS_KEY) ||
    localStorage.getItem(LEGACY_TASKS_KEY)
  );

  if (!idbBoards && hasLocalStorageData) {
    await migrateFromLocalStorage(db);
  }

  await normalizeIdbState(db);

  // Load everything into in-memory state.
  state.boards = safeParseArray(await db.get(KV_STORE, BOARDS_KEY)) || [];
  state.activeBoardId = (await db.get(KV_STORE, ACTIVE_BOARD_KEY)) || null;

  for (const board of state.boards) {
    state.tasks[board.id] = (await db.get(READ_MODEL_STORE, readModelKeyFor(board.id, 'tasks'))) ?? null;
    state.columns[board.id] = (await db.get(READ_MODEL_STORE, readModelKeyFor(board.id, 'columns'))) ?? null;
    state.settings[board.id] = (await db.get(KV_STORE, keyFor(board.id, 'settings'))) ?? null;
  }

  const globalProjection = safeParseObject(await db.get(KV_STORE, GLOBAL_PROJECTION_KEY));
  globalState.groups = safeParseArray(globalProjection?.groups) || [];
  globalState.boardGroups = safeParseObject(globalProjection?.boardGroups) || {};
  globalState.skills = safeParseArray(globalProjection?.skills) || [];

  // One-shot: give pre-event-sourcing state an event log so it can sync at all.
  await backfillEventLog({
    boards: listBoards(),
    columnsFor: loadColumnsForBoard,
    tasksFor: loadTasksForBoard,
    settingsFor: loadSettingsForBoard
  });

  // Backfill emits synthetic create events only to populate the event log. The
  // read model is already loaded above, so projecting those events during boot
  // would trigger one DATA_CHANGED/full render per entity (hundreds for a
  // large board) before the initial render is even allowed to run.
  readModelProjector.register();

  // Non-blocking quota warning at 80%.
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage, quota }) => {
      if (!quota) return;
      const pct = Math.round((usage / quota) * 100);
      if (pct >= 80) {
        console.warn(`[OpenAgile] Storage at ${pct}% of browser quota. Consider archiving old boards.`);
      }
    }).catch(() => {});
  }
}

// Adopt a downloaded snapshot as the read model (inbound catch-up, bug #4).
export function hydrateFromSnapshotState(key, snapshotState) {
  readModelProjector.hydrate(key, snapshotState);
}

export async function _flushPersistsForTesting() {
  await _flushDomainEventsForTesting();
  await _flushIdbPersistsForTesting();
}

/**
 * Resets the in-memory state and IDB connection.
 * Call this in unit test beforeEach hooks to get a clean slate.
 */
export function _resetStorageForTesting() {
  // Close the open IDB connection so a subsequent deleteDB() call is not blocked.
  _resetIdbForTesting();
  state.boards = [];
  state.activeBoardId = null;
  for (const k in state.tasks) delete state.tasks[k];
  for (const k in state.columns) delete state.columns[k];
  for (const k in state.settings) delete state.settings[k];
  globalState.groups = [];
  globalState.boardGroups = {};
  globalState.skills = [];
  taskCacheByBoard.clear();
  readModelProjector.reset();
  _resetSnapshotSchedulerForTesting();
}
