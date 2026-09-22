import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { mountToBody } from './setup.js';

const mocks = vi.hoisted(() => ({
  boards: [],
  activeId: 'board-1',
  tasksByBoard: {},
  columnsByBoard: {}
}));

vi.mock('../../src/modules/storage.js', () => ({
  ensureBoardsInitialized: vi.fn(),
  listBoards: vi.fn(() => mocks.boards),
  createBoard: vi.fn((name) => {
    const board = { id: `board-${mocks.boards.length + 1}`, name };
    mocks.boards.push(board);
    return board;
  }),
  getActiveBoardId: vi.fn(() => mocks.activeId),
  setActiveBoardId: vi.fn((id) => { mocks.activeId = id; }),
  renameBoard: vi.fn((id, name) => {
    const board = mocks.boards.find((entry) => entry.id === id);
    if (!board) return false;
    board.name = name;
    return true;
  }),
  deleteBoard: vi.fn((id) => {
    mocks.boards = mocks.boards.filter((board) => board.id !== id);
    return true;
  }),
  loadTasksForBoard: vi.fn((boardId) => mocks.tasksByBoard[boardId] || []),
  loadColumnsForBoard: vi.fn((boardId) => mocks.columnsByBoard[boardId] || [])
}));

vi.mock('../../src/modules/icons.js', () => ({
  renderIcons: vi.fn()
}));

import { initializeBoardSidebar } from '../../src/modules/board-sidebar.js';
import { emit, on, DATA_CHANGED, _resetEventsForTesting } from '../../src/modules/events.js';
import {
  assignBoardToGroup,
  createGroup,
  listGroups,
  readBoardGroupMap
} from '../../src/modules/board-groups.js';

const FIXTURE = `
  <aside class="board-sidebar">
    <div class="sidebar-heading">
      <span>Groups</span>
      <button id="add-group-btn" type="button">+</button>
    </div>
    <ul id="board-list" class="board-list"></ul>
  </aside>
  <select id="board-select"></select>
`;

function groupElements() {
  return Array.from(document.querySelectorAll('#board-list > .board-group'));
}

function groupByName(name) {
  return groupElements().find(
    (el) => el.querySelector('.board-group-name')?.textContent === name
  );
}

function rootItems() {
  return Array.from(document.querySelectorAll('#board-list > .board-list-item'));
}

function prefixToggleFor(name) {
  return groupByName(name).querySelector('.board-group-prefix-toggle');
}

function iterationLabels(name) {
  return Array.from(groupByName(name).querySelectorAll('.board-list-item-name')).map(
    (el) => el.textContent
  );
}

beforeEach(() => {
  _resetEventsForTesting();
  mocks.boards = [
    { id: 'board-1', name: 'Work' },
    { id: 'board-2', name: 'Personal' }
  ];
  mocks.activeId = 'board-1';
  mocks.tasksByBoard = {};
  mocks.columnsByBoard = {};
  mountToBody(FIXTURE);
});

describe('sidebar group tree', () => {
  test('renders the user-set group names', () => {
    const first = createGroup('Delivery');
    const second = createGroup('Personal work');
    assignBoardToGroup('board-1', first.id);
    assignBoardToGroup('board-2', second.id);

    initializeBoardSidebar();

    const names = groupElements().map((el) => el.querySelector('.board-group-name').textContent);
    expect(names).toEqual(['Delivery', 'Personal work']);
  });

  test('a board without a group is placed in the last group on render', () => {
    const first = createGroup('Delivery');
    const second = createGroup('Personal work');
    assignBoardToGroup('board-2', first.id);

    initializeBoardSidebar();

    expect(groupByName('Personal work').querySelector('[data-board-id="board-1"]')).not.toBeNull();
    expect(groupByName('Delivery').querySelector('[data-board-id="board-2"]')).not.toBeNull();
    expect(readBoardGroupMap()).toEqual({ 'board-1': second.id, 'board-2': first.id });

    initializeBoardSidebar();

    expect(readBoardGroupMap()).toEqual({ 'board-1': second.id, 'board-2': first.id });
  });

  test('creates a group for existing boards when none exists', () => {
    initializeBoardSidebar();

    const groups = listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('New Group');
    expect(readBoardGroupMap()).toEqual({ 'board-1': groups[0].id, 'board-2': groups[0].id });
    expect(rootItems()).toHaveLength(0);
  });

  test('marks the active iteration', () => {
    initializeBoardSidebar();

    const active = document.querySelector('.board-list-item--active');
    expect(active.dataset.boardId).toBe('board-1');
    expect(active.getAttribute('aria-current')).toBe('true');
  });

  test('clicking an iteration switches the active board and emits DATA_CHANGED', () => {
    initializeBoardSidebar();

    const changed = vi.fn();
    on(DATA_CHANGED, changed);

    const item = document.querySelector('.board-list-item[data-board-id="board-2"]');
    fireEvent.click(item);

    expect(mocks.activeId).toBe('board-2');
    expect(changed).toHaveBeenCalled();
  });

  test('numbers a group in display order', () => {
    const group = createGroup('Delivery');
    mocks.boards.push({ id: 'board-3', name: 'Later' });
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    assignBoardToGroup('board-3', group.id);

    initializeBoardSidebar();

    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2', 'Iteration 3']);
    expect(mocks.boards.map((board) => board.name)).toEqual([
      'Iteration 1',
      'Iteration 2',
      'Iteration 3'
    ]);
  });

  test('renumbers after an iteration is created', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    initializeBoardSidebar();
    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2']);

    mocks.boards.push({ id: 'board-3', name: 'Untitled board' });
    assignBoardToGroup('board-3', group.id);
    emit(DATA_CHANGED);

    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2', 'Iteration 3']);
    expect(mocks.boards.find((board) => board.id === 'board-3').name).toBe('Iteration 3');
  });

  test('renumbers after an iteration is deleted', () => {
    const group = createGroup('Delivery');
    mocks.boards = [
      { id: 'board-1', name: 'Iteration 1' },
      { id: 'board-2', name: 'Iteration 2' },
      { id: 'board-3', name: 'Iteration 3' }
    ];
    ['board-1', 'board-2', 'board-3'].forEach((id) => assignBoardToGroup(id, group.id));
    initializeBoardSidebar();
    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2', 'Iteration 3']);

    const deleteBtn = document.querySelector(
      '.board-list-item[data-board-id="board-3"] .board-list-delete'
    );
    fireEvent.click(deleteBtn);
    fireEvent.click(deleteBtn);

    expect(document.querySelector('.board-list-item[data-board-id="board-3"]')).toBeNull();
    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2']);
    expect(mocks.boards).toHaveLength(2);
  });

  test('only the last iteration in a group offers a delete control', () => {
    const group = createGroup('Delivery');
    mocks.boards = [
      { id: 'board-1', name: 'Iteration 1' },
      { id: 'board-2', name: 'Iteration 2' },
      { id: 'board-3', name: 'Iteration 3' }
    ];
    ['board-1', 'board-2', 'board-3'].forEach((id) => assignBoardToGroup(id, group.id));
    initializeBoardSidebar();

    expect(
      document.querySelector('.board-list-item[data-board-id="board-1"] .board-list-delete')
    ).toBeNull();
    expect(
      document.querySelector('.board-list-item[data-board-id="board-2"] .board-list-delete')
    ).toBeNull();
    expect(
      document.querySelector('.board-list-item[data-board-id="board-3"] .board-list-delete')
    ).not.toBeNull();
  });

  test('renumbers both groups when an iteration moves between them', () => {
    const first = createGroup('Delivery');
    const second = createGroup('Personal work');
    mocks.boards = [
      { id: 'board-1', name: 'Iteration 1' },
      { id: 'board-2', name: 'Iteration 2' },
      { id: 'board-3', name: 'Iteration 1' }
    ];
    assignBoardToGroup('board-1', first.id);
    assignBoardToGroup('board-2', first.id);
    assignBoardToGroup('board-3', second.id);
    initializeBoardSidebar();
    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2']);
    expect(iterationLabels('Personal work')).toEqual(['Iteration 1']);

    assignBoardToGroup('board-1', second.id);
    emit(DATA_CHANGED);

    expect(iterationLabels('Delivery')).toEqual(['Iteration 1']);
    expect(iterationLabels('Personal work')).toEqual(['Iteration 1', 'Iteration 2']);
    expect(mocks.boards.find((board) => board.id === 'board-1').name).toBe('Iteration 1');
    expect(mocks.boards.find((board) => board.id === 'board-2').name).toBe('Iteration 1');
    expect(mocks.boards.find((board) => board.id === 'board-3').name).toBe('Iteration 2');
  });

  test('an iteration cannot be renamed by hand', () => {
    const group = createGroup('Delivery');
    mocks.boards = [
      { id: 'board-1', name: 'Iteration 1' },
      { id: 'board-2', name: 'Iteration 2' }
    ];
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    initializeBoardSidebar();

    const item = document.querySelector('.board-list-item[data-board-id="board-1"]');
    expect(item.getAttribute('title')).toBeNull();

    fireEvent.dblClick(item.querySelector('.board-list-item-name'));

    expect(document.querySelector('.board-group-rename-input')).toBeNull();
    expect(item.querySelector('.board-list-item-name').textContent).toBe('Iteration 1');
    expect(mocks.boards.find((board) => board.id === 'board-1').name).toBe('Iteration 1');
  });

  test('the chevron collapses a group and persists the state', () => {
    const group = createGroup('Delivery');
    initializeBoardSidebar();

    const toggle = groupByName('Delivery').querySelector('.board-group-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);

    expect(groupByName('Delivery').classList.contains('is-collapsed')).toBe(true);
    expect(listGroups().find((entry) => entry.id === group.id).collapsed).toBe(true);
  });

  test('clicking a group name toggles collapse and updates both aria-expanded states', () => {
    createGroup('Delivery');
    initializeBoardSidebar();

    vi.useFakeTimers();
    try {
      const nameEl = groupByName('Delivery').querySelector('.board-group-name');
      expect(nameEl.getAttribute('role')).toBe('button');
      expect(nameEl.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(nameEl);
      expect(groupByName('Delivery').classList.contains('is-collapsed')).toBe(false);

      vi.advanceTimersByTime(200);

      const collapsed = groupByName('Delivery');
      expect(collapsed.classList.contains('is-collapsed')).toBe(true);
      expect(collapsed.querySelector('.board-group-name').getAttribute('aria-expanded')).toBe('false');
      expect(collapsed.querySelector('.board-group-toggle').getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  test('Enter and Space on the focused group name toggle collapse immediately', () => {
    createGroup('Delivery');
    initializeBoardSidebar();

    const nameEl = groupByName('Delivery').querySelector('.board-group-name');
    nameEl.focus();
    expect(document.activeElement).toBe(nameEl);
    expect(nameEl.tabIndex).toBe(0);

    fireEvent.keyDown(nameEl, { key: 'Enter' });
    expect(groupByName('Delivery').classList.contains('is-collapsed')).toBe(true);

    fireEvent.keyDown(groupByName('Delivery').querySelector('.board-group-name'), { key: ' ' });
    expect(groupByName('Delivery').classList.contains('is-collapsed')).toBe(false);
  });

  test('double-clicking a group name opens the rename input and Enter commits the name', () => {
    const group = createGroup('Draft');
    initializeBoardSidebar();

    fireEvent.dblClick(groupByName('Draft').querySelector('.board-group-name'));

    const input = document.querySelector('.board-group-rename-input');
    expect(input).not.toBeNull();
    expect(input.value).toBe('Draft');
    expect(document.activeElement).toBe(input);

    input.value = 'Q3 delivery';
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(document.querySelector('.board-group-rename-input')).toBeNull();
    expect(listGroups().find((entry) => entry.id === group.id).name).toBe('Q3 delivery');
    expect(groupByName('Q3 delivery')).not.toBeUndefined();
  });

  test('Escape in the group rename input keeps the old name', () => {
    createGroup('Draft');
    initializeBoardSidebar();

    fireEvent.dblClick(groupByName('Draft').querySelector('.board-group-name'));
    const input = document.querySelector('.board-group-rename-input');
    input.value = 'Changed';
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(document.querySelector('.board-group-rename-input')).toBeNull();
    expect(listGroups().map((entry) => entry.name)).toEqual(['Draft']);
  });

  test('#add-group-btn opens a name input without creating a group', () => {
    initializeBoardSidebar();
    const before = listGroups().map((group) => group.id);

    fireEvent.click(document.getElementById('add-group-btn'));

    const input = document.querySelector('.board-group-create-input');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('');
    expect(listGroups().map((group) => group.id)).toEqual(before);
    expect(groupElements()).toHaveLength(before.length);

    expect(fireEvent.keyDown(input, { key: 'Q' })).toBe(true);
  });

  test('committing the typed name creates the group with that name', () => {
    initializeBoardSidebar();
    const before = listGroups().map((group) => group.id);

    fireEvent.click(document.getElementById('add-group-btn'));
    const input = document.querySelector('.board-group-create-input');
    input.value = 'Q3 delivery';
    fireEvent.keyDown(input, { key: 'Enter' });

    const added = listGroups().filter((group) => !before.includes(group.id));
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('Q3 delivery');
    expect(groupByName('Q3 delivery')).not.toBeUndefined();
    expect(listGroups().some((group) => group.name === 'New Group' && !before.includes(group.id))).toBe(false);
    expect(document.querySelector('.board-group-create-input')).toBeNull();
  });

  test('committing an empty name creates nothing and keeps the input open', () => {
    initializeBoardSidebar();
    const before = listGroups().map((group) => group.id);

    fireEvent.click(document.getElementById('add-group-btn'));
    const input = document.querySelector('.board-group-create-input');
    input.value = '   ';
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(listGroups().map((group) => group.id)).toEqual(before);
    expect(document.querySelector('.board-group-create-input')).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  test('Escape cancels the new-group input and creates nothing', () => {
    initializeBoardSidebar();
    const before = listGroups().map((group) => group.id);

    fireEvent.click(document.getElementById('add-group-btn'));
    const input = document.querySelector('.board-group-create-input');
    input.value = 'Half typed';
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(document.querySelector('.board-group-create-input')).toBeNull();
    expect(listGroups().map((group) => group.id)).toEqual(before);
    expect(groupElements()).toHaveLength(before.length);
  });

  test('a group created from the add control is still renameable afterwards', () => {
    initializeBoardSidebar();

    fireEvent.click(document.getElementById('add-group-btn'));
    const input = document.querySelector('.board-group-create-input');
    input.value = 'Delivery';
    fireEvent.keyDown(input, { key: 'Enter' });

    fireEvent.dblClick(groupByName('Delivery').querySelector('.board-group-name'));
    const rename = document.querySelector('.board-group-rename-input');
    rename.value = 'Delivery 2026';
    fireEvent.keyDown(rename, { key: 'Enter' });

    expect(listGroups().some((group) => group.name === 'Delivery')).toBe(false);
    expect(groupByName('Delivery 2026')).not.toBeUndefined();
  });

  test("a group's add control creates the next iteration immediately, with no dialog", () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    initializeBoardSidebar();
    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2']);

    const openCreate = vi.fn();
    document.addEventListener('kanban:open-board-create', openCreate);

    fireEvent.click(groupByName('Delivery').querySelector('.board-group-add'));

    expect(openCreate).not.toHaveBeenCalled();
    const created = mocks.boards.at(-1);
    expect(created.name).toBe('Iteration 3');
    expect(readBoardGroupMap()[created.id]).toBe(group.id);
    expect(mocks.activeId).toBe(created.id);
    expect(iterationLabels('Delivery')).toEqual(['Iteration 1', 'Iteration 2', 'Iteration 3']);
    expect(document.querySelector('.board-group-rename-input')).toBeNull();
  });

  test('deleting a group takes its iterations with it', () => {
    const keep = createGroup('Keep');
    const doomed = createGroup('Doomed');
    assignBoardToGroup('board-1', keep.id);
    assignBoardToGroup('board-2', doomed.id);
    initializeBoardSidebar();

    const deleteBtn = groupByName('Doomed').querySelector('.board-group-delete');

    fireEvent.click(deleteBtn);
    expect(deleteBtn.classList.contains('is-armed')).toBe(true);
    expect(listGroups()).toHaveLength(2);

    fireEvent.click(deleteBtn);
    expect(listGroups().map((group) => group.name)).toEqual(['Keep']);
    expect(readBoardGroupMap()).toEqual({ 'board-1': keep.id });
    expect(mocks.boards.map((board) => board.id)).toEqual(['board-1']);
    expect(groupByName('Keep').querySelectorAll('.board-list-item')).toHaveLength(1);
  });

  test('deleting an iteration needs two clicks', () => {
    initializeBoardSidebar();

    const first = document.querySelector('.board-list-item[data-board-id="board-2"] .board-list-delete');
    fireEvent.click(first);
    expect(first.classList.contains('is-armed')).toBe(true);

    fireEvent.click(first);
    expect(document.querySelector('.board-list-item[data-board-id="board-2"]')).toBeNull();
  });

  test('the finished prefix gets one collapse control that hides only the prefix', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    mocks.boards.push({ id: 'board-3', name: 'Later' });
    assignBoardToGroup('board-3', group.id);
    mocks.tasksByBoard = {
      'board-1': [{ id: 'task-1', column: 'done' }],
      'board-2': [{ id: 'task-2', column: 'in-progress' }],
      'board-3': [{ id: 'task-3', column: 'done' }]
    };

    initializeBoardSidebar();

    const toggle = prefixToggleFor('Delivery');
    expect(toggle).not.toBeNull();
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(groupByName('Delivery').classList.contains('is-prefix-collapsed')).toBe(false);

    const first = groupByName('Delivery').querySelector('.board-list-item[data-board-id="board-1"]');
    const second = groupByName('Delivery').querySelector('.board-list-item[data-board-id="board-2"]');
    const third = groupByName('Delivery').querySelector('.board-list-item[data-board-id="board-3"]');
    expect(first.classList.contains('board-list-item--finished-prefix')).toBe(true);
    expect(second.classList.contains('board-list-item--finished-prefix')).toBe(false);
    expect(third.classList.contains('board-list-item--finished-prefix')).toBe(false);

    fireEvent.click(toggle);

    const collapsed = groupByName('Delivery');
    expect(collapsed.classList.contains('is-prefix-collapsed')).toBe(true);
    expect(prefixToggleFor('Delivery').getAttribute('aria-expanded')).toBe('false');
    expect(listGroups()[0].prefixCollapsed).toBe(true);
    expect(collapsed.querySelector('.board-list-item[data-board-id="board-1"]')).not.toBeNull();
    expect(collapsed.querySelector('.board-list-item[data-board-id="board-2"]')).not.toBeNull();
    expect(collapsed.querySelector('.board-list-item[data-board-id="board-3"]')).not.toBeNull();

    initializeBoardSidebar();
    expect(groupByName('Delivery').classList.contains('is-prefix-collapsed')).toBe(true);

    fireEvent.click(prefixToggleFor('Delivery'));
    expect(listGroups()[0].prefixCollapsed).toBe(false);
    expect(groupByName('Delivery').classList.contains('is-prefix-collapsed')).toBe(false);
  });

  test('a group with an unfinished first iteration shows no prefix control', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    mocks.tasksByBoard = {
      'board-2': [{ id: 'task-2', column: 'done' }]
    };

    initializeBoardSidebar();

    expect(prefixToggleFor('Delivery')).toBeNull();
  });

  test('a group whose iterations are all finished shows no prefix control', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    mocks.tasksByBoard = {
      'board-1': [{ id: 'task-1', column: 'done' }],
      'board-2': [{ id: 'task-2', column: 'done' }]
    };

    initializeBoardSidebar();

    expect(prefixToggleFor('Delivery')).toBeNull();
  });
});
