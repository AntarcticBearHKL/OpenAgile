// Task row DOM construction — extracted from render.js

import { deleteTask } from './tasks.js';
import { isDoneColumnId } from './storage.js';
import { showEditModal } from './modals.js';
import { createArmedDeleteController } from './armed-delete-button.js';
import { renderIcons } from './icons.js';
import { h } from './dom.js';
import { BACKLOG_COLUMN_ID, BLOCKED_COLUMN_ID, FIXED_COLUMNS, canonicalColumnId } from './constants.js';

const SIGNAL_COLUMN_IDS = new Set([BACKLOG_COLUMN_ID, BLOCKED_COLUMN_ID, FIXED_COLUMNS[4].id]);

// Safely convert URLs in text to <a> elements. Returns a DocumentFragment.
// Only http/https URLs are matched; DOM APIs prevent XSS.
export function linkifyText(text) {
  const URL_RE = /https?:\/\/[^\s<>"']+/g;
  const frag = document.createDocumentFragment();
  let last = 0;
  let match;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > last) {
      frag.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const a = document.createElement('a');
    a.href = match[0];
    // Guard: only allow http/https even after DOM parsing
    if (a.protocol !== 'https:' && a.protocol !== 'http:') {
      frag.appendChild(document.createTextNode(match[0]));
    } else {
      a.textContent = match[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.addEventListener('click', (e) => e.stopPropagation());
      frag.appendChild(a);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function buildTaskSignal(task) {
  if (!SIGNAL_COLUMN_IDS.has(canonicalColumnId(task.column))) return null;

  const flags = [];
  if (task.needsDigest === true) flags.push('Needs digest');
  if (task.isRework === true) flags.push('Rework');
  if (flags.length === 0) return null;

  const label = flags.join(' · ');
  const humanChanged = task.needsDigest === true;
  return h('span', {
    class: `task-signal ${humanChanged ? 'task-signal--digest' : 'task-signal--rework'}`,
    'data-signal': humanChanged ? 'needs-digest' : 'rework',
    title: label,
    'aria-label': label
  },
    h('span', {
      class: 'task-signal-icon',
      'data-lucide': humanChanged ? 'message-square' : 'history',
      'aria-hidden': 'true'
    }),
    h('span', { class: 'task-signal-label' }, label));
}

function buildKeyPointsList(task) {
  const keyPoints = Array.isArray(task.keyPoints) ? task.keyPoints : [];
  if (keyPoints.length === 0) return null;
  const list = h('ul', { class: 'task-key-points', 'aria-label': 'Key points' });
  keyPoints.forEach((point) => {
    list.appendChild(h('li', { class: 'task-key-point' }, point.text));
  });
  return list;
}

export function createTaskElement(task, settings) {
  // Track pointer position to distinguish clicks from drag gestures.
  let pointerDownPos = null;
  const li = h('li', {
    class: 'task',
    'data-task-id': task.id,
    role: 'listitem',
    'aria-label': `Task: ${task.title || task.text || 'Untitled'}`
  });
  li.addEventListener('pointerdown', (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
  });
  li.addEventListener('click', (e) => {
    if (e.target.closest('.delete-task-btn')) return;
    if (pointerDownPos) {
      const dx = Math.abs(e.clientX - pointerDownPos.x);
      const dy = Math.abs(e.clientY - pointerDownPos.y);
      if (dx > 5 || dy > 5) return;
    }
    showEditModal(task.id);
  });

  const legacyTitle = typeof task.text === 'string' ? task.text : '';
  const titleEl = h('span', { class: 'task-title' },
    (typeof task.title === 'string' && task.title.trim() !== '') ? task.title : legacyTitle
  );

  const actions = h('div', { class: 'task-actions' });

  if (!isDoneColumnId(task.column)) {
    const deleteLabel = 'Delete task';
    const deleteIconHtml = '<span data-lucide="trash-2" aria-hidden="true"></span>';
    const deleteBtn = document.createElement('button');
    deleteBtn.classList.add('delete-task-btn');
    deleteBtn.setAttribute('aria-label', deleteLabel);
    deleteBtn.title = deleteLabel;
    deleteBtn.type = 'button';
    deleteBtn.innerHTML = deleteIconHtml;

    const armedDelete = createArmedDeleteController({
      button: deleteBtn,
      armedContent: '!',
      armedTitle: 'Click again to confirm',
      armedAria: 'Click again to confirm delete',
      onRestore: () => {
        deleteBtn.innerHTML = deleteIconHtml;
        deleteBtn.title = deleteLabel;
        deleteBtn.setAttribute('aria-label', deleteLabel);
        renderIcons();
      },
      onConfirm: () => deleteTask(task.id)
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      armedDelete.handleClick();
    });

    actions.appendChild(deleteBtn);
  }

  li.appendChild(h('div', { class: 'task-row' }, titleEl, actions));

  const description = typeof task.description === 'string' ? task.description.trim() : '';
  if (description) {
    li.appendChild(h('span', { class: 'task-description-preview', title: description }, description));
  }

  const keyPointsList = buildKeyPointsList(task);
  if (keyPointsList) li.appendChild(keyPointsList);

  const signal = buildTaskSignal(task);
  if (signal) li.appendChild(signal);

  return li;
}
