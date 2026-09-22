import { test, expect } from 'vitest';
import { columnEntryTime, compareColumnEntry } from '../../src/modules/task-helpers.js';
import { selectColumnRenderPlan } from '../../src/modules/board-filters.js';
import { FIXED_COLUMNS } from '../../src/modules/constants.js';

const BACKLOG_COLUMN_ID = FIXED_COLUMNS[0].id;
const HIL_COLUMN_ID = FIXED_COLUMNS[1].id;
const FINISHED_COLUMN_ID = FIXED_COLUMNS[4].id;

const ids = (tasks) => tasks.map((task) => task.id);

test('columnEntryTime uses the latest history entry that matches the current column', () => {
  const task = {
    id: 't1',
    column: 'column-b',
    columnHistory: [
      { column: 'column-a', at: '2026-01-01T00:00:00.000Z' },
      { column: 'column-b', at: '2026-01-02T00:00:00.000Z' },
      { column: 'column-a', at: '2026-01-03T00:00:00.000Z' },
      { column: 'column-b', at: '2026-01-04T00:00:00.000Z' }
    ]
  };

  expect(columnEntryTime(task)).toBe('2026-01-04T00:00:00.000Z');
});

test('columnEntryTime falls back to creationDate when no history entry matches the column', () => {
  expect(columnEntryTime({ id: 't1', column: 'column-a', creationDate: '2026-01-01T00:00:00.000Z' }))
    .toBe('2026-01-01T00:00:00.000Z');
  expect(columnEntryTime({
    id: 't2',
    column: 'column-b',
    creationDate: '2026-01-01T00:00:00.000Z',
    columnHistory: [{ column: 'column-a', at: '2026-01-02T00:00:00.000Z' }]
  })).toBe('2026-01-01T00:00:00.000Z');
});

test('needsDigest tasks sort to the front of their column', () => {
  const sorted = [
    { id: 'already-digested', column: 'column-a', creationDate: '2026-01-01T00:00:00.000Z' },
    { id: 'waiting-for-agent', column: 'column-a', creationDate: '2026-01-02T00:00:00.000Z', needsDigest: true }
  ].sort(compareColumnEntry);

  expect(ids(sorted)).toEqual(['waiting-for-agent', 'already-digested']);
});

test('tasks order by the time they entered the column, earliest first', () => {
  const sorted = [
    { id: 'third', column: 'column-a', columnHistory: [{ column: 'column-a', at: '2026-01-03T00:00:00.000Z' }] },
    { id: 'first', column: 'column-a', columnHistory: [{ column: 'column-a', at: '2026-01-01T00:00:00.000Z' }] },
    { id: 'second', column: 'column-a', columnHistory: [{ column: 'column-a', at: '2026-01-02T00:00:00.000Z' }] }
  ].sort(compareColumnEntry);

  expect(ids(sorted)).toEqual(['first', 'second', 'third']);
});

test('a task returning to a column is ordered by the return, not the first arrival', () => {
  const sorted = [
    {
      id: 'returned',
      column: 'column-a',
      columnHistory: [
        { column: 'column-a', at: '2026-01-01T00:00:00.000Z' },
        { column: 'column-b', at: '2026-01-02T00:00:00.000Z' },
        { column: 'column-a', at: '2026-01-05T00:00:00.000Z' }
      ]
    },
    { id: 'stayed', column: 'column-a', columnHistory: [{ column: 'column-a', at: '2026-01-03T00:00:00.000Z' }] }
  ].sort(compareColumnEntry);

  expect(ids(sorted)).toEqual(['stayed', 'returned']);
});

test('equal entry times break deterministically by id, whatever the input order', () => {
  const taskA = { id: 'aaa', column: 'column-a', creationDate: '2026-01-01T00:00:00.000Z' };
  const taskB = { id: 'bbb', column: 'column-a', creationDate: '2026-01-01T00:00:00.000Z' };

  expect(ids([taskB, taskA].sort(compareColumnEntry))).toEqual(['aaa', 'bbb']);
  expect(ids([taskA, taskB].sort(compareColumnEntry))).toEqual(['aaa', 'bbb']);
});

test('selectColumnRenderPlan derives the order and ignores the stored order field', () => {
  const tasks = [
    { id: 'late', column: BACKLOG_COLUMN_ID, order: 1, creationDate: '2026-01-02T00:00:00.000Z' },
    { id: 'early', column: BACKLOG_COLUMN_ID, order: 99, creationDate: '2026-01-01T00:00:00.000Z' },
    { id: 'elsewhere', column: HIL_COLUMN_ID, order: 1, creationDate: '2026-01-01T00:00:00.000Z' }
  ];

  const plan = selectColumnRenderPlan(BACKLOG_COLUMN_ID, tasks);

  expect(ids(plan.columnTasks)).toEqual(['early', 'late']);
  expect(ids(plan.tasksToRender)).toEqual(['early', 'late']);
});

test('selectColumnRenderPlan puts an undigested note at the front of the Finished column too', () => {
  const tasks = [
    { id: 'finished-old', column: FINISHED_COLUMN_ID, order: 1, creationDate: '2026-01-01T00:00:00.000Z' },
    { id: 'finished-note', column: FINISHED_COLUMN_ID, order: 2, creationDate: '2026-01-02T00:00:00.000Z', needsDigest: true }
  ];

  const plan = selectColumnRenderPlan(FINISHED_COLUMN_ID, tasks);

  expect(ids(plan.tasksToRender)).toEqual(['finished-note', 'finished-old']);
});
