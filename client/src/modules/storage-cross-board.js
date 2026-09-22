import { schedulePersist, scheduleReadModelPersist, keyFor } from './idb-store.js';
import {
  state,
  taskCacheByBoard,
  safeParseArray,
  safeParseObject,
} from './storage-state.js';

// ── Cross-board read helpers

export function loadTasksForBoard(boardId) {
  const raw = state.tasks[boardId];
  return (safeParseArray(raw) || []).filter(t => !t.deleted);
}

export function loadColumnsForBoard(boardId) {
  const raw = state.columns[boardId];
  return (safeParseArray(raw) || []).filter(c => !c.deleted);
}

export function loadSettingsForBoard(boardId) {
  const raw = state.settings[boardId];
  return safeParseObject(raw) || null;
}

export function loadDeletedTasksForBoard(boardId) {
  const raw = state.tasks[boardId];
  return (safeParseArray(raw) || []).filter(t => t.deleted === true);
}

export function loadDeletedColumnsForBoard(boardId) {
  const raw = state.columns[boardId];
  return (safeParseArray(raw) || []).filter(c => c.deleted === true);
}

// Hard-removes deleted records. The opts flags allow a caller to purge
// only some entity types — e.g. a sync push purges deleted column
// tombstones while leaving other deleted records for a later cleanup.
export function purgeDeleted(boardId, { tasks = true, columns = true } = {}) {
  if (tasks && state.tasks[boardId]) {
    const live = (safeParseArray(state.tasks[boardId]) || []).filter(t => !t.deleted);
    state.tasks[boardId] = live;
    taskCacheByBoard.set(boardId, live);
    scheduleReadModelPersist(boardId, 'tasks', live);
  }
  if (columns && state.columns[boardId]) {
    const live = (safeParseArray(state.columns[boardId]) || []).filter(c => !c.deleted);
    state.columns[boardId] = live;
    scheduleReadModelPersist(boardId, 'columns', live);
  }
}

export function saveColumnsForBoard(boardId, columns) {
  state.columns[boardId] = Array.isArray(columns) ? columns : [];
  scheduleReadModelPersist(boardId, 'columns', state.columns[boardId]);
}

export function saveTasksForBoard(boardId, tasks) {
  const normalized = (Array.isArray(tasks) ? tasks : []).map((task) => ({
    ...task,
  }));
  state.tasks[boardId] = normalized;
  taskCacheByBoard.set(boardId, normalized);
  scheduleReadModelPersist(boardId, 'tasks', normalized);
}

export function saveSettingsForBoard(boardId, settings) {
  state.settings[boardId] = settings && typeof settings === 'object' ? settings : {};
  schedulePersist(keyFor(boardId, 'settings'), state.settings[boardId]);
}
