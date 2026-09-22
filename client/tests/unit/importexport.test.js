import { test, expect, beforeEach, vi } from 'vitest';
import { resetLocalStorage } from './setup.js';
import { exportBoard } from '../../src/modules/importexport.js';
import { importTasks } from '../../src/modules/import-board.js';
import { inspectImportPayload, buildImportConfirmationMessage, IMPORT_LIMITS } from '../../src/modules/import-payload.js';
import { createBoard, getActiveBoardId, saveColumns, saveTasks } from '../../src/modules/storage.js';

vi.mock('../../src/modules/dialog.js', () => ({
  confirmDialog: vi.fn(() => Promise.resolve(true)),
  alertDialog: vi.fn(() => Promise.resolve(true))
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(() => {
  resetLocalStorage();
});

function captureExportJson(callback) {
  const previousBlob = globalThis.Blob;
  const previousUrl = globalThis.URL;
  const previousDocument = globalThis.document;
  let exportedJson = '';

  globalThis.Blob = class {
    constructor(parts) {
      exportedJson = parts.join('');
    }
  };
  globalThis.URL = { createObjectURL: () => 'blob:export', revokeObjectURL: () => {} };
  globalThis.document = {
    createElement: () => ({ click: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} }
  };

  try {
    callback();
    return JSON.parse(exportedJson);
  } finally {
    globalThis.Blob = previousBlob;
    globalThis.URL = previousUrl;
    globalThis.document = previousDocument;
  }
}

test('inspectImportPayload accepts valid board export objects', () => {
  const preview = inspectImportPayload({
    boardName: 'Imported',
    columns: [
      { id: 'todo', name: 'Todo', color: '#3b82f6', order: 1 },
      { id: 'done', name: 'Done', color: '#16a34a', order: 2 }
    ],
    tasks: [
      { id: 'task-1', title: 'Task 1', column: 'todo', labels: ['label-1'], priority: 'high' }
    ],
    labels: [
      { id: 'label-1', name: 'Label', color: '#ff0000' }
    ],
    settings: {
      showPriority: true
    }
  }, { name: 'import.json', size: 1024 });

  expect(preview.errors).toEqual([]);
  expect(preview.importedName).toBe('Imported');
  expect(preview.summary.tasks).toBe(1);
  expect(preview.summary.columns).toBe(2);
  expect('normalizedLabels' in preview).toBe(false);
});

test('inspectImportPayload remaps legacy model ids to UUIDs while preserving references', () => {
  const preview = inspectImportPayload({
    boardName: 'Legacy IDs',
    columns: [
      { id: 'todo', name: 'Todo', color: '#3b82f6', order: 1 },
      { id: 'done', name: 'Done', color: '#16a34a', order: 2 }
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'Task 1',
        column: 'done',
        labels: ['label-1'],
        priority: 'high',
        columnHistory: [{ column: 'done', at: '2024-01-01T00:00:00Z' }]
      }
    ],
    labels: [
      { id: 'label-1', name: 'Label', color: '#ff0000' }
    ]
  }, { name: 'legacy-ids.json', size: 1024 });

  expect(preview.errors).toEqual([]);
  const doneColumn = preview.normalizedColumns.find((column) => column.role === 'done');
  const task = preview.normalizedTasks[0];
  expect(doneColumn.id).toMatch(UUID_RE);
  expect(task.id).toMatch(UUID_RE);
  expect(task.column).toBe(doneColumn.id);
  expect(task.columnHistory[0].column).toBe(doneColumn.id);
});

test('inspectImportPayload rejects files above the size limit', () => {
  const threeMb = 3 * 1024 * 1024;
  const preview = inspectImportPayload([], { name: 'large.json', size: threeMb });
  expect(preview.errors[0]).toMatch(/too large/i);
});

test('inspectImportPayload warns for legacy task-only imports', () => {
  const preview = inspectImportPayload([
    { id: 'task-1', title: 'Task 1', column: 'todo', labels: [], priority: 'none' }
  ], { name: 'legacy.json', size: 128 });

  expect(preview.errors).toEqual([]);
  expect(preview.warnings.join(' ')).toMatch(/Legacy task-only import detected/i);
  const task = preview.normalizedTasks[0];
  const todoColumn = preview.normalizedColumns.find((column) => column.name === 'To Do');
  expect(task.id).toMatch(UUID_RE);
  expect(todoColumn.id).toMatch(UUID_RE);
  expect(task.column).toBe(todoColumn.id);
});

test('inspectImportPayload preserves and remaps task relationships', () => {
  const preview = inspectImportPayload({
    columns: [
      { id: 'todo', name: 'Todo', color: '#3b82f6', order: 1 },
      { id: 'done', name: 'Done', color: '#16a34a', order: 2 }
    ],
    tasks: [
      { id: 'task-a', title: 'Task A', column: 'todo', priority: 'none', relationships: [{ type: 'dependent', targetTaskId: 'task-b' }] },
      { id: 'task-b', title: 'Task B', column: 'todo', priority: 'none', relationships: [{ type: 'prerequisite', targetTaskId: 'task-a' }] }
    ]
  }, { name: 'relationships.json', size: 256 });

  expect(preview.errors).toEqual([]);
  const taskA = preview.normalizedTasks.find((task) => task.title === 'Task A');
  const taskB = preview.normalizedTasks.find((task) => task.title === 'Task B');
  expect(taskA.id).toMatch(UUID_RE);
  expect(taskB.id).toMatch(UUID_RE);
  expect(taskA.relationships).toEqual([{ type: 'dependent', targetTaskId: taskB.id }]);
  expect(taskB.relationships).toEqual([{ type: 'prerequisite', targetTaskId: taskA.id }]);
});

test('inspectImportPayload ignores the removed task fields from an older export', () => {
  const preview = inspectImportPayload({
    columns: [
      { id: 'todo', name: 'Todo', color: '#3b82f6', order: 1 },
      { id: 'done', name: 'Done', color: '#16a34a', order: 2 }
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'Legacy task',
        column: 'todo',
        priority: 'urgent',
        dueDate: '2026-01-01',
        labels: ['known', 'unknown'],
        subTasks: [{ id: 'st1', title: 'Step', completed: true, order: 1 }],
        attachments: [{ id: 'at1', name: 'Spec', url: 'https://example.com/spec.pdf' }],
        customFields: { Sprint: '12' }
      }
    ]
  }, { name: 'older-export.json', size: 512 });

  expect(preview.errors).toEqual([]);
  const task = preview.normalizedTasks[0];
  expect(task.title).toBe('Legacy task');
  expect(task.id).toMatch(UUID_RE);
  expect(task.priority).toBeUndefined();
  expect(task.dueDate).toBeUndefined();
  expect(task.labels).toBeUndefined();
  expect(task.subTasks).toBeUndefined();
  expect(task.attachments).toBeUndefined();
  expect(task.customFields).toBeUndefined();
});

test('inspectImportPayload reads legacy acceptanceCriteria into keyPoints', () => {
  const preview = inspectImportPayload({
    columns: [
      { id: 'todo', name: 'Todo', color: '#3b82f6', order: 1 },
      { id: 'done', name: 'Done', color: '#16a34a', order: 2 }
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'Legacy criteria',
        column: 'todo',
        acceptanceCriteria: [
          { id: 'ac1', text: 'Works offline', done: true },
          { id: 'ac2', text: 'Syncs', done: false }
        ]
      }
    ]
  }, { name: 'legacy-criteria.json', size: 512 });

  expect(preview.errors).toEqual([]);
  const task = preview.normalizedTasks[0];
  expect(task.acceptanceCriteria).toBeUndefined();
  expect(task.keyPoints).toEqual([
    { id: 'ac1', text: 'Works offline', at: expect.any(String) },
    { id: 'ac2', text: 'Syncs', at: expect.any(String) }
  ]);
});

test('buildImportConfirmationMessage includes summary details', () => {
  const message = buildImportConfirmationMessage({
    importedName: 'Security Review',
    fileSize: 2048,
    summary: { tasks: 3, columns: 4, includesSettings: true },
    warnings: ['Large import file detected.']
  });

  expect(message).toMatch(/Security Review/);
  expect(message).toMatch(/3 tasks/);
  expect(message).toMatch(/settings included/);
  expect(message).toMatch(/Warnings:/);
});

test('exportBoard writes no labels array', () => {
  const board = createBoard('Export Me');
  const exported = captureExportJson(() => exportBoard(board.id));

  expect('labels' in exported).toBe(false);
  expect(exported.tasks.length).toBe(0);
});
