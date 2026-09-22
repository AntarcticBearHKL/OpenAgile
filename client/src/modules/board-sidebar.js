import { emit, on, DATA_CHANGED } from './events.js';
import { renderIcons } from './icons.js';
import { DONE_COLUMN_ID, isDoneColumn } from './constants.js';
import {
  createBoard,
  deleteBoard as deleteBoardById,
  ensureBoardsInitialized,
  getActiveBoardId,
  listBoards,
  loadColumnsForBoard,
  loadTasksForBoard,
  renameBoard,
  setActiveBoardId
} from './storage.js';
import { createArmedDeleteButton } from './armed-delete-button.js';
import {
  assignBoardToGroup,
  createGroup,
  deleteGroup,
  ensureBoardsGrouped,
  initGroupSync,
  iterationLabel,
  listGroups,
  nextIterationName,
  readBoardGroupMap,
  renameGroup,
  toggleGroupCollapsed,
  toggleGroupPrefixCollapsed
} from './board-groups.js';

function findGroupElement(listEl, groupId) {
  for (const el of listEl.querySelectorAll('.board-group')) {
    if (el.dataset.groupId === groupId) return el;
  }
  return null;
}

function isFinishedIteration(boardId) {
  const tasks = loadTasksForBoard(boardId);
  if (tasks.length === 0) return false;
  const doneColumnId = loadColumnsForBoard(boardId).find(isDoneColumn)?.id || DONE_COLUMN_ID;
  return tasks.every((task) => task.column === doneColumnId || task.column === DONE_COLUMN_ID);
}

export function initializeBoardSidebar() {
  initGroupSync();

  const listEl = document.getElementById('board-list');
  if (!listEl) return;

  const sidebarEl = document.querySelector('.board-sidebar');
  const groupsToggleBtn = document.getElementById('groups-toggle-btn');
  const shellQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 1024px)')
    : null;

  const setDrawerOpen = (open) => {
    if (!sidebarEl) return;
    sidebarEl.classList.toggle('is-open', open);
    groupsToggleBtn?.setAttribute('aria-expanded', String(open));
  };

  const closeDrawer = () => {
    if (!sidebarEl || !sidebarEl.classList.contains('is-open')) return;
    setDrawerOpen(false);
    const active = document.activeElement;
    if (active && sidebarEl.contains(active) && typeof active.blur === 'function') active.blur();
  };

  if (sidebarEl && groupsToggleBtn) {
    const syncToggleAvailability = () => {
      const inShell = shellQuery ? shellQuery.matches : true;
      groupsToggleBtn.disabled = !inShell;
      if (!inShell) setDrawerOpen(false);
    };

    groupsToggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      setDrawerOpen(!sidebarEl.classList.contains('is-open'));
    });

    // Light dismiss: a tap outside (or Escape) closes the drawer and lets the
    // tap through, so the board underneath never becomes unreachable.
    document.addEventListener('pointerdown', (event) => {
      if (!sidebarEl.classList.contains('is-open')) return;
      if (!sidebarEl.contains(event.target)) closeDrawer();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      closeDrawer();
    });

    shellQuery?.addEventListener('change', syncToggleAvailability);
    window.addEventListener('resize', syncToggleAvailability);
    syncToggleAvailability();
  }

  const syncSelect = (id) => {
    const selectEl = document.getElementById('board-select');
    if (selectEl) selectEl.value = id;
  };

  const selectBoard = (boardId) => {
    closeDrawer();
    setActiveBoardId(boardId);
    syncSelect(boardId);
    emit(DATA_CHANGED);
  };

  const startGroupRename = (groupId) => {
    const groupEl = findGroupElement(listEl, groupId);
    const nameEl = groupEl?.querySelector('.board-group-name');
    if (!nameEl) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'board-group-rename-input';
    input.value = nameEl.textContent;
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Group name');

    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      const name = input.value.trim();
      if (commit && name) renameGroup(groupId, name);
      render();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));

    nameEl.replaceWith(input);
    input.focus();
    input.select();
  };

  const openGroupCreateInput = () => {
    if (!shellQuery || shellQuery.matches) setDrawerOpen(true);
    const existing = listEl.querySelector('.board-group-create-input');
    if (existing) {
      existing.focus();
      return;
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'board-group-create-input';
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Group name');

    const row = document.createElement('li');
    row.className = 'board-group-create';
    row.appendChild(input);

    let settled = false;
    const close = () => {
      if (settled) return false;
      settled = true;
      row.remove();
      return true;
    };
    const commit = () => {
      const name = input.value.trim();
      if (!name || !close()) return false;
      createGroup(name);
      render();
      return true;
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!commit()) input.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    input.addEventListener('blur', () => {
      if (input.value.trim()) commit();
      else close();
    });

    listEl.appendChild(row);
    input.focus();
  };

  const buildBoardItem = (board, activeId, label, isLast) => {
    const isActive = board.id === activeId;

    const nameEl = document.createElement('span');
    nameEl.className = 'board-list-item-name';
    nameEl.textContent = label;

    const deleteBtn = isLast
      ? createArmedDeleteButton('board-list-delete', `Delete iteration ${label}`, () => {
          if (deleteBoardById(board.id)) {
            assignBoardToGroup(board.id, null);
            emit(DATA_CHANGED);
          } else {
            render();
          }
        })
      : null;

    const item = document.createElement('li');
    item.className = `board-list-item${isActive ? ' board-list-item--active' : ''}`;
    item.dataset.boardId = board.id;
    item.tabIndex = 0;
    if (isActive) item.setAttribute('aria-current', 'true');

    item.addEventListener('click', (event) => {
      if (event.target.closest('.board-list-delete')) return;
      selectBoard(board.id);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectBoard(board.id);
      }
    });

    item.append(nameEl);
    if (deleteBtn) item.append(deleteBtn);
    return item;
  };

  const buildGroupElement = (group, boards, activeId) => {
    const isCollapsed = group.collapsed === true;

    const toggle = () => {
      if (toggleGroupCollapsed(group.id)) render();
    };

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'board-group-toggle';
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    toggleBtn.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${group.name}`);
    toggleBtn.title = isCollapsed ? 'Expand' : 'Collapse';
    toggleBtn.innerHTML = `<span data-lucide="${isCollapsed ? 'chevron-right' : 'chevron-down'}" aria-hidden="true"></span>`;
    toggleBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'board-group-name';
    nameEl.textContent = group.name;
    nameEl.title = isCollapsed
      ? 'Click to expand, double-click to rename'
      : 'Click to collapse, double-click to rename';
    nameEl.setAttribute('role', 'button');
    nameEl.tabIndex = 0;
    nameEl.setAttribute('aria-expanded', String(!isCollapsed));

    let pendingToggle = null;
    nameEl.addEventListener('click', (event) => {
      event.stopPropagation();
      clearTimeout(pendingToggle);
      // Deferred so a double-click can cancel the toggle before rename replaces this node.
      pendingToggle = setTimeout(() => {
        pendingToggle = null;
        if (nameEl.isConnected) toggle();
      }, 200);
    });
    nameEl.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      clearTimeout(pendingToggle);
      pendingToggle = null;
      startGroupRename(group.id);
    });
    nameEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'board-group-add';
    addBtn.title = 'New iteration';
    addBtn.setAttribute('aria-label', `New iteration in ${group.name}`);
    addBtn.innerHTML = '<span data-lucide="plus" aria-hidden="true"></span>';
    addBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const board = createBoard(nextIterationName(group.id));
      setActiveBoardId(board.id);
      assignBoardToGroup(board.id, group.id);
      closeDrawer();
      emit(DATA_CHANGED);
      document.dispatchEvent(new CustomEvent('kanban:boards-changed'));
    });

    const iterationCount = boards.length;
    const deleteLabel = iterationCount > 0
      ? `Delete group ${group.name} and its ${iterationCount} iteration${iterationCount === 1 ? '' : 's'}`
      : `Delete group ${group.name}`;
    const deleteBtn = createArmedDeleteButton('board-group-delete', deleteLabel, () => {
      // Iterations first: deleteGroup on its own only unassigns them.
      for (const board of boards) deleteBoardById(board.id);
      deleteGroup(group.id);
      render();
    });

    const actions = document.createElement('div');
    actions.className = 'board-group-actions';
    actions.append(addBtn, deleteBtn);

    const header = document.createElement('div');
    header.className = 'board-group-header';
    header.append(toggleBtn, nameEl, actions);

    const items = document.createElement('ul');
    items.className = 'board-group-items';
    items.setAttribute('aria-label', `${group.name} iterations`);

    const finishedPrefix = [];
    let reachedLiveIteration = false;
    for (const board of boards) {
      if (!reachedLiveIteration && isFinishedIteration(board.id)) finishedPrefix.push(board);
      else reachedLiveIteration = true;
    }
    const hasFinishedPrefix = finishedPrefix.length > 0 && finishedPrefix.length < boards.length;
    const isPrefixCollapsed = hasFinishedPrefix && group.prefixCollapsed === true;

    if (hasFinishedPrefix) {
      const prefixToggle = document.createElement('button');
      prefixToggle.type = 'button';
      prefixToggle.className = 'board-group-prefix-toggle';
      prefixToggle.setAttribute('aria-expanded', String(!isPrefixCollapsed));
      prefixToggle.setAttribute(
        'aria-label',
        `${isPrefixCollapsed ? 'Show' : 'Hide'} ${finishedPrefix.length} finished iteration${finishedPrefix.length === 1 ? '' : 's'} in ${group.name}`
      );
      prefixToggle.title = isPrefixCollapsed ? 'Show finished iterations' : 'Hide finished iterations';
      prefixToggle.innerHTML = `<span data-lucide="${isPrefixCollapsed ? 'chevron-down' : 'chevron-up'}" aria-hidden="true"></span><span>${isPrefixCollapsed ? 'Show' : 'Hide'} ${finishedPrefix.length} finished</span>`;
      prefixToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (toggleGroupPrefixCollapsed(group.id)) render();
      });

      const prefixItem = document.createElement('li');
      prefixItem.className = 'board-group-prefix';
      prefixItem.appendChild(prefixToggle);
      items.appendChild(prefixItem);
    }

    const finishedPrefixIds = new Set(finishedPrefix.map((board) => board.id));
    boards.forEach((board, index) => {
      const item = buildBoardItem(board, activeId, iterationLabel(index), index === boards.length - 1);
      if (finishedPrefixIds.has(board.id)) item.classList.add('board-list-item--finished-prefix');
      items.appendChild(item);
    });

    const groupEl = document.createElement('li');
    groupEl.className = `board-group${isCollapsed ? ' is-collapsed' : ''}${isPrefixCollapsed ? ' is-prefix-collapsed' : ''}`;
    groupEl.dataset.groupId = group.id;
    groupEl.append(header, items);
    return groupEl;
  };

  let rendering = false;

  const render = () => {
    // renameBoard emits DATA_CHANGED synchronously, so this render can re-enter itself.
    if (rendering) return;
    rendering = true;
    try {
      ensureBoardsInitialized();
      const boards = listBoards();
      const activeId = getActiveBoardId();
      const boardIds = boards.map((board) => board.id);

      ensureBoardsGrouped(boardIds);

      const groups = listGroups();
      const boardGroupMap = readBoardGroupMap();
      const knownGroupIds = new Set(groups.map((group) => group.id));
      const buckets = new Map(groups.map((group) => [group.id, []]));

      for (const board of boards) {
        const groupId = boardGroupMap[board.id];
        if (groupId && knownGroupIds.has(groupId)) buckets.get(groupId).push(board);
      }

      groups.forEach((group) => {
        (buckets.get(group.id) || []).forEach((board, index) => {
          const label = iterationLabel(index);
          if (board.name !== label) renameBoard(board.id, label);
        });
      });

      listEl.innerHTML = '';
      groups.forEach((group) => {
        listEl.appendChild(buildGroupElement(group, buckets.get(group.id) || [], activeId));
      });

      renderIcons();
    } finally {
      rendering = false;
    }
  };

  render();
  on(DATA_CHANGED, render);

  document.getElementById('add-group-btn')?.addEventListener('click', openGroupCreateInput);
}
