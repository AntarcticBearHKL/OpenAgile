// Phone column switcher — the five columns become tabs, one shown at a time.
//
// The phone shell used to lay the columns out as a horizontally scrolling snap
// rail, which asks the user to swipe sideways between them. On a phone the
// switcher replaces that rail: a sticky segmented tab bar above the board, one
// column filling the remaining height, its card list scrolling vertically.
//
// All five columns stay in the DOM. Selection only toggles attributes and
// classes (`#board-container[data-mobile-active-column]` plus
// `.task-column.is-mobile-active`) and the shell hides the unselected ones, so
// every desktop/tablet selector, bound listener and test stays intact.
//
// Selection is per-device UI state: it lives in this module (mirrored to
// localStorage) and is never written into the event-sourced board state.

import { BACKLOG_COLUMN_ID } from './constants.js';
import { h, cx } from './dom.js';

// The exact phone band the shell draws (see responsive.css): the ≤600px
// portrait band plus the short-landscape clause.
export const PHONE_BOARD_MEDIA_QUERY =
  '(max-width: 600px), (max-width: 920px) and (orientation: landscape) and (max-height: 500px)';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const STORAGE_KEY = 'openagile:mobile-active-column';
const SWITCHER_CLASS = 'mobile-column-switcher';
const TAB_CLASS = 'mobile-column-tab';
const ACTIVE_COLUMN_CLASS = 'is-mobile-active';

let activeColumnId = null;
let mountedSwitcher = null;
let mountedContainer = null;

const tabId = (columnId) => `mobile-column-tab-${columnId}`;
const panelId = (columnId) => `mobile-column-panel-${columnId}`;

function mediaMatches(query) {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(query).matches === true;
  } catch {
    return false;
  }
}

// True inside the phone band. Falls back to a width check when matchMedia is
// unavailable (very old engines, jsdom), which keeps the DOM roles honest.
export function isPhoneBoardViewport() {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return mediaMatches(PHONE_BOARD_MEDIA_QUERY);
  return Number.isFinite(window.innerWidth) && window.innerWidth <= 600;
}

function readStoredColumnId() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function storeColumnId(columnId) {
  try {
    window.localStorage.setItem(STORAGE_KEY, columnId);
  } catch {
    /* private mode / storage disabled — the in-memory selection still works */
  }
}

export function getMobileActiveColumnId() {
  return activeColumnId;
}

export function setMobileActiveColumnId(columnId, { persist = true } = {}) {
  const id = typeof columnId === 'string' ? columnId.trim() : '';
  if (!id) return activeColumnId;
  activeColumnId = id;
  if (persist) storeColumnId(id);
  return activeColumnId;
}

// Preference order: the column already on screen, then the column the user
// picked in an earlier session, then the first column holding tasks, then
// Backlog (the first column in board order).
export function resolveMobileActiveColumnId(columns, visibleTasks = []) {
  const list = (Array.isArray(columns) ? columns : []).filter((column) => column?.id);
  if (list.length === 0) return null;

  const known = new Set(list.map((column) => column.id));
  if (activeColumnId && known.has(activeColumnId)) return activeColumnId;

  const stored = readStoredColumnId();
  if (stored && known.has(stored)) {
    activeColumnId = stored;
    return stored;
  }

  const tasks = Array.isArray(visibleTasks) ? visibleTasks : [];
  const firstWithTasks = list.find((column) => tasks.some((task) => task.column === column.id));
  const fallback = firstWithTasks
    ? firstWithTasks.id
    : (known.has(BACKLOG_COLUMN_ID) ? BACKLOG_COLUMN_ID : list[0].id);

  activeColumnId = fallback;
  return fallback;
}

function countTasks(visibleTasks, columnId) {
  return visibleTasks.filter((task) => task.column === columnId).length;
}

function onTabKeydown(event) {
  const tab = event.currentTarget;
  const switcher = tab?.parentElement;
  if (!switcher) return;

  const tabs = [...switcher.querySelectorAll(`.${TAB_CLASS}`)];
  const index = tabs.indexOf(tab);
  if (index === -1) return;

  let nextIndex = null;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  // Tab, Escape and everything else fall through untouched: the strip is
  // navigable but never traps focus.
  if (nextIndex === null) return;

  event.preventDefault();
  selectMobileColumn(tabs[nextIndex].dataset.column, { focus: true });
}

export function selectMobileColumn(columnId, { focus = false } = {}) {
  const id = setMobileActiveColumnId(columnId);
  if (!id) return null;
  applyMobileColumnSelection();
  if (focus) {
    const tab = mountedSwitcher?.querySelector(`.${TAB_CLASS}.is-active`);
    if (tab && typeof tab.focus === 'function') tab.focus();
  }
  return id;
}

function buildTab(column, count, isActive) {
  const tab = h('button', {
    type: 'button',
    class: cx(TAB_CLASS, isActive && 'is-active'),
    role: 'tab',
    id: tabId(column.id),
    'aria-controls': panelId(column.id),
    'aria-selected': String(isActive),
    'aria-label': `${column.name}, ${count} task${count === 1 ? '' : 's'}`,
    tabindex: isActive ? '0' : '-1',
    'data-column': column.id,
    title: column.name,
    style: column?.color ? { '--column-accent': column.color } : {},
    onClick: () => selectMobileColumn(column.id)
  },
    h('span', { class: 'mobile-column-tab-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'mobile-column-tab-name', 'aria-hidden': 'true' }, column.name),
    h('span', { class: 'mobile-column-tab-count', 'aria-hidden': 'true' }, String(count))
  );
  tab.addEventListener('keydown', onTabKeydown);
  return tab;
}

export function createMobileColumnSwitcher(columns, visibleTasks = []) {
  const switcher = h('div', {
    class: SWITCHER_CLASS,
    role: 'tablist',
    'aria-label': 'Board columns',
    'aria-orientation': 'horizontal'
  });

  columns.forEach((column) => {
    switcher.appendChild(buildTab(column, countTasks(visibleTasks, column.id), column.id === activeColumnId));
  });

  return switcher;
}

function revealActiveTab(switcher) {
  if (!isPhoneBoardViewport()) return;
  const tab = switcher.querySelector(`.${TAB_CLASS}.is-active`);
  // The strip fits five tabs at 320px today, so this is a guard rather than a
  // routine move: a longer name or an extra tab must never hide the selection.
  if (!tab || typeof tab.scrollIntoView !== 'function') return;
  try {
    tab.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: mediaMatches(REDUCED_MOTION_QUERY) ? 'auto' : 'smooth'
    });
  } catch {
    /* best-effort only */
  }
}

// Re-apply the selection to whatever is currently mounted. Idempotent, so it is
// safe to call on mount, on selection and from tests.
export function applyMobileColumnSelection() {
  const container = mountedContainer?.isConnected
    ? mountedContainer
    : document.getElementById('board-container');
  if (!container) return;

  const switcher = mountedSwitcher?.isConnected
    ? mountedSwitcher
    : document.querySelector(`.${SWITCHER_CLASS}`);

  const panels = [...container.children].filter((el) => el.classList.contains('task-column'));

  const knownIds = panels.map((el) => el.dataset.column);
  if (knownIds.length === 0) {
    container.removeAttribute('data-mobile-active-column');
    return;
  }

  // Never leave the board with every column hidden: if the remembered id is not
  // on this board, fall back to the first column present.
  if (!knownIds.includes(activeColumnId)) {
    activeColumnId = knownIds[0];
  }
  const activeId = activeColumnId;
  const phone = isPhoneBoardViewport();

  container.dataset.mobileActiveColumn = activeId;

  panels.forEach((columnEl) => {
    const isActive = columnEl.dataset.column === activeId;
    columnEl.classList.toggle(ACTIVE_COLUMN_CLASS, isActive);
    if (phone) {
      columnEl.setAttribute('role', 'tabpanel');
      columnEl.setAttribute('id', panelId(columnEl.dataset.column));
    } else {
      if (columnEl.getAttribute('role') === 'tabpanel') columnEl.removeAttribute('role');
      if (columnEl.id === panelId(columnEl.dataset.column)) columnEl.removeAttribute('id');
    }
  });

  if (!switcher) return;
  switcher.querySelectorAll(`.${TAB_CLASS}`).forEach((tab) => {
    const isActive = tab.dataset.column === activeId;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
    // aria-controls tracks the panel role exactly: both exist only in the phone
    // column layout, where one element really is the panel for one tab.
    if (phone) tab.setAttribute('aria-controls', panelId(tab.dataset.column));
    else tab.removeAttribute('aria-controls');
  });
  revealActiveTab(switcher);
}

// Rebuilt on every render — renderBoard() replaces #board-container wholesale,
// so the switcher beside it is rebuilt from the same column/task snapshot.
export function mountMobileColumnSwitcher(boardContainer, columns, visibleTasks = []) {
  removeMobileColumnSwitcher();

  const list = (Array.isArray(columns) ? columns : []).filter((column) => column?.id);
  if (!boardContainer || list.length === 0) return null;

  resolveMobileActiveColumnId(list, visibleTasks);

  const switcher = createMobileColumnSwitcher(list, visibleTasks);
  const host = boardContainer.parentElement;
  if (host) host.insertBefore(switcher, boardContainer);
  else boardContainer.insertBefore(switcher, boardContainer.firstChild);

  mountedSwitcher = switcher;
  mountedContainer = boardContainer;
  applyMobileColumnSelection();
  return switcher;
}

export function removeMobileColumnSwitcher() {
  document.querySelectorAll(`.${SWITCHER_CLASS}`).forEach((el) => el.remove());
  mountedSwitcher = null;
  mountedContainer = null;
}

export function _resetMobileColumnSwitcherForTesting() {
  activeColumnId = null;
  mountedSwitcher = null;
  mountedContainer = null;
}
