import { nowIso } from './utils.js';
import { NO_BOARDS_KEY } from './constants.js';
import { schedulePersist, scheduleReadModelPersist, keyFor } from './idb-store.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';
import { readModelProjector } from './storage-projector.js';
import { stableDefaultBoardData } from './storage-defaults.js';
import {
  state,
  BOARDS_KEY,
  ACTIVE_BOARD_KEY,
  STABLE_DEFAULT_BOARD_ID,
} from './storage-state.js';

function boardsEmptied() {
  try { return localStorage.getItem(NO_BOARDS_KEY) === '1'; } catch { return false; }
}

export function markBoardsEmptied() {
  try { localStorage.setItem(NO_BOARDS_KEY, '1'); } catch { /* ignore */ }
}

export function clearBoardsEmptied() {
  try { localStorage.removeItem(NO_BOARDS_KEY); } catch { /* ignore */ }
}

// ── Boards ─────────────────────────────────────────────────────────────────────

export function listBoards() {
  const boards = state.boards;
  if (!Array.isArray(boards)) return [];
  return boards
    // `deleted` is the reducer's soft-delete tombstone (applyBoardDeleted). Local
    // deleteBoard() hard-removes, but a device replaying board.deleted from the
    // event log only gets the flag — without this filter the board resurrects.
    .filter((b) => b && typeof b.id === 'string' && !b.deleted)
    .map((b) => ({
      ...b,
      id: b.id,
      name: typeof b.name === 'string' ? b.name : 'Untitled board',
      createdAt: typeof b.createdAt === 'string' ? b.createdAt : undefined
    }));
}

export function getBoardById(boardId) {
  const id = typeof boardId === 'string' ? boardId : '';
  if (!id) return null;
  return listBoards().find((b) => b.id === id) || null;
}

export function getActiveBoardName() {
  const id = getActiveBoardId();
  const board = id ? getBoardById(id) : null;
  if (!board) return listBoards().length === 0 ? 'OpenAgile' : 'Untitled board';
  const name = typeof board.name === 'string' ? board.name.trim() : '';
  return name || 'Untitled board';
}

export function saveBoards(boards) {
  state.boards = boards;
  schedulePersist(BOARDS_KEY, boards);
}

export function mergeBoardsFromRemote(remoteBoards) {
  const incoming = Array.isArray(remoteBoards) ? remoteBoards : [];
  if (incoming.length === 0) return listBoards();

  const merged = new Map((state.boards || []).map((board) => [board.id, board]));
  for (const board of incoming) {
    if (!board || typeof board.id !== 'string') continue;
    merged.set(board.id, {
      ...merged.get(board.id),
      ...board,
      name: typeof board.name === 'string' ? board.name : merged.get(board.id)?.name || 'Untitled board'
    });
  }

  const nextBoards = [...merged.values()];
  saveBoards(nextBoards);
  return listBoards();
}

export function getActiveBoardId() {
  const boards = listBoards();
  const stored = state.activeBoardId;
  if (stored && boards.some((b) => b.id === stored)) return stored;
  return boards[0]?.id || null;
}

export function setActiveBoardId(boardId) {
  const id = typeof boardId === 'string' ? boardId : '';
  if (!id) return;
  const boards = listBoards();
  if (!boards.some((b) => b.id === id)) return;
  state.activeBoardId = id;
  schedulePersist(ACTIVE_BOARD_KEY, id);
}

export function ensureBoardsInitialized() {
  // Local mutations emit events that the projection folds into the read model
  // synchronously (ADR-0005). Register here so every storage entry point — not
  // just initStorage() — has the sole writer subscribed (e.g. unit tests that
  // never call initStorage). Idempotent.
  readModelProjector.register();
  const boards = listBoards();
  if (boards.length > 0) {
    if (!getActiveBoardId()) setActiveBoardId(boards[0].id);
    return;
  }

  // Every board was deliberately deleted — don't resurrect a default one.
  if (boardsEmptied()) return;

  // First run: seed default board directly into state (IDB is either empty or
  // not yet initialised — migration from localStorage is handled in initStorage()).
  clearBoardsEmptied();
  const created = nowIso();
  const boardId = STABLE_DEFAULT_BOARD_ID;
  const defaults = stableDefaultBoardData();
  const board = { id: boardId, name: 'Default Board', createdAt: created };
  state.boards = [board];
  state.activeBoardId = boardId;
  state.columns[boardId] = defaults.columns;
  state.tasks[boardId] = defaults.tasks;
  state.settings[boardId] = defaults.settings;

  schedulePersist(BOARDS_KEY, state.boards);
  schedulePersist(ACTIVE_BOARD_KEY, boardId);
  scheduleReadModelPersist(boardId, 'columns', state.columns[boardId]);
  scheduleReadModelPersist(boardId, 'tasks', state.tasks[boardId]);
  schedulePersist(keyFor(boardId, 'settings'), state.settings[boardId]);

  // Emit the scaffold to the event log so a second device reconstructs the
  // default board's columns (and converges with this one via the stable
  // ids above). Demo tasks are deliberately not emitted (local-only flavour).
  scheduleDomainEvent({
    type: 'board.created',
    boardId,
    entityId: boardId,
    payload: { board }
  });
  emitBoardScaffoldEvents(boardId, { columns: defaults.columns });
}

// Emit a column.created event for every column in a freshly scaffolded board,
// so a remote device can reconstruct the board's contents from the event log
// alone (the board.created event only carries the board row). entity_id matches
// each column id so live projection and catch-up replay dedup against the
// locally written read-model.
export function emitBoardScaffoldEvents(boardId, { columns = [] } = {}) {
  for (const column of columns) {
    scheduleDomainEvent({
      type: 'column.created',
      boardId,
      entityId: column.id,
      payload: { column }
    });
  }
}
