import { beforeEach, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mountToBody } from './setup.js';
import { FIXED_COLUMNS } from '../../src/modules/constants.js';

const mocks = vi.hoisted(() => ({
  boards: [],
  columns: [],
  tasks: [],
  settings: {},
  sortableCalls: [],
  doneColumnId: '00000000-0000-4000-8000-000000000033'
}));

vi.mock('sortablejs', () => ({
  default: vi.fn(function Sortable(element, options) {
    mocks.sortableCalls.push({ element, options });
    this.destroy = vi.fn();
  })
}));

vi.mock('../../src/modules/icons.js', () => ({ renderIcons: vi.fn() }));
vi.mock('../../src/modules/storage.js', () => ({
  listBoards: () => mocks.boards,
  loadColumns: () => mocks.columns,
  loadTasks: () => mocks.tasks,
  loadSettings: () => mocks.settings,
  isDoneColumnId: (columnId) => columnId === mocks.doneColumnId
}));

const [BACKLOG_COLUMN_ID, HIL_COLUMN_ID] = FIXED_COLUMNS.map((column) => column.id);

const { renderBoard } = await import('../../src/modules/render.js');

beforeEach(() => {
  mocks.boards = [{ id: 'board-1', name: 'Test' }];
  mocks.columns = FIXED_COLUMNS.map((column) => ({ ...column }));
  mocks.tasks = [];
  mocks.settings = {};
  mocks.sortableCalls.length = 0;
});

function mountBoardContainer() {
  mountToBody('<main id="board-container"></main>');
}

function renderedTaskIds(columnId) {
  return [...document.querySelectorAll(`.task-column[data-column="${columnId}"] .task`)]
    .map((element) => element.dataset.taskId);
}

test('an undigested note sorts a task to the front of its own column', () => {
  mocks.tasks = FIXED_COLUMNS.flatMap((column) => [
    { id: `${column.id}-first`, column: column.id, creationDate: '2026-01-01T00:00:00.000Z' },
    { id: `${column.id}-second`, column: column.id, creationDate: '2026-01-02T00:00:00.000Z' },
    { id: `${column.id}-note`, column: column.id, creationDate: '2026-01-03T00:00:00.000Z', needsDigest: true }
  ]);

  mountBoardContainer();
  renderBoard();

  for (const column of FIXED_COLUMNS) {
    expect(renderedTaskIds(column.id), column.name).toEqual([
      `${column.id}-note`,
      `${column.id}-first`,
      `${column.id}-second`
    ]);
  }
});

test('a column orders by entry time, using the latest matching history entry', () => {
  mocks.tasks = [
    {
      id: 'returned',
      column: BACKLOG_COLUMN_ID,
      creationDate: '2026-01-01T00:00:00.000Z',
      columnHistory: [
        { column: BACKLOG_COLUMN_ID, at: '2026-01-02T00:00:00.000Z' },
        { column: HIL_COLUMN_ID, at: '2026-01-03T00:00:00.000Z' },
        { column: BACKLOG_COLUMN_ID, at: '2026-01-05T00:00:00.000Z' }
      ]
    },
    { id: 'no-history', column: BACKLOG_COLUMN_ID, creationDate: '2026-01-04T00:00:00.000Z' },
    { id: 'early', column: BACKLOG_COLUMN_ID, columnHistory: [{ column: BACKLOG_COLUMN_ID, at: '2026-01-01T00:00:00.000Z' }] }
  ];

  mountBoardContainer();
  renderBoard();

  expect(renderedTaskIds(BACKLOG_COLUMN_ID)).toEqual(['early', 'no-history', 'returned']);
});

test('the stored order field does not decide the display order', () => {
  mocks.tasks = [
    { id: 'late', column: BACKLOG_COLUMN_ID, order: 1, creationDate: '2026-01-02T00:00:00.000Z' },
    { id: 'early', column: BACKLOG_COLUMN_ID, order: 500, creationDate: '2026-01-01T00:00:00.000Z' }
  ];

  mountBoardContainer();
  renderBoard();

  expect(renderedTaskIds(BACKLOG_COLUMN_ID)).toEqual(['early', 'late']);
});

test('equal entry times fall back to the id, not the input order', () => {
  const sameTime = '2026-01-01T00:00:00.000Z';
  mocks.tasks = [
    { id: 'z-second', column: BACKLOG_COLUMN_ID, creationDate: sameTime },
    { id: 'a-first', column: BACKLOG_COLUMN_ID, creationDate: sameTime }
  ];

  mountBoardContainer();
  renderBoard();

  expect(renderedTaskIds(BACKLOG_COLUMN_ID)).toEqual(['a-first', 'z-second']);
});

test('the rendered board carries no drag or drop affordance', () => {
  mocks.tasks = [{ id: 't1', column: BACKLOG_COLUMN_ID, creationDate: '2026-01-01T00:00:00.000Z' }];

  mountBoardContainer();
  renderBoard();

  expect(mocks.sortableCalls).toEqual([]);
  const card = document.querySelector('.task');
  expect(card.hasAttribute('draggable')).toBe(false);
  expect(card.draggable).toBe(false);
});

test('the human column-move modules and styles are gone', () => {
  const sourcePath = (relative) => fileURLToPath(new URL(`../../${relative}`, import.meta.url));

  for (const name of ['dragdrop.js', 'task-drop.js', 'task-position.js', 'drag-session.js']) {
    expect(existsSync(sourcePath(`src/modules/${name}`)), name).toBe(false);
  }
  expect(existsSync(sourcePath('src/styles/components/dragdrop.css'))).toBe(false);
});
