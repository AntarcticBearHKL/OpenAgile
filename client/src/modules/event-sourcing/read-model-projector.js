import { applyEvent, createProjectionState } from '../reducer.js';
import { NO_BOARDS_KEY } from '../constants.js';
import { keyFor } from '../idb-store.js';
import { DATA_CHANGED, EVENT_EMITTED, emit, off, on } from '../events.js';

// Sole writer of the IDB read model (ADR-0005). Extracted from storage.js so the
// projection layer owns the read model independent of CRUD. storage.js wires the
// closure `state` + schedulers in via createReadModelProjector(); the reducer
// (applyEvent/createProjectionState) stays pure and is imported directly.
export function createReadModelProjector(ctx) {
  const {
    state,
    globalState,
    globalKey,
    taskCacheByBoard,
    safeParseArray,
    safeParseObject,
    schedulePersist,
    scheduleReadModelPersist,
    checkAndScheduleSnapshot,
    boardsKey
  } = ctx;

  const appliedDomainEventIds = new Set();
  let registered = false;
  let handler = null;

  function project(event) {
    if (!event?.id || appliedDomainEventIds.has(event.id)) return;
    appliedDomainEventIds.add(event.id);

    const scope = event.scope ?? 'board';
    if (scope === 'global') {
      const projected = applyEvent(createProjectionState({
        groups: globalState.groups,
        boardGroups: globalState.boardGroups,
        skills: globalState.skills
      }), event);
      globalState.groups = projected.groups;
      globalState.boardGroups = projected.boardGroups;
      globalState.skills = projected.skills;
      schedulePersist(globalKey, {
        groups: projected.groups,
        boardGroups: projected.boardGroups,
        skills: projected.skills
      });
      emit(DATA_CHANGED, { event });
      return;
    }

    const boardId = event.board_id;
    if (typeof boardId !== 'string' || !boardId) return;

    const projected = applyEvent(createProjectionState({
      boards: state.boards,
      tasks: safeParseArray(state.tasks[boardId]) || [],
      columns: safeParseArray(state.columns[boardId]) || [],
      settings: safeParseObject(state.settings[boardId]) || {}
    }), event);

    writeBoard(boardId, projected);
    if (event.type === 'board.created' || event.type === 'board.deleted') {
      syncBoardsEmptiedFlag(projected.boards);
    }
    checkAndScheduleSnapshot(boardId, projected, event.hlc);
    emit(DATA_CHANGED, { event });
  }

  function syncBoardsEmptiedFlag(boards) {
    try {
      if ((boards || []).some((board) => board && !board.deleted)) localStorage.removeItem(NO_BOARDS_KEY);
      else localStorage.setItem(NO_BOARDS_KEY, '1');
    } catch { /* ignore */ }
  }

  function writeBoard(boardId, projected) {
    state.boards = projected.boards;
    state.tasks[boardId] = projected.tasks;
    state.columns[boardId] = projected.columns;
    state.settings[boardId] = projected.settings;
    taskCacheByBoard.set(boardId, projected.tasks);
    schedulePersist(boardsKey, state.boards);
    scheduleReadModelPersist(boardId, 'tasks', projected.tasks);
    scheduleReadModelPersist(boardId, 'columns', projected.columns);
    schedulePersist(keyFor(boardId, 'settings'), projected.settings);
  }

  // Adopt a snapshot's projected state as the read model. Kept here rather than
  // in the sync layer so the projector stays the sole writer (ADR-0005). Boards
  // merge by id: a board-scoped snapshot carries the whole board list as of the
  // snapshotting device, which must not clobber boards only this device knows.
  function hydrate(key, snapshotState) {
    const known = new Map((state.boards || []).map((board) => [board.id, board]));
    for (const board of snapshotState.boards || []) {
      const existing = known.get(board.id);
      known.set(board.id, existing ? { ...existing, ...board } : board);
    }

    const mergedBoards = [...known.values()];
    writeBoard(key, {
      boards: mergedBoards,
      tasks: snapshotState.tasks || [],
      columns: snapshotState.columns || [],
      settings: snapshotState.settings || {}
    });
    syncBoardsEmptiedFlag(mergedBoards);
    emit(DATA_CHANGED, { hydrated: key });
  }

  function register() {
    if (registered) return;
    registered = true;
    handler = (event) => project(event.detail);
    on(EVENT_EMITTED, handler);
  }

  function reset() {
    appliedDomainEventIds.clear();
    if (handler) off(EVENT_EMITTED, handler);
    handler = null;
    registered = false;
  }

  return { register, reset, project, hydrate };
}
