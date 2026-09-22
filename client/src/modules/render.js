// Thin orchestrator — delegates to task-card.js and column-element.js

import { listBoards, loadColumns, loadTasks, loadSettings } from './storage.js';
import { renderIcons } from './icons.js';
import { on, DATA_CHANGED } from './events.js';
import { createTaskElement } from './task-card.js';
import { createColumnElement } from './column-element.js';
import { syncColumnWip } from './wip-limit.js';
import { selectVisibleTasks, buildShowMoreButton, selectColumnRenderPlan } from './board-filters.js';
import { mountMobileColumnSwitcher, removeMobileColumnSwitcher } from './mobile-column-switcher.js';

// Subscribe to the event bus so any module can trigger a re-render
// without importing render.js directly (eliminates circular deps).
on(DATA_CHANGED, (event) => {
  // A skills or board-group change (tagged affectsBoard:false) is out-of-band
  // state: it refreshes its own UI — the skills modal and the board sidebar
  // both listen on DATA_CHANGED — but never changes what the board shows, so
  // it must not pay for a full rebuild. Every other DATA_CHANGED still renders.
  if (event.detail?.affectsBoard === false) return;
  renderBoard();
});

function renderStandardBoard(container, sortedColumns, visibleTasks, settings) {
  sortedColumns.forEach(column => {
    const columnEl = createColumnElement(column);
    container.appendChild(columnEl);

    const tasksList = columnEl.querySelector('.tasks');

    const { columnTasks, tasksToRender, remaining } = selectColumnRenderPlan(column.id, visibleTasks);

    tasksToRender.forEach(task => {
      tasksList.appendChild(createTaskElement(task, settings));
    });

    if (remaining > 0) {
      tasksList.appendChild(buildShowMoreButton(remaining, renderBoard));
    }

    syncColumnWip(columnEl, columnTasks.length, column);
  });
}

// Render all columns and tasks
export function renderBoard() {
  const boardContainer = document.getElementById('board-container');
  if (boardContainer && listBoards().length === 0) {
    removeMobileColumnSwitcher();
    boardContainer.innerHTML = '<div class="board-empty-state"><p class="board-empty-title">No iterations yet</p><p class="board-empty-hint">Open Groups and use the + button next to a group to create one.</p></div>';
    boardContainer.dataset.viewMode = 'empty';
    renderIcons();
    return;
  }

  const columns = loadColumns();
  const tasks = loadTasks();
  const settings = loadSettings();

  const visibleTasks = selectVisibleTasks(tasks);
  const container = document.getElementById('board-container');
  removeMobileColumnSwitcher();
  container.innerHTML = '';
  container.dataset.viewMode = 'columns';

  const sortedColumns = [...columns].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  renderStandardBoard(container, sortedColumns, visibleTasks, settings);

  mountMobileColumnSwitcher(container, sortedColumns, visibleTasks);

  renderIcons();

  performance.mark('openagile:board-render:full');
}
