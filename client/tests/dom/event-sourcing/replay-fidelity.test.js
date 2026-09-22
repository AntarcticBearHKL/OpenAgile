// Replay fidelity: the events a mutation emits must, when replayed from the
// pre-mutation projection, reproduce the same read model the live mutation
// produced. This guards ADR-0005 (reducer is the sole read-model writer) — if
// an event stream is incomplete, removing the direct save*() write would lose
// data locally and never propagate the missing change cross-device.
import { beforeEach, expect, test } from 'vitest';
import { deleteDB } from 'idb';
import { EVENT_EMITTED, on, off } from '../../../src/modules/events.js';
import {
  createBoard,
  getActiveBoardId,
  initStorage,
  saveColumns,
  saveTasks,
  loadTasks,
  _flushPersistsForTesting,
  _resetStorageForTesting
} from '../../../src/modules/storage.js';
import { addTask } from '../../../src/modules/tasks.js';
import { updateTask } from '../../../src/modules/task-update.js';
import { scheduleDomainEvent } from '../../../src/modules/event-sourcing/emitter.js';
import { applyEvents, createProjectionState } from '../../../src/modules/reducer.js';
import { DONE_COLUMN_ID, DONE_COLUMN_ROLE } from '../../../src/modules/constants.js';

const COLUMNS = [
  { id: 'todo', name: 'To Do', color: '#3b82f6', order: 1 },
  { id: 'doing', name: 'Doing', color: '#f59e0b', order: 2 },
  { id: DONE_COLUMN_ID, name: 'Done', color: '#16a34a', order: 3, role: DONE_COLUMN_ROLE }
];

function orderById(tasks) {
  return Object.fromEntries(tasks.map((task) => [task.id, { column: task.column, order: task.order }]));
}

const DB_NAME = 'openagile-db';

beforeEach(async () => {
  _resetStorageForTesting();
  await deleteDB(DB_NAME);
  await initStorage();
  createBoard('Replay');
  await _flushPersistsForTesting();
});

async function collectEvents(action) {
  const events = [];
  const handler = (customEvent) => events.push(customEvent.detail);
  on(EVENT_EMITTED, handler);
  action();
  await _flushPersistsForTesting();
  off(EVENT_EMITTED, handler);
  return events;
}

function relsById(tasks) {
  return Object.fromEntries(
    tasks.map((task) => [
      task.id,
      (Array.isArray(task.relationships) ? task.relationships : [])
        .map((rel) => `${rel.type}:${rel.targetTaskId}`)
        .sort()
    ])
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('updateTask relationship change replays the inverse on the target task', async () => {
  const seed = [
    { id: 'task-a', title: 'A', column: 'todo', relationships: [], columnHistory: [] },
    { id: 'task-b', title: 'B', column: 'todo', relationships: [], columnHistory: [] }
  ];
  saveTasks(clone(seed));
  await _flushPersistsForTesting();

  const events = await collectEvents(() => {
    updateTask('task-a', 'A', '', { relationships: [{ type: 'related', targetTaskId: 'task-b' }] });
  });

  const replayed = applyEvents(createProjectionState({ tasks: clone(seed) }), events);
  expect(relsById(replayed.tasks)).toEqual(relsById(loadTasks()));
});

test('addTask replays the sibling reorder in the column', async () => {
  saveColumns(clone(COLUMNS));
  const seed = [
    { id: 'task-a', title: 'A', column: 'todo', order: 1, relationships: [], columnHistory: [] },
    { id: 'task-b', title: 'B', column: 'todo', order: 2, relationships: [], columnHistory: [] }
  ];
  saveTasks(clone(seed));
  await _flushPersistsForTesting();

  const events = await collectEvents(() => {
    addTask('New', '');
  });

  const replayed = applyEvents(createProjectionState({ tasks: clone(seed), columns: clone(COLUMNS) }), events);
  expect(orderById(replayed.tasks)).toEqual(orderById(loadTasks()));
});

function donePresenceById(tasks) {
  return Object.fromEntries(tasks.map((task) => [task.id, Boolean(task.doneDate)]));
}

test('moving a task into and out of the done column replays its doneDate', async () => {
  saveColumns(clone(COLUMNS));
  const seed = [
    { id: 'task-a', title: 'A', column: 'todo', order: 1, relationships: [], columnHistory: [] }
  ];
  saveTasks(clone(seed));
  await _flushPersistsForTesting();

  const toDone = await collectEvents(() => {
    scheduleDomainEvent({
      type: 'task.moved',
      boardId: getActiveBoardId(),
      entityId: 'task-a',
      payload: { order: [{ id: 'task-a', column: DONE_COLUMN_ID, order: 1 }] }
    });
  });
  let replayed = applyEvents(createProjectionState({ tasks: clone(seed), columns: clone(COLUMNS) }), toDone);
  expect(donePresenceById(replayed.tasks)).toEqual(donePresenceById(loadTasks()));
  expect(replayed.tasks[0].doneDate).toBeTruthy();

  const afterDone = clone(loadTasks());
  const toTodo = await collectEvents(() => {
    scheduleDomainEvent({
      type: 'task.moved',
      boardId: getActiveBoardId(),
      entityId: 'task-a',
      payload: { order: [{ id: 'task-a', column: 'todo', order: 1 }] }
    });
  });
  replayed = applyEvents(createProjectionState({ tasks: afterDone, columns: clone(COLUMNS) }), toTodo);
  expect(donePresenceById(replayed.tasks)).toEqual(donePresenceById(loadTasks()));
  expect(replayed.tasks[0].doneDate).toBeFalsy();
});
