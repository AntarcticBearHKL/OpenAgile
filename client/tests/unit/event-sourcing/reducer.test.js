import { expect, test, vi } from 'vitest';
import { applyEvent, createProjectionState } from '../../../src/modules/reducer.js';

function event(overrides) {
  return {
    id: overrides.id || crypto.randomUUID(),
    type: overrides.type,
    hlc: overrides.hlc || { wallTime: 1000, counter: 0, nodeId: 'node-a' },
    at: overrides.at || '2026-05-26T00:00:00.000Z',
    actor: overrides.actor || { type: 'human', id: null },
    scope: overrides.scope || 'board',
    board_id: Object.hasOwn(overrides, 'board_id') ? overrides.board_id : 'board-a',
    entity_id: overrides.entity_id || 'task-a',
    payload: overrides.payload || {}
  };
}

test('applyEvent is idempotent by event id', () => {
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Before', column: 'todo', columnHistory: [] }]
  });
  const update = event({
    id: 'event-a',
    type: 'task.updated',
    payload: { fields: { title: 'After' } }
  });

  const once = applyEvent(state, update);
  const twice = applyEvent(once, update);

  expect(twice).toEqual(once);
  expect(twice.tasks).toEqual([{ id: 'task-a', title: 'After', column: 'todo', columnHistory: [] }]);
});

test('task.deleted tombstones prevent later task updates from resurrecting the task', () => {
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Before', column: 'todo', columnHistory: [] }]
  });

  const deleted = applyEvent(state, event({ id: 'delete-a', type: 'task.deleted' }));
  const updated = applyEvent(deleted, event({
    id: 'update-a',
    type: 'task.updated',
    payload: { fields: { title: 'After' } }
  }));

  expect(updated.tasks).toEqual([]);
  expect(updated.taskTombstones.has('task-a')).toBe(true);
});

test('task.updated merges different field events on the same task', () => {
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Before', description: '', column: 'todo', columnHistory: [] }]
  });

  const withTitle = applyEvent(state, event({
    id: 'title-a',
    type: 'task.updated',
    payload: { fields: { title: 'After' } }
  }));
  const withDescription = applyEvent(withTitle, event({
    id: 'description-a',
    type: 'task.updated',
    payload: { fields: { description: 'Details' } }
  }));

  expect(withDescription.tasks[0]).toMatchObject({
    id: 'task-a',
    title: 'After',
    description: 'Details'
  });
});

test('task.moved updates column order and columnHistory', () => {
  const state = createProjectionState({
    tasks: [
      { id: 'task-a', title: 'A', column: 'todo', order: 1, columnHistory: [{ column: 'todo', at: '2026-05-25T00:00:00.000Z' }] },
      { id: 'task-b', title: 'B', column: 'doing', order: 1, columnHistory: [] }
    ]
  });

  const moved = applyEvent(state, event({
    id: 'move-a',
    type: 'task.moved',
    payload: {
      from_column: 'todo',
      to_column: 'doing',
      order: [
        { id: 'task-a', column: 'doing', order: 1 },
        { id: 'task-b', column: 'doing', order: 2 }
      ]
    }
  }));

  expect(moved.tasks.find((task) => task.id === 'task-a')).toMatchObject({
    column: 'doing',
    order: 1,
    columnHistory: [
      { column: 'todo', at: '2026-05-25T00:00:00.000Z' },
      { column: 'doing', at: '2026-05-26T00:00:00.000Z' }
    ]
  });
  expect(moved.tasks.find((task) => task.id === 'task-b')).toMatchObject({ column: 'doing', order: 2 });
});

test('unknown event types warn and leave projection unchanged', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Before', column: 'todo', columnHistory: [] }]
  });

  const next = applyEvent(state, event({ id: 'unknown-a', type: 'unknown.event' }));

  expect(next).toEqual(state);
  expect(warn).toHaveBeenCalledWith('Unknown event type: unknown.event');
});

test('legacy label events replay without throwing and leave the projection unchanged', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Task', column: 'todo', columnHistory: [] }]
  });

  const created = applyEvent(state, event({
    id: 'legacy-label-create',
    type: 'label.created',
    entity_id: 'label-a',
    payload: { label: { name: 'Bug', color: '#ff0000', group: 'Type' } }
  }));
  const updated = applyEvent(created, event({
    id: 'legacy-label-update',
    type: 'label.updated',
    entity_id: 'label-a',
    payload: { fields: { name: 'Feature' } }
  }));
  const deleted = applyEvent(updated, event({
    id: 'legacy-label-delete',
    type: 'label.deleted',
    entity_id: 'label-a'
  }));

  expect(created).toEqual(state);
  expect(updated).toEqual(created);
  expect(deleted).toEqual(updated);
  expect(state.labels).toBeUndefined();
  expect(warn).toHaveBeenCalledWith('Unknown event type: label.created');
});

test('unknown removed event types leave the model untouched', () => {
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Task', column: 'todo', columnHistory: [] }]
  });

  const ignored = applyEvent(state, event({
    id: 'label-add',
    type: 'label.added_to_task',
    entity_id: 'task-a',
    payload: { label_id: 'label-a' }
  }));

  expect(ignored.tasks).toEqual(state.tasks);
});

test('column events create update delete and reorder columns', () => {
  const created = applyEvent(createProjectionState(), event({
    id: 'column-create',
    type: 'column.created',
    entity_id: 'column-a',
    payload: { column: { name: 'Todo', color: '#000000', order: 2 } }
  }));
  const updated = applyEvent(created, event({
    id: 'column-update',
    type: 'column.updated',
    entity_id: 'column-a',
    payload: { fields: { name: 'Doing' } }
  }));
  expect(updated.columns).toEqual([{ id: 'column-a', name: 'Doing', color: '#000000', order: 2 }]);
});

test('settings.updated folds board settings', () => {
  const boardSettings = applyEvent(createProjectionState(), event({
    id: 'settings-board',
    type: 'settings.updated',
    payload: { fields: { showPriority: false } }
  }));

  expect(boardSettings.settings).toEqual({ showPriority: false });
});

test('relationship events update embedded task collections', () => {
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Task', relationships: [], column: 'todo', columnHistory: [] }]
  });

  const withRelationship = applyEvent(state, event({
    id: 'relationship-add',
    type: 'relationship.added',
    payload: { relationship: { type: 'related', targetTaskId: 'task-b' } }
  }));
  const withoutRelationship = applyEvent(withRelationship, event({
    id: 'relationship-remove',
    type: 'relationship.removed',
    payload: { targetTaskId: 'task-b', relationship_type: 'related' }
  }));

  expect(withRelationship.tasks[0].relationships).toEqual([{ type: 'related', targetTaskId: 'task-b' }]);
  expect(withoutRelationship.tasks[0].relationships).toEqual([]);
});

test('createProjectionState seeds global groups boardGroups and skills slices', () => {
  const state = createProjectionState();

  expect(state.groups).toEqual([]);
  expect(state.boardGroups).toEqual({});
  expect(state.skills).toEqual([]);
});

test('group events create update and soft delete groups', () => {
  const created = applyEvent(createProjectionState(), event({
    id: 'group-create',
    type: 'group.created',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a',
    payload: { group: { name: 'Alpha', order: 1, collapsed: false, prefixCollapsed: true } }
  }));
  const updated = applyEvent(created, event({
    id: 'group-update',
    type: 'group.updated',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a',
    payload: { fields: { name: 'Beta' } }
  }));
  const deleted = applyEvent(updated, event({
    id: 'group-delete',
    type: 'group.deleted',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a'
  }));

  expect(created.groups).toEqual([{ id: 'group-a', name: 'Alpha', order: 1, collapsed: false, prefixCollapsed: true }]);
  expect(updated.groups).toEqual([{ id: 'group-a', name: 'Beta', order: 1, collapsed: false, prefixCollapsed: true }]);
  expect(deleted.groups).toEqual([{ id: 'group-a', name: 'Beta', order: 1, collapsed: false, prefixCollapsed: true, deleted: true }]);
});

test('group.created is idempotent by group id', () => {
  const first = applyEvent(createProjectionState(), event({
    id: 'group-create-1',
    type: 'group.created',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a',
    payload: { group: { name: 'Alpha', order: 1 } }
  }));
  const second = applyEvent(first, event({
    id: 'group-create-2',
    type: 'group.created',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a',
    payload: { group: { name: 'Duplicate', order: 9 } }
  }));

  expect(second.groups).toEqual([{ id: 'group-a', name: 'Alpha', order: 1 }]);
});

test('group.deleted unbinds its boards without removing the boardGroups keys', () => {
  const state = createProjectionState({
    groups: [{ id: 'group-a', name: 'Alpha', order: 1 }],
    boardGroups: { 'board-a': 'group-a', 'board-b': 'group-b' }
  });

  const next = applyEvent(state, event({
    id: 'group-delete',
    type: 'group.deleted',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a'
  }));

  expect(next.boardGroups).toEqual({ 'board-a': null, 'board-b': 'group-b' });
  expect(Object.hasOwn(next.boardGroups, 'board-a')).toBe(true);
});

test('board.group.assigned binds and unbinds boards preserving null', () => {
  const bound = applyEvent(createProjectionState(), event({
    id: 'board-group-bind',
    type: 'board.group.assigned',
    scope: 'global',
    board_id: null,
    entity_id: 'board-a',
    payload: { group_id: 'group-a' }
  }));
  const unbound = applyEvent(bound, event({
    id: 'board-group-unbind',
    type: 'board.group.assigned',
    scope: 'global',
    board_id: null,
    entity_id: 'board-a',
    payload: { group_id: null }
  }));

  expect(bound.boardGroups).toEqual({ 'board-a': 'group-a' });
  expect(unbound.boardGroups).toEqual({ 'board-a': null });
  expect(Object.hasOwn(unbound.boardGroups, 'board-a')).toBe(true);
});

test('skill events create update and soft delete skills', () => {
  const created = applyEvent(createProjectionState(), event({
    id: 'skill-create',
    type: 'skill.created',
    scope: 'global',
    board_id: null,
    entity_id: 'skill-a',
    payload: { skill: { name: 'Deploy', description: 'Ship it', content: 'steps', order: 2 } }
  }));
  const updated = applyEvent(created, event({
    id: 'skill-update',
    type: 'skill.updated',
    scope: 'global',
    board_id: null,
    entity_id: 'skill-a',
    payload: { fields: { content: 'new steps' } }
  }));
  const deleted = applyEvent(updated, event({
    id: 'skill-delete',
    type: 'skill.deleted',
    scope: 'global',
    board_id: null,
    entity_id: 'skill-a'
  }));

  expect(created.skills).toEqual([{ id: 'skill-a', name: 'Deploy', description: 'Ship it', content: 'steps', order: 2 }]);
  expect(updated.skills).toEqual([{ id: 'skill-a', name: 'Deploy', description: 'Ship it', content: 'new steps', order: 2 }]);
  expect(deleted.skills).toEqual([{ id: 'skill-a', name: 'Deploy', description: 'Ship it', content: 'new steps', order: 2, deleted: true }]);
});

test('global event dedup leaves projection unchanged on replay', () => {
  const state = createProjectionState();
  const create = event({
    id: 'group-create',
    type: 'group.created',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a',
    payload: { group: { name: 'Alpha', order: 1 } }
  });

  const once = applyEvent(state, create);
  const twice = applyEvent(once, create);
  const replayWithDifferentFields = applyEvent(twice, event({
    id: 'group-create',
    type: 'group.updated',
    scope: 'global',
    board_id: null,
    entity_id: 'group-a',
    payload: { fields: { name: 'Stale' } }
  }));

  expect(twice).toEqual(once);
  expect(replayWithDifferentFields).toEqual(twice);
  expect(replayWithDifferentFields.groups).toEqual([{ id: 'group-a', name: 'Alpha', order: 1 }]);
});

test('subtask events are no longer applied to tasks', () => {
  const state = createProjectionState({
    tasks: [{ id: 'task-a', title: 'Task', column: 'todo', columnHistory: [] }]
  });

  const next = applyEvent(state, event({
    id: 'subtask-add',
    type: 'subtask.added',
    payload: { subtask: { id: 'sub-a', text: 'Check', completed: false } }
  }));

  expect(next.tasks[0].subTasks).toBeUndefined();
});
