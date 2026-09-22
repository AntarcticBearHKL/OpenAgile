import { nowIso } from './utils.js';
import {
  KV_STORE,
  READ_MODEL_STORE,
  keyFor,
  readModelKeyFor,
} from './idb-store.js';
import { normalizeBoardModelIds } from './board-serializer.js';
import {
  safeParseArray,
  safeParseObject,
  BOARDS_KEY,
  ACTIVE_BOARD_KEY,
  DEFAULT_BOARD_ID,
  LEGACY_COLUMNS_KEY,
  LEGACY_TASKS_KEY,
} from './storage-state.js';
import { defaultColumns, defaultSettings } from './storage-defaults.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

export async function normalizeIdbState(db) {
  const rawBoards = safeParseArray(await db.get(KV_STORE, BOARDS_KEY));
  if (!rawBoards) return;

  const rawActiveId = await db.get(KV_STORE, ACTIVE_BOARD_KEY);
  const nextBoards = [];
  const activeIdMap = new Map();
  const tx = db.transaction([KV_STORE, READ_MODEL_STORE], 'readwrite');
  const store = tx.objectStore(KV_STORE);
  const readModel = tx.objectStore(READ_MODEL_STORE);

  for (const rawBoard of rawBoards) {
    if (!rawBoard || typeof rawBoard !== 'object') continue;
    const oldBoardId = typeof rawBoard.id === 'string' ? rawBoard.id.trim() : '';
    const normalized = normalizeBoardModelIds({
      board: rawBoard,
      tasks: safeParseArray(await readModel.get(readModelKeyFor(oldBoardId, 'tasks')) ?? await store.get(keyFor(oldBoardId, 'tasks'))) || [],
      columns: safeParseArray(await readModel.get(readModelKeyFor(oldBoardId, 'columns')) ?? await store.get(keyFor(oldBoardId, 'columns'))) || defaultColumns(),
      settings: safeParseObject(await store.get(keyFor(oldBoardId, 'settings'))) || defaultSettings()
    });

    const newBoardId = normalized.board.id;
    activeIdMap.set(oldBoardId, newBoardId);
    nextBoards.push(normalized.board);
    await readModel.put(normalized.tasks, readModelKeyFor(newBoardId, 'tasks'));
    await readModel.put(normalized.columns, readModelKeyFor(newBoardId, 'columns'));
    await store.put(normalized.settings, keyFor(newBoardId, 'settings'));

    if (oldBoardId && oldBoardId !== newBoardId) {
      await readModel.delete(readModelKeyFor(oldBoardId, 'tasks'));
      await readModel.delete(readModelKeyFor(oldBoardId, 'columns'));
      await store.delete(keyFor(oldBoardId, 'settings'));
    }
    if (oldBoardId) {
      await store.delete(keyFor(oldBoardId, 'tasks'));
      await store.delete(keyFor(oldBoardId, 'columns'));
    }
  }

  await store.put(nextBoards, BOARDS_KEY);
  const nextActiveId = activeIdMap.get(rawActiveId) || nextBoards[0]?.id || null;
  if (nextActiveId) await store.put(nextActiveId, ACTIVE_BOARD_KEY);
  await tx.done;
}

// ── Migration from localStorage ────────────────────────────────────────────────

export async function migrateFromLocalStorage(db) {
  const lsBoards = safeParseArray(localStorage.getItem(BOARDS_KEY));
  const lsActiveId = localStorage.getItem(ACTIVE_BOARD_KEY);

  // Legacy single-board keys (pre multi-board)
  const legacyColumns = safeParseArray(localStorage.getItem(LEGACY_COLUMNS_KEY));
  const legacyTasks = safeParseArray(localStorage.getItem(LEGACY_TASKS_KEY));

  let boards = lsBoards;

  if (!boards && (legacyColumns || legacyTasks)) {
    // Oldest migration path: single-board localStorage → IDB default board
    boards = [{ id: DEFAULT_BOARD_ID, name: 'Default Board', createdAt: nowIso() }];
    const tx = db.transaction([KV_STORE, READ_MODEL_STORE], 'readwrite');
    const store = tx.objectStore(KV_STORE);
    const readModel = tx.objectStore(READ_MODEL_STORE);
    await store.put(boards, BOARDS_KEY);
    await store.put(DEFAULT_BOARD_ID, ACTIVE_BOARD_KEY);
    await readModel.put(legacyColumns || defaultColumns(), readModelKeyFor(DEFAULT_BOARD_ID, 'columns'));
    await readModel.put(legacyTasks || [], readModelKeyFor(DEFAULT_BOARD_ID, 'tasks'));
    await store.put(defaultSettings(), keyFor(DEFAULT_BOARD_ID, 'settings'));
    await tx.done;

    localStorage.removeItem(LEGACY_COLUMNS_KEY);
    localStorage.removeItem(LEGACY_TASKS_KEY);
    localStorage.removeItem(BOARDS_KEY);
    localStorage.removeItem(ACTIVE_BOARD_KEY);
    return;
  }

  if (!boards) return;

  // Multi-board localStorage → IDB
  const tx = db.transaction([KV_STORE, READ_MODEL_STORE], 'readwrite');
  const store = tx.objectStore(KV_STORE);
  const readModel = tx.objectStore(READ_MODEL_STORE);

  await store.put(boards, BOARDS_KEY);
  if (lsActiveId) await store.put(lsActiveId, ACTIVE_BOARD_KEY);

  for (const board of boards) {
    const tasks = safeParseArray(localStorage.getItem(keyFor(board.id, 'tasks'))) || [];
    const columns = safeParseArray(localStorage.getItem(keyFor(board.id, 'columns'))) || [];
    const settings = safeParseObject(localStorage.getItem(keyFor(board.id, 'settings')));

    await readModel.put(tasks, readModelKeyFor(board.id, 'tasks'));
    await readModel.put(columns, readModelKeyFor(board.id, 'columns'));
    if (settings) await store.put(settings, keyFor(board.id, 'settings'));

    localStorage.removeItem(keyFor(board.id, 'tasks'));
    localStorage.removeItem(keyFor(board.id, 'columns'));
    localStorage.removeItem(keyFor(board.id, 'settings'));
  }

  await tx.done;
  localStorage.removeItem(BOARDS_KEY);
  localStorage.removeItem(ACTIVE_BOARD_KEY);
}
