import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
import { listGroups, readBoardGroupMap } from '../../src/modules/board-groups.js';
import { on, EVENT_EMITTED, _resetEventsForTesting } from '../../src/modules/events.js';

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

let fetchMock;
let events = [];

function captureEvent(event) {
  events.push(event.detail);
}

function emitted(type) {
  return events.filter((event) => event.type === type);
}

function flushTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function adoptFromServer(detail) {
  window.dispatchEvent(new CustomEvent('openagile:groups-changed', { detail }));
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
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ groups: [], boardGroups: {} }) }));
  vi.stubGlobal('fetch', fetchMock);
  mountToBody(FIXTURE);
  events = [];
  on(EVENT_EMITTED, captureEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sidebar group sync', () => {
  test('the first render creates one group and binds every board exactly once', async () => {
    initializeBoardSidebar();
    await flushTurn();

    const groups = listGroups();
    expect(groups).toHaveLength(1);
    expect(readBoardGroupMap()).toEqual({ 'board-1': groups[0].id, 'board-2': groups[0].id });
    expect(emitted('group.created')).toHaveLength(1);
    expect(emitted('board.group.assigned')).toHaveLength(2);
  });

  test('a group state pushed by another client is adopted without re-emitting known groups', async () => {
    initializeBoardSidebar();
    await flushTurn();

    const group = listGroups()[0];
    events = [];

    adoptFromServer({
      groups: [{ ...group }],
      boardGroups: { 'board-1': group.id, 'board-2': group.id, 'board-9': group.id }
    });
    await flushTurn();

    expect(readBoardGroupMap()['board-9']).toBe(group.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'board.group.assigned',
      entity_id: 'board-9',
      payload: { group_id: group.id }
    });
  });

  test('the server echo of the local state re-emits nothing and does not rebuild the tree', async () => {
    initializeBoardSidebar();
    await flushTurn();
    const groupsBefore = document.querySelectorAll('#board-list > .board-group').length;
    events = [];

    adoptFromServer({ groups: listGroups(), boardGroups: readBoardGroupMap() });
    await flushTurn();

    expect(events).toHaveLength(0);
    expect(document.querySelectorAll('#board-list > .board-group')).toHaveLength(groupsBefore);
  });

  test('a rename committed in the sidebar emits exactly one group.updated', async () => {
    initializeBoardSidebar();
    await flushTurn();
    const groupId = listGroups()[0].id;
    events = [];

    fireEvent.dblClick(document.querySelector('.board-group-name'));
    const input = document.querySelector('.board-group-rename-input');
    input.value = 'Q3 delivery';
    fireEvent.keyDown(input, { key: 'Enter' });
    await flushTurn();

    expect(listGroups()[0].name).toBe('Q3 delivery');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'group.updated',
      entity_id: groupId,
      payload: { fields: { name: 'Q3 delivery' } }
    });
  });
});
