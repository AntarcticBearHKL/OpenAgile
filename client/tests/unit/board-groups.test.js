import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetLocalStorage } from './setup.js';
import { DATA_CHANGED, EVENT_EMITTED, off, on } from '../../src/modules/events.js';
import {
  BOARD_GROUP_KEY,
  GROUPS_KEY,
  adoptGroupsState,
  assignBoardToGroup,
  createGroup,
  deleteGroup,
  ensureBoardsGrouped,
  getGroupIdForBoard,
  iterationLabel,
  listGroups,
  nextIterationName,
  pruneBoardGroups,
  readBoardGroupMap,
  renameGroup,
  setGroupCollapsed,
  setGroupPrefixCollapsed,
  toggleGroupCollapsed,
  toggleGroupPrefixCollapsed
} from '../../src/modules/board-groups.js';

beforeEach(() => {
  resetLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function collectEvents() {
  const events = [];
  const handler = (event) => events.push(event.detail);
  on(EVENT_EMITTED, handler);
  return { events, stop: () => off(EVENT_EMITTED, handler) };
}

describe('group store', () => {
  test('starts with no groups', () => {
    expect(listGroups()).toEqual([]);
  });

  test('createGroup emits group.created and exposes the group through the projection', () => {
    const captured = collectEvents();
    const group = createGroup('Q3 work');
    captured.stop();

    expect(group.id).toBeTruthy();
    expect(group.name).toBe('Q3 work');
    expect(group.order).toBe(1);
    expect(group.collapsed).toBe(false);
    expect(group.prefixCollapsed).toBe(false);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      type: 'group.created',
      scope: 'global',
      board_id: null,
      entity_id: group.id,
      payload: { group }
    });
    expect(listGroups()).toEqual([group]);
  });

  test('createGroup falls back to New Group when the name is blank', () => {
    expect(createGroup('   ').name).toBe('New Group');
    expect(createGroup().name).toBe('New Group');

    const groups = listGroups();
    expect(groups.map((group) => group.name)).toEqual(['New Group', 'New Group']);
    expect(groups.map((group) => group.order)).toEqual([1, 2]);
  });

  test('renameGroup changes the stored name without touching the order', () => {
    const group = createGroup('Draft');
    createGroup('Later');

    expect(renameGroup(group.id, '  Q3 delivery  ')).toBe(true);

    const groups = listGroups();
    expect(groups.map((group) => group.name)).toEqual(['Q3 delivery', 'Later']);
    expect(groups.map((group) => group.order)).toEqual([1, 2]);
  });

  test('renameGroup rejects blank names and unknown ids', () => {
    const group = createGroup('Draft');

    expect(renameGroup(group.id, '   ')).toBe(false);
    expect(renameGroup('missing', 'Name')).toBe(false);
    expect(listGroups().map((entry) => entry.name)).toEqual(['Draft']);
  });

  test('listGroups migrates legacy localStorage groups, sorts by order, and falls back to Untitled group', () => {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([
      { id: 'a', name: 'Hand typed', order: 2, collapsed: false },
      { id: 'b', order: 1, collapsed: true }
    ]));

    const groups = listGroups();
    expect(groups.map((group) => group.id)).toEqual(['b', 'a']);
    expect(groups.map((group) => group.name)).toEqual(['Untitled group', 'Hand typed']);
    expect(localStorage.getItem('openagile:groupsMigrated')).toBe('1');
  });

  test('toggleGroupCollapsed flips and persists the collapsed flag', () => {
    const group = createGroup();
    expect(toggleGroupCollapsed(group.id)).toBe(true);
    expect(listGroups()[0].collapsed).toBe(true);
    expect(toggleGroupCollapsed(group.id)).toBe(true);
    expect(listGroups()[0].collapsed).toBe(false);
  });

  test('toggleGroupCollapsed emits a single-field group.updated event', () => {
    const group = createGroup();
    const captured = collectEvents();

    expect(toggleGroupCollapsed(group.id)).toBe(true);
    captured.stop();

    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      type: 'group.updated',
      scope: 'global',
      entity_id: group.id,
      payload: { fields: { collapsed: true } }
    });
  });

  test('setting a collapse flag it already has emits nothing', () => {
    const group = createGroup();
    const captured = collectEvents();

    expect(setGroupCollapsed(group.id, false)).toBe(true);
    expect(setGroupPrefixCollapsed(group.id, false)).toBe(true);
    captured.stop();

    expect(captured.events).toHaveLength(0);
  });

  test('setGroupCollapsed is a no-op for unknown groups', () => {
    expect(setGroupCollapsed('missing', true)).toBe(false);
    expect(listGroups()).toEqual([]);
  });

  test('toggleGroupPrefixCollapsed flips and persists the prefix flag', () => {
    const group = createGroup();
    expect(group.prefixCollapsed).toBe(false);
    expect(toggleGroupPrefixCollapsed(group.id)).toBe(true);
    expect(listGroups()[0].prefixCollapsed).toBe(true);
    expect(toggleGroupPrefixCollapsed(group.id)).toBe(true);
    expect(listGroups()[0].prefixCollapsed).toBe(false);
  });

  test('setGroupPrefixCollapsed is a no-op for unknown groups', () => {
    expect(setGroupPrefixCollapsed('missing', true)).toBe(false);
    expect(listGroups()).toEqual([]);
  });

  test('deleteGroup removes the group and unassigns its boards', () => {
    const group = createGroup();
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);

    expect(deleteGroup(group.id)).toBe(true);
    expect(listGroups()).toEqual([]);
    expect(readBoardGroupMap()).toEqual({});
  });

  test('deleteGroup emits group.deleted plus one explicit unbind per bound board', () => {
    const group = createGroup();
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    const captured = collectEvents();

    expect(deleteGroup(group.id)).toBe(true);
    captured.stop();

    expect(captured.events.map((event) => [event.type, event.entity_id])).toEqual([
      ['group.deleted', group.id],
      ['board.group.assigned', 'board-1'],
      ['board.group.assigned', 'board-2']
    ]);
    expect(captured.events.slice(1).map((event) => event.payload.group_id)).toEqual([null, null]);
  });

  test('deleteGroup ignores unknown ids', () => {
    expect(deleteGroup('missing')).toBe(false);
  });

  test('deleteGroup keeps the names and order of the groups that remain', () => {
    createGroup('First');
    const middle = createGroup('Second');
    createGroup('Third');

    expect(deleteGroup(middle.id)).toBe(true);

    const groups = listGroups();
    expect(groups.map((group) => group.name)).toEqual(['First', 'Third']);
    expect(groups.map((group) => group.order)).toEqual([1, 3]);
  });

  test('ensureBoardsGrouped attaches ungrouped boards to the last group', () => {
    createGroup();
    const last = createGroup();

    expect(ensureBoardsGrouped(['board-1', 'board-2'])).toBe(last.id);
    expect(readBoardGroupMap()).toEqual({ 'board-1': last.id, 'board-2': last.id });
  });

  test('ensureBoardsGrouped creates a group when none exists', () => {
    const targetId = ensureBoardsGrouped(['board-1', 'board-2']);

    expect(listGroups()).toHaveLength(1);
    expect(listGroups()[0].name).toBe('New Group');
    expect(readBoardGroupMap()).toEqual({ 'board-1': targetId, 'board-2': targetId });
  });

  test('iterationLabel numbers from one', () => {
    expect(iterationLabel(0)).toBe('Iteration 1');
    expect(iterationLabel(2)).toBe('Iteration 3');
  });

  test('nextIterationName counts the boards already in the target group', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);

    expect(nextIterationName(group.id)).toBe('Iteration 3');
  });

  test('nextIterationName targets the last group when no group is given', () => {
    createGroup('First');
    const last = createGroup('Last');
    assignBoardToGroup('board-1', last.id);

    expect(nextIterationName(null)).toBe('Iteration 2');
  });

  test('nextIterationName starts at Iteration 1 with no groups', () => {
    expect(nextIterationName(null)).toBe('Iteration 1');
    expect(nextIterationName('missing')).toBe('Iteration 1');
  });

  test('ensureBoardsGrouped ignores boards that are already grouped', () => {
    const group = createGroup();
    assignBoardToGroup('board-1', group.id);

    expect(ensureBoardsGrouped(['board-1'])).toBeNull();
    expect(readBoardGroupMap()).toEqual({ 'board-1': group.id });
    expect(listGroups()).toHaveLength(1);
  });

  test('listGroups ignores malformed records and sorts by order', () => {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([
      { id: 'b', name: 'B', order: 5, collapsed: false },
      { name: 'no id' },
      null,
      { id: 'a', name: 'A', order: 2, collapsed: true }
    ]));

    const groups = listGroups();
    expect(groups.map((group) => group.id)).toEqual(['a', 'b']);
    expect(groups[0].collapsed).toBe(true);
  });

  test('listGroups survives invalid JSON', () => {
    localStorage.setItem(GROUPS_KEY, '{not json');
    expect(listGroups()).toEqual([]);
  });

  test('legacy localStorage groups migrate once and are not re-emitted on later reads', () => {
    localStorage.setItem(GROUPS_KEY, JSON.stringify([{ id: 'legacy-1', name: 'Legacy', order: 1 }]));
    localStorage.setItem(BOARD_GROUP_KEY, JSON.stringify({ 'board-1': 'legacy-1' }));

    const captured = collectEvents();
    listGroups();
    listGroups();
    captured.stop();

    expect(captured.events.map((event) => event.type)).toEqual([
      'group.created',
      'board.group.assigned'
    ]);
    expect(getGroupIdForBoard('board-1')).toBe('legacy-1');
  });

  test('legacy localStorage groups are the migration source only until the projection has groups', () => {
    createGroup('Live');

    const captured = collectEvents();
    localStorage.setItem(GROUPS_KEY, JSON.stringify([{ id: 'stale', name: 'Stale', order: 9 }]));
    listGroups();
    captured.stop();

    expect(captured.events).toHaveLength(0);
    expect(listGroups().map((group) => group.id)).not.toContain('stale');
  });
});

describe('board → group mapping', () => {
  test('assignBoardToGroup emits board.group.assigned and the projection exposes the mapping', () => {
    const group = createGroup();
    const captured = collectEvents();
    expect(assignBoardToGroup('board-1', group.id)).toBe(true);
    captured.stop();

    expect(getGroupIdForBoard('board-1')).toBe(group.id);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      type: 'board.group.assigned',
      scope: 'global',
      board_id: null,
      entity_id: 'board-1',
      payload: { group_id: group.id }
    });
  });

  test('assigning the mapping it already has emits nothing', () => {
    const group = createGroup();
    assignBoardToGroup('board-1', group.id);
    const captured = collectEvents();

    expect(assignBoardToGroup('board-1', group.id)).toBe(true);
    captured.stop();

    expect(captured.events).toHaveLength(0);
  });

  test('assignBoardToGroup with a null group removes the mapping (Ungrouped)', () => {
    const group = createGroup();
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-1', null);

    expect(readBoardGroupMap()).toEqual({});
    expect(getGroupIdForBoard('board-1')).toBeNull();
  });

  test('assignBoardToGroup falls back to Ungrouped for unknown group ids', () => {
    assignBoardToGroup('board-1', 'does-not-exist');
    expect(readBoardGroupMap()).toEqual({});
  });

  test('getGroupIdForBoard returns null for unknown boards', () => {
    expect(getGroupIdForBoard('missing')).toBeNull();
    expect(getGroupIdForBoard('')).toBeNull();
  });

  test('pruneBoardGroups drops mappings for boards that no longer exist', () => {
    const group = createGroup();
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);

    expect(pruneBoardGroups(['board-1'])).toBe(true);
    expect(readBoardGroupMap()).toEqual({ 'board-1': group.id });
    expect(pruneBoardGroups(['board-1'])).toBe(false);
  });
});

describe('group event emission', () => {
  test('a burst of writes emits one event per mutation with no debounce', () => {
    const captured = collectEvents();

    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    assignBoardToGroup('board-2', group.id);
    captured.stop();

    expect(captured.events.map((event) => event.type)).toEqual([
      'group.created',
      'board.group.assigned',
      'board.group.assigned'
    ]);
    expect(captured.events.slice(1).map((event) => event.payload.group_id)).toEqual([
      group.id,
      group.id
    ]);
  });

  test('renaming a group to the name it already has emits nothing', () => {
    const group = createGroup('Delivery');
    const captured = collectEvents();

    expect(renameGroup(group.id, 'Delivery')).toBe(true);
    captured.stop();

    expect(captured.events).toHaveLength(0);
  });

  test('the server echo of the local state is not re-emitted', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    const captured = collectEvents();

    expect(adoptGroupsState({ groups: listGroups(), boardGroups: readBoardGroupMap() })).toBe(false);
    captured.stop();

    expect(captured.events).toHaveLength(0);
  });

  test('adopting the state that is already stored emits nothing', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);

    const changed = vi.fn();
    on(DATA_CHANGED, changed);
    const captured = collectEvents();

    expect(adoptGroupsState({ groups: listGroups(), boardGroups: readBoardGroupMap() })).toBe(false);
    captured.stop();

    expect(changed).not.toHaveBeenCalled();
    expect(captured.events).toHaveLength(0);
  });

  test('a state from another client is adopted once through events and stays adopted', () => {
    const group = createGroup('Delivery');
    assignBoardToGroup('board-1', group.id);
    const captured = collectEvents();

    expect(adoptGroupsState({
      groups: listGroups(),
      boardGroups: { ...readBoardGroupMap(), 'board-9': group.id }
    })).toBe(true);
    captured.stop();

    expect(readBoardGroupMap()['board-9']).toBe(group.id);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      type: 'board.group.assigned',
      entity_id: 'board-9',
      payload: { group_id: group.id }
    });

    expect(adoptGroupsState({ groups: listGroups(), boardGroups: readBoardGroupMap() })).toBe(false);
    expect(readBoardGroupMap()['board-9']).toBe(group.id);
  });
});
