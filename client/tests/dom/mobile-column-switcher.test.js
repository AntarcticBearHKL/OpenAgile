import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { mountToBody } from './setup.js';
import { FIXED_COLUMNS } from '../../src/modules/constants.js';

const mocks = vi.hoisted(() => ({
  boards: [],
  columns: [],
  tasks: [],
  settings: {}
}));

vi.mock('../../src/modules/icons.js', () => ({ renderIcons: vi.fn() }));
vi.mock('../../src/modules/storage.js', () => ({
  listBoards: () => mocks.boards,
  loadColumns: () => mocks.columns,
  loadTasks: () => mocks.tasks,
  loadSettings: () => mocks.settings,
  isDoneColumnId: (columnId) =>
    mocks.columns.some((column) => column.id === columnId && column.role === 'done')
}));

const { renderBoard } = await import('../../src/modules/render.js');
const { emit, DATA_CHANGED } = await import('../../src/modules/events.js');
const {
  getMobileActiveColumnId,
  _resetMobileColumnSwitcherForTesting
} = await import('../../src/modules/mobile-column-switcher.js');

const [BACKLOG_ID, HIL_ID, IN_PROGRESS_ID, BLOCKED_ID, FINISHED_ID] = FIXED_COLUMNS.map(
  (column) => column.id
);

function stubPhoneViewport(matches) {
  vi.stubGlobal('matchMedia', () =>
    Object.assign(new EventTarget(), {
      matches,
      media: '',
      onchange: null
    })
  );
}

function mountBoard() {
  mountToBody('<div class="board-main"><main id="board-container" class="board-container"></main></div>');
  renderBoard();
}

function tabs() {
  return [...document.querySelectorAll('.mobile-column-tab')];
}

function tabFor(columnId) {
  return document.querySelector(`.mobile-column-tab[data-column="${columnId}"]`);
}

function tabCount(columnId) {
  return tabFor(columnId).querySelector('.mobile-column-tab-count').textContent;
}

function activeColumns() {
  return [...document.querySelectorAll('.task-column')]
    .filter((column) => column.classList.contains('is-mobile-active'))
    .map((column) => column.dataset.column);
}

function task(id, columnId) {
  return { id, column: columnId, title: id, creationDate: '2026-01-01T00:00:00.000Z' };
}

beforeEach(() => {
  _resetMobileColumnSwitcherForTesting();
  stubPhoneViewport(true);
  mocks.boards = [{ id: 'board-1', name: 'Test' }];
  mocks.columns = FIXED_COLUMNS.map((column) => ({ ...column }));
  mocks.tasks = [];
  mocks.settings = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('lists all five columns as tabs, in board order, with their accent and count', () => {
  mocks.tasks = [
    task('b1', BACKLOG_ID),
    task('b2', BACKLOG_ID),
    task('p1', IN_PROGRESS_ID),
    task('f1', FINISHED_ID)
  ];

  mountBoard();

  expect(tabs().map((tab) => tab.dataset.column)).toEqual(FIXED_COLUMNS.map((column) => column.id));
  expect(tabs().map((tab) => tab.querySelector('.mobile-column-tab-name').textContent)).toEqual(
    FIXED_COLUMNS.map((column) => column.name)
  );
  expect(tabs().map((tab) => tabCount(tab.dataset.column))).toEqual(['2', '0', '1', '0', '1']);
  expect(tabs().map((tab) => tab.getAttribute('aria-label'))).toEqual([
    'Backlog, 2 tasks',
    'Human In The Loop, 0 tasks',
    'In Progress, 1 task',
    'Blocked, 0 tasks',
    'Finished, 1 task'
  ]);

  for (const column of FIXED_COLUMNS) {
    expect(tabFor(column.id).style.getPropertyValue('--column-accent'), column.name).toBe(column.color);
  }
});

test('keeps every column mounted and marks exactly one active', () => {
  mocks.tasks = [task('b1', BACKLOG_ID)];

  mountBoard();

  expect(document.querySelectorAll('.task-column')).toHaveLength(FIXED_COLUMNS.length);
  expect(activeColumns()).toEqual([BACKLOG_ID]);
  expect(document.getElementById('board-container').dataset.mobileActiveColumn).toBe(BACKLOG_ID);
});

test('defaults to the first column that has tasks', () => {
  mocks.tasks = [task('k1', BLOCKED_ID), task('k2', FINISHED_ID)];

  mountBoard();

  expect(getMobileActiveColumnId()).toBe(BLOCKED_ID);
  expect(activeColumns()).toEqual([BLOCKED_ID]);
});

test('falls back to Backlog when no column has tasks', () => {
  mountBoard();

  expect(getMobileActiveColumnId()).toBe(BACKLOG_ID);
  expect(activeColumns()).toEqual([BACKLOG_ID]);
});

test('tapping a tab moves the active column and the tab state with it', () => {
  mountBoard();

  fireEvent.click(tabFor(FINISHED_ID));

  expect(getMobileActiveColumnId()).toBe(FINISHED_ID);
  expect(activeColumns()).toEqual([FINISHED_ID]);
  expect(document.getElementById('board-container').dataset.mobileActiveColumn).toBe(FINISHED_ID);

  expect(tabFor(FINISHED_ID).getAttribute('aria-selected')).toBe('true');
  expect(tabFor(FINISHED_ID).getAttribute('tabindex')).toBe('0');
  expect(tabFor(FINISHED_ID).classList.contains('is-active')).toBe(true);

  expect(tabFor(BACKLOG_ID).getAttribute('aria-selected')).toBe('false');
  expect(tabFor(BACKLOG_ID).getAttribute('tabindex')).toBe('-1');
  expect(tabFor(BACKLOG_ID).classList.contains('is-active')).toBe(false);
});

test('switching columns keeps the task cards, their controls and their handlers', () => {
  mocks.tasks = [{ ...task('b1', BACKLOG_ID), keyPoints: [{ id: 'kp1', text: 'Read me' }] }];
  mocks.settings = { showChangeDate: false };

  mountBoard();
  fireEvent.click(tabFor(IN_PROGRESS_ID));
  fireEvent.click(tabFor(BACKLOG_ID));

  const card = document.querySelector(`.task-column[data-column="${BACKLOG_ID}"] .task`);
  expect(card).not.toBeNull();
  expect(card.querySelector('.task-title').textContent).toBe('b1');
  expect(card.querySelector('.task-key-points .task-key-point').textContent).toBe('Read me');
  expect(card.querySelector('.delete-task-btn')).not.toBeNull();

  fireEvent.click(card.querySelector('.delete-task-btn'));
  expect(card.querySelector('.delete-task-btn').classList.contains('is-armed')).toBe(true);
});

test('keeps the selection when DATA_CHANGED rebuilds the board', () => {
  mocks.tasks = [task('b1', BACKLOG_ID), task('k1', BLOCKED_ID)];
  mountBoard();

  fireEvent.click(tabFor(BLOCKED_ID));
  emit(DATA_CHANGED);

  expect(document.querySelectorAll('.mobile-column-switcher')).toHaveLength(1);
  expect(getMobileActiveColumnId()).toBe(BLOCKED_ID);
  expect(activeColumns()).toEqual([BLOCKED_ID]);
});

test('refreshes the counts after the board changes', () => {
  mountBoard();
  expect(tabCount(BACKLOG_ID)).toBe('0');

  mocks.tasks = [task('b1', BACKLOG_ID), task('b2', BACKLOG_ID)];
  emit(DATA_CHANGED);

  expect(tabCount(BACKLOG_ID)).toBe('2');
});

test('arrow keys move between tabs, Home and End jump, and Tab is never swallowed', () => {
  mountBoard();

  const first = tabFor(BACKLOG_ID);
  first.focus();
  expect(document.activeElement).toBe(first);

  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(getMobileActiveColumnId()).toBe(HIL_ID);
  expect(document.activeElement).toBe(tabFor(HIL_ID));

  fireEvent.keyDown(document.activeElement, { key: 'End' });
  expect(getMobileActiveColumnId()).toBe(FINISHED_ID);

  fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
  expect(getMobileActiveColumnId()).toBe(BACKLOG_ID);

  fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
  expect(getMobileActiveColumnId()).toBe(FINISHED_ID);

  fireEvent.keyDown(document.activeElement, { key: 'Home' });
  expect(getMobileActiveColumnId()).toBe(BACKLOG_ID);

  const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  tabFor(BACKLOG_ID).dispatchEvent(tabEvent);
  expect(tabEvent.defaultPrevented).toBe(false);
  expect(tabs().filter((tab) => tab.getAttribute('tabindex') === '0')).toHaveLength(1);
});

test('each tab owns a real tabpanel through aria-controls', () => {
  mountBoard();

  for (const column of FIXED_COLUMNS) {
    const tab = tabFor(column.id);
    const panel = document.getElementById(tab.getAttribute('aria-controls'));

    expect(panel, column.name).not.toBeNull();
    expect(panel.getAttribute('role'), column.name).toBe('tabpanel');
    expect(panel.classList.contains('task-column'), column.name).toBe(true);
    expect(panel.dataset.column, column.name).toBe(column.id);
  }

  expect(document.querySelector('.mobile-column-switcher').getAttribute('role')).toBe('tablist');
});

test('sits directly above the board container, inside the board column', () => {
  mountBoard();

  const switcher = document.querySelector('.mobile-column-switcher');
  expect(switcher.parentElement).toBe(document.querySelector('.board-main'));
  expect(switcher.nextElementSibling).toBe(document.getElementById('board-container'));
});

test('on a wide viewport the columns carry no panel semantics but stay mounted', () => {
  stubPhoneViewport(false);
  mocks.tasks = [task('b1', BACKLOG_ID)];

  mountBoard();

  expect(document.querySelectorAll('.task-column')).toHaveLength(FIXED_COLUMNS.length);
  expect(document.querySelector('.task-column').getAttribute('role')).toBeNull();
  expect(document.querySelector('.task-column').id).toBe('');
  expect(tabs()).toHaveLength(FIXED_COLUMNS.length);
  expect(tabFor(BACKLOG_ID).getAttribute('aria-controls')).toBeNull();
  expect(document.getElementById('board-container').dataset.mobileActiveColumn).toBe(BACKLOG_ID);
});

test('an empty board list renders the empty state with no switcher', () => {
  mocks.boards = [];

  mountBoard();

  expect(document.querySelector('.mobile-column-switcher')).toBeNull();
  expect(document.getElementById('board-container').dataset.viewMode).toBe('empty');
});
