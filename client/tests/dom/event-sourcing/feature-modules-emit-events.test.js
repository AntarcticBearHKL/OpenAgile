import { beforeEach, expect, test } from 'vitest';
import { deleteDB } from 'idb';
import { EVENT_EMITTED, on, off } from '../../../src/modules/events.js';
import { createBoard, initStorage, loadTasks, saveColumns, saveTasks, _flushPersistsForTesting, _resetStorageForTesting } from '../../../src/modules/storage.js';
import { addColumn } from '../../../src/modules/columns.js';
import { deleteTask } from '../../../src/modules/tasks.js';
import { updateTask } from '../../../src/modules/task-update.js';

const DB_NAME = 'openagile-db';

beforeEach(async () => {
  _resetStorageForTesting();
  await deleteDB(DB_NAME);
  await initStorage();
  createBoard('Events');
  await _flushPersistsForTesting();
});

function settleEvents() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function collectEvents(action) {
  const events = [];
  const handler = (customEvent) => events.push(customEvent.detail);
  on(EVENT_EMITTED, handler);
  action();
  await _flushPersistsForTesting();
  off(EVENT_EMITTED, handler);
  return events;
}

test('updateTask emits one task.updated event with HLC entity id and minimal fields', async () => {
  saveTasks([
    {
      id: 'task-a',
      title: 'Before',
      description: '',
      priority: 'none',
      dueDate: '',
      column: 'todo',
      relationships: [],
      subTasks: [],
      columnHistory: []
    }
  ]);

  const events = await collectEvents(() => {
    updateTask('task-a', 'After', '', 'none', '', 'todo', []);
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: 'task.updated',
    entity_id: 'task-a',
    scope: 'board',
    payload: { fields: { title: 'After' } }
  });
  expect(events[0].hlc).toEqual({
    wallTime: expect.any(Number),
    counter: expect.any(Number),
    nodeId: expect.any(String)
  });
});


test('updateTask emits relationship events for non-scalar changes and never a move', async () => {
  saveColumns([
    { id: 'todo', name: 'To Do', color: '#3b82f6', order: 1 },
    { id: 'doing', name: 'Doing', color: '#f59e0b', order: 2 }
  ]);
  saveTasks([
    { id: 'task-a', title: 'Task', column: 'todo', relationships: [], columnHistory: [] },
    { id: 'task-b', title: 'Other', column: 'todo', relationships: [], columnHistory: [] }
  ]);

  const events = await collectEvents(() => {
    updateTask('task-a', 'Task', '', {
      column: 'doing',
      relationships: [{ type: 'related', targetTaskId: 'task-b' }]
    });
  });

  expect(events.map((event) => event.type)).toEqual([
    'relationship.added',
    'relationship.added'
  ]);
  expect(loadTasks().find((task) => task.id === 'task-a').column).toBe('todo');
  // The forward link is emitted for task-a and its inverse for task-b, so the
  // bidirectional relationship replays from events alone (ADR-0005).
  const relationshipEvents = events.filter((event) => event.type === 'relationship.added');
  expect(relationshipEvents.map((event) => event.entity_id)).toEqual(['task-a', 'task-b']);
  expect(relationshipEvents[1].payload.relationship).toEqual({ type: 'related', targetTaskId: 'task-a' });
});

test('deleteTask emits task.deleted', async () => {
  saveTasks([{ id: 'task-a', title: 'Task', column: 'todo' }]);

  const events = await collectEvents(() => {
    deleteTask('task-a');
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'task.deleted', entity_id: 'task-a' });
});
