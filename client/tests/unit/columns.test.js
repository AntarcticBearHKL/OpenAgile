import { test, expect, beforeEach } from 'vitest';
import { resetLocalStorage } from './setup.js';
import { createBoard, loadColumns, loadTasks, saveColumns, saveTasks } from '../../src/modules/storage.js';
import { addColumn, toggleColumnCollapsed, deleteColumn } from '../../src/modules/columns.js';
import { BACKLOG_COLUMN_ID } from '../../src/modules/constants.js';

beforeEach(() => {
  resetLocalStorage();
  createBoard('Test');
});

test('columns are locked to the five fixed columns', () => {
  const names = loadColumns().map((c) => c.name);
  expect(names).toEqual(['Backlog', 'Human In The Loop', 'In Progress', 'Blocked', 'Finished']);
});

test('an existing four-column board gains Human In The Loop without losing its tasks', () => {
  saveColumns([
    { id: '00000000-0000-4000-8000-000000000030', name: 'Backlog', color: '#3583ff', order: 1 },
    { id: '00000000-0000-4000-8000-000000000031', name: 'In Progress', color: '#f59e0b', order: 2 },
    { id: '00000000-0000-4000-8000-000000000032', name: 'Blocked', color: '#ef4444', order: 3 },
    { id: '00000000-0000-4000-8000-000000000033', name: 'Finished', color: '#16a34a', order: 4, role: 'done' }
  ]);
  saveTasks([{ id: 't1', title: 'Existing', column: BACKLOG_COLUMN_ID, order: 1 }]);

  const columns = loadColumns();
  expect(columns.map((c) => c.name)).toEqual(['Backlog', 'Human In The Loop', 'In Progress', 'Blocked', 'Finished']);
  expect(columns[1].id).toBe('00000000-0000-4000-8000-000000000034');
  expect(loadTasks().find((t) => t.id === 't1')).toBeTruthy();
});


test('toggleColumnCollapsed toggles from false to true', () => {
  const col = loadColumns()[0];
  expect(col.collapsed).toBe(false);
  expect(toggleColumnCollapsed(col.id)).toBe(true);
  expect(loadColumns().find((c) => c.id === col.id).collapsed).toBe(true);
});

test('toggleColumnCollapsed toggles from true to false', () => {
  const col = loadColumns()[0];
  toggleColumnCollapsed(col.id);
  toggleColumnCollapsed(col.id);
  expect(loadColumns().find((c) => c.id === col.id).collapsed).toBe(false);
});

test('toggleColumnCollapsed returns false for non-existent column', () => {
  expect(toggleColumnCollapsed('non-existent')).toBe(false);
});

test('toggleColumnCollapsed returns false for empty ID', () => {
  expect(toggleColumnCollapsed('')).toBe(false);
});






