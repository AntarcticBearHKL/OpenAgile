// Column element DOM construction — extracted from render.js

import { loadTasks } from './storage.js';
import { showModal } from './modals.js';
import { HIL_COLUMN_ID } from './constants.js';
import { getWipState } from './wip-limit.js';
import { h } from './dom.js';

function getTaskCountInColumn(columnId) {
  const tasks = loadTasks();
  return tasks.filter(t => t.column === columnId).length;
}

export function createColumnElement(column) {
  const taskCount = getTaskCountInColumn(column.id);

  const columnTitle = h('h2', { id: `column-title-${column.id}` }, column.name);

  const addTaskButton = column.id === HIL_COLUMN_ID
    ? h('button', {
      class: 'add-task-btn-icon',
      type: 'button',
      'aria-label': `Add task to ${column.name}`,
      title: 'Add task',
      onClick: () => showModal(column.id)
    }, h('span', { 'data-lucide': 'plus', 'aria-hidden': 'true' }))
    : null;

  const actionSlot = h('div', { class: 'column-header-slot' }, addTaskButton);

  const headerDiv = h('header', { class: 'column-header' },
    columnTitle, actionSlot);

  const ul = h('ul', {
    class: 'tasks',
    role: 'list',
    'aria-label': `Tasks in ${column.name}`
  });

  return h('article', {
    class: 'task-column',
    'data-column': column.id,
    'data-wip': getWipState(taskCount, column),
    'aria-labelledby': `column-title-${column.id}`,
    style: column?.color ? { '--column-accent': column.color } : {}
  }, headerDiv, ul);
}
