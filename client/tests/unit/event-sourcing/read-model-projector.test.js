import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createReadModelProjector } from '../../../src/modules/event-sourcing/read-model-projector.js';
import { emit, on, off, EVENT_EMITTED, DATA_CHANGED } from '../../../src/modules/events.js';

const BOARD_ID = 'board-a';
const BOARDS_KEY = 'kanbanBoards';
const GLOBAL_KEY = 'openagile:global:projection';

function safeParseArray(value) {
  return Array.isArray(value) ? value : null;
}
function safeParseObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boardEvent(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    type: overrides.type || 'task.updated',
    hlc: overrides.hlc || { wallTime: 1000, counter: 0, nodeId: 'node-a' },
    at: '2026-05-26T00:00:00.000Z',
    actor: { type: 'human', id: null },
    scope: 'board',
    board_id: BOARD_ID,
    entity_id: overrides.entity_id || 'task-a',
    payload: overrides.payload || { fields: { title: 'After' } }
  };
}

function globalEvent(overrides = {}) {
  return {
    id: overrides.id || crypto.randomUUID(),
    type: overrides.type || 'group.created',
    hlc: overrides.hlc || { wallTime: 2000, counter: 0, nodeId: 'node-a' },
    at: '2026-05-26T00:00:00.000Z',
    actor: { type: 'human', id: null },
    scope: 'global',
    board_id: null,
    entity_id: overrides.entity_id || 'group-a',
    payload: overrides.payload || { group: { id: 'group-a', name: 'G', order: 1 } }
  };
}

function makeHarness() {
  const state = {
    boards: [{ id: BOARD_ID, name: 'A', createdAt: '2026-01-01T00:00:00.000Z' }],
    activeBoardId: BOARD_ID,
    tasks: { [BOARD_ID]: [{ id: 'task-a', title: 'Before', column: 'todo', columnHistory: [] }] },
    columns: { [BOARD_ID]: [{ id: 'todo', name: 'To Do' }] },
    settings: { [BOARD_ID]: {} }
  };
  const globalState = { groups: [], boardGroups: {}, skills: [] };
  const ctx = {
    state,
    globalState,
    globalKey: GLOBAL_KEY,
    taskCacheByBoard: new Map(),
    safeParseArray,
    safeParseObject,
    schedulePersist: vi.fn(),
    scheduleReadModelPersist: vi.fn(),
    checkAndScheduleSnapshot: vi.fn(),
    boardsKey: BOARDS_KEY
  };
  return { state, globalState, ctx, projector: createReadModelProjector(ctx) };
}

describe('createReadModelProjector', () => {
  let h;
  beforeEach(() => {
    h = makeHarness();
  });

  test('register() subscribes so an emitted board event projects into state and schedules read-model persist', () => {
    h.projector.register();
    emit(EVENT_EMITTED, boardEvent());

    expect(h.state.tasks[BOARD_ID][0].title).toBe('After');
    expect(h.ctx.scheduleReadModelPersist).toHaveBeenCalledWith(BOARD_ID, 'tasks', h.state.tasks[BOARD_ID]);
    expect(h.ctx.scheduleReadModelPersist).toHaveBeenCalledWith(BOARD_ID, 'columns', h.state.columns[BOARD_ID]);
    expect(h.ctx.taskCacheByBoard.get(BOARD_ID)).toBe(h.state.tasks[BOARD_ID]);

    h.projector.reset();
  });

  test('project() is idempotent by event id (dedup)', () => {
    const ev = boardEvent({ id: 'event-dup' });
    h.projector.project(ev);
    h.projector.project(ev);

    expect(h.ctx.scheduleReadModelPersist).toHaveBeenCalledTimes(2); // tasks/columns, once
  });

  test('register() is idempotent — a single emit projects once', () => {
    h.projector.register();
    h.projector.register();
    emit(EVENT_EMITTED, boardEvent({ id: 'once' }));

    expect(h.ctx.scheduleReadModelPersist).toHaveBeenCalledTimes(2);
    h.projector.reset();
  });

  test('reset() unsubscribes the handler and clears dedup state', () => {
    h.projector.register();
    h.projector.reset();
    emit(EVENT_EMITTED, boardEvent({ id: 'after-reset' }));
    expect(h.ctx.scheduleReadModelPersist).not.toHaveBeenCalled();

    // dedup set cleared: an id seen before reset projects again afterwards
    const ev = boardEvent({ id: 'seen' });
    h.projector.project(ev);
    expect(h.ctx.scheduleReadModelPersist).toHaveBeenCalledTimes(2);
    h.projector.reset();
    h.projector.project(ev);
    expect(h.ctx.scheduleReadModelPersist).toHaveBeenCalledTimes(4);
  });

  test('a global event folds into the global slices, persists that key and emits DATA_CHANGED', () => {
    h.projector.register();
    const changes = [];
    const onChange = (customEvent) => changes.push(customEvent.detail);
    on(DATA_CHANGED, onChange);

    emit(EVENT_EMITTED, globalEvent());

    expect(h.globalState.groups).toEqual([{ id: 'group-a', name: 'G', order: 1 }]);
    expect(h.ctx.schedulePersist).toHaveBeenCalledWith(GLOBAL_KEY, {
      groups: [{ id: 'group-a', name: 'G', order: 1 }],
      boardGroups: {},
      skills: []
    });
    expect(h.ctx.scheduleReadModelPersist).not.toHaveBeenCalled();
    expect(h.ctx.checkAndScheduleSnapshot).not.toHaveBeenCalled();
    expect(changes).toHaveLength(1);
    expect(changes[0].event.type).toBe('group.created');

    off(DATA_CHANGED, onChange);
    h.projector.reset();
  });

  test('a board-scoped board.created still writes the board read model', () => {
    h.projector.project(boardEvent({
      id: 'board-created',
      type: 'board.created',
      entity_id: 'board-b',
      payload: { board: { id: 'board-b', name: 'B' } }
    }));

    expect(h.state.boards.some((board) => board.id === 'board-b')).toBe(true);
    expect(h.ctx.scheduleReadModelPersist).toHaveBeenCalledWith(BOARD_ID, 'tasks', h.state.tasks[BOARD_ID]);
    expect(h.ctx.schedulePersist).not.toHaveBeenCalledWith(GLOBAL_KEY, expect.anything());
    expect(h.globalState.groups).toEqual([]);
  });
});
