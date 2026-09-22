import { generateUUID, nowIso } from './utils.js';
import {
  schedulePersist,
  scheduleDelete,
  scheduleReadModelPersist,
  scheduleReadModelDelete,
  keyFor,
} from './idb-store.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';
import { defaultBoardData } from './storage-defaults.js';
import {
  ensureBoardsInitialized,
  listBoards,
  saveBoards,
  markBoardsEmptied,
  clearBoardsEmptied,
  emitBoardScaffoldEvents,
} from './storage-boards.js';
import { state, taskCacheByBoard, ACTIVE_BOARD_KEY } from './storage-state.js';

export function createBoard(name) {
  ensureBoardsInitialized();
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const boardName = trimmed || 'Untitled board';
  const boards = listBoards();

  const id = generateUUID();
  const defaults = defaultBoardData(false);
  const board = { id, name: boardName, createdAt: nowIso() };
  saveBoards([...boards, board]);
  clearBoardsEmptied();

  state.columns[id] = defaults.columns;
  state.tasks[id] = [];
  state.settings[id] = defaults.settings;

  scheduleReadModelPersist(id, 'columns', state.columns[id]);
  scheduleReadModelPersist(id, 'tasks', state.tasks[id]);
  schedulePersist(keyFor(id, 'settings'), state.settings[id]);

  state.activeBoardId = id;
  schedulePersist(ACTIVE_BOARD_KEY, id);
  scheduleDomainEvent({
    type: 'board.created',
    boardId: id,
    entityId: id,
    payload: { board }
  });
  emitBoardScaffoldEvents(id, { columns: defaults.columns });

  return board;
}

export function renameBoard(boardId, newName) {
  ensureBoardsInitialized();
  const id = typeof boardId === 'string' ? boardId : '';
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (!id || !name) return false;

  const boards = listBoards();
  if (!boards.some((b) => b.id === id)) return false;

  const updated = boards.map((b) => (b.id === id ? { ...b, name } : b));
  saveBoards(updated);
  scheduleDomainEvent({
    type: 'board.updated',
    boardId: id,
    entityId: id,
    payload: { fields: { name } }
  });
  return true;
}

const BOARD_ITERATION_FIELDS = ['startDate', 'endDate', 'goal'];

export function updateBoardFields(boardId, fields) {
  ensureBoardsInitialized();
  const id = typeof boardId === 'string' ? boardId : '';
  if (!id || !fields || typeof fields !== 'object') return false;

  const allowed = {};
  for (const key of BOARD_ITERATION_FIELDS) {
    if (fields[key] === undefined) continue;
    allowed[key] = typeof fields[key] === 'string' ? fields[key].trim() : '';
  }
  if (Object.keys(allowed).length === 0) return false;

  const boards = listBoards();
  if (!boards.some((b) => b.id === id)) return false;

  saveBoards(boards.map((b) => (b.id === id ? { ...b, ...allowed } : b)));
  scheduleDomainEvent({
    type: 'board.updated',
    boardId: id,
    entityId: id,
    payload: { fields: allowed }
  });
  return true;
}

export function deleteBoard(boardId) {
  ensureBoardsInitialized();
  const id = typeof boardId === 'string' ? boardId : '';
  if (!id) return false;
  const boards = listBoards();
  if (!boards.some((b) => b.id === id)) return false;

  const remaining = boards.filter((b) => b.id !== id);
  saveBoards(remaining);

  // Remove per-board state
  delete state.tasks[id];
  delete state.columns[id];
  delete state.settings[id];
  taskCacheByBoard.delete(id);

  // Remove from IDB
  scheduleReadModelDelete(id, 'tasks');
  scheduleReadModelDelete(id, 'columns');
  scheduleDelete(keyFor(id, 'settings'));

  if (state.activeBoardId === id) {
    const nextActive = remaining[0]?.id || null;
    state.activeBoardId = nextActive;
    if (nextActive) schedulePersist(ACTIVE_BOARD_KEY, nextActive);
  }

  if (remaining.length === 0) markBoardsEmptied();

  scheduleDomainEvent({
    type: 'board.deleted',
    boardId: id,
    entityId: id,
    payload: {}
  });
  return true;
}
