import { nowIso } from './utils.js';
import { DONE_COLUMN_ID, isDoneColumn } from './constants.js';
import { normalizeRelationships } from './normalize.js';
import { normalizeKeyPoints } from './agile.js';
import { scheduleReadModelPersist } from './idb-store.js';
import { ensureBoardsInitialized, getActiveBoardId } from './storage-boards.js';
import { defaultColumns } from './storage-defaults.js';
import { normalizeColumn, ensureFixedColumns } from './storage-normalize.js';
import {
  state,
  taskCacheByBoard,
  safeParseArray,
  DEFAULT_BOARD_ID,
  emitLocalChange,
} from './storage-state.js';

// ── Columns ────────────────────────────────────────────────────────────────────

export function getDoneColumnId() {
  const columns = loadColumns();
  return columns.find((column) => isDoneColumn(column))?.id || DONE_COLUMN_ID;
}

export function isDoneColumnId(columnId) {
  const id = typeof columnId === 'string' ? columnId.trim() : '';
  if (!id) return false;
  return id === DONE_COLUMN_ID || id === getDoneColumnId();
}

export function loadColumns() {
  ensureBoardsInitialized();
  const boardId = getActiveBoardId() || DEFAULT_BOARD_ID;
  const raw = state.columns[boardId];
  const parsed = safeParseArray(raw);
  if (parsed) {
    const live = parsed.filter(c => !c.deleted);
    const normalized = ensureFixedColumns(live.map(normalizeColumn));
    // Persist back if done column was added (length check uses live count vs normalized).
    if (!raw || !Array.isArray(raw) || normalized.length !== live.length) {
      // Merge normalized live columns back with deleted records for persistence
      const deleted = parsed.filter(c => c.deleted);
      const merged = [...normalized, ...deleted];
      state.columns[boardId] = merged;
      scheduleReadModelPersist(boardId, 'columns', merged);
    }
    return normalized;
  }
  return ensureFixedColumns(defaultColumns().map(normalizeColumn));
}

export function saveColumns(columns) {
  ensureBoardsInitialized();
  const boardId = getActiveBoardId() || DEFAULT_BOARD_ID;
  state.columns[boardId] = columns;
  scheduleReadModelPersist(boardId, 'columns', columns);
  emitLocalChange(boardId, 'column');
}

// ── Tasks ──────────────────────────────────────────────────────────────────────

export function loadTasks() {
  ensureBoardsInitialized();
  const boardId = getActiveBoardId() || DEFAULT_BOARD_ID;
  const raw = state.tasks[boardId];
  const parsed = safeParseArray(raw);

  if (parsed) {
    let didChange = false;
    const normalized = parsed.map((t) => {
      const task = t && typeof t === 'object' ? { ...t } : t;
      if (!task || typeof task !== 'object') return task;

      // Detach the mutable nested fields from the stored read model. Feature
      // modules mutate the loaded task in place (e.g. columnHistory.push); since
      // the projection is now the sole writer of state (ADR-0005), those edits
      // must not leak back into the read model and double-apply with events.
      if (Array.isArray(task.columnHistory)) task.columnHistory = task.columnHistory.map((e) => ({ ...e }));
      if (Array.isArray(task.relationships)) task.relationships = task.relationships.map((r) => ({ ...r }));

      const isDone = isDoneColumnId(task.column);
      const hasDoneDate = typeof task.doneDate === 'string' && task.doneDate.trim() !== '';
      const changeDate = typeof task.changeDate === 'string' && task.changeDate.trim() ? task.changeDate.trim() : '';
      const creationDate = typeof task.creationDate === 'string' && task.creationDate.trim() ? task.creationDate.trim() : '';

      if (isDone && !hasDoneDate) {
        const inferred = changeDate ? changeDate : creationDate;
        if (inferred) {
          task.doneDate = inferred;
          didChange = true;
        }
      }

      if (!isDone && hasDoneDate) {
        delete task.doneDate;
        didChange = true;
      }

      const rawHistory = task.columnHistory;
      const history = Array.isArray(rawHistory) ? rawHistory : null;
      const seededAt = changeDate || creationDate || nowIso();
      const seededColumn = typeof task.column === 'string' ? task.column.trim() : '';

      if (!history || history.length === 0) {
        if (seededAt && seededColumn) {
          task.columnHistory = [{ column: seededColumn, at: seededAt }];
          didChange = true;
        }
      } else {
        const cleaned = history
          .map((e) => {
            const column = typeof e?.column === 'string' ? e.column.trim() : '';
            const at = typeof e?.at === 'string' ? e.at.trim() : '';
            if (!column || !at) return null;
            return { column, at };
          })
          .filter(Boolean);

        if (cleaned.length === 0) {
          if (seededAt && seededColumn) {
            task.columnHistory = [{ column: seededColumn, at: seededAt }];
            didChange = true;
          }
        } else if (cleaned.length !== history.length) {
          task.columnHistory = cleaned;
          didChange = true;
        }
      }

      const nextRelationships = normalizeRelationships(task.relationships);
      if (JSON.stringify(task.relationships) !== JSON.stringify(nextRelationships)) {
        task.relationships = nextRelationships;
        didChange = true;
      }

      if (Object.prototype.hasOwnProperty.call(task, 'acceptanceCriteria')) {
        if (!Array.isArray(task.keyPoints)) task.keyPoints = normalizeKeyPoints(task.acceptanceCriteria);
        delete task.acceptanceCriteria;
        didChange = true;
      }

      return task;
    });

    if (didChange) {
      state.tasks[boardId] = normalized;
      scheduleReadModelPersist(boardId, 'tasks', normalized);
    }

    taskCacheByBoard.set(boardId, normalized);
    return normalized.filter(t => !t.deleted);
  }

  // Empty state: return stable in-memory defaults for the session.
  const cached = taskCacheByBoard.get(boardId);
  if (Array.isArray(cached)) return cached.filter(t => !t.deleted);

  const defaults = [];
  taskCacheByBoard.set(boardId, defaults);
  return defaults;
}

export function saveTasks(tasks) {
  ensureBoardsInitialized();
  const boardId = getActiveBoardId() || DEFAULT_BOARD_ID;
  const normalized = (Array.isArray(tasks) ? tasks : []).map((task) => ({
    ...task
  }));
  state.tasks[boardId] = normalized;
  taskCacheByBoard.set(boardId, normalized);
  scheduleReadModelPersist(boardId, 'tasks', normalized);
  emitLocalChange(boardId, 'task');
}
