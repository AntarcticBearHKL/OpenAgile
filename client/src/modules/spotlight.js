import { renderIcons } from './icons.js';
import { loadColumns, loadTasks } from './storage.js';
import { showEditModal } from './modals.js';

const MAX_RESULTS = 20;

let initialized = false;
let overlay = null;
let input = null;
let listEl = null;
let results = [];
let activeIndex = 0;

function columnMap() {
  return new Map(loadColumns().map((column) => [column.id, column]));
}

function scoreTask(task, columns, query) {
  const title = String(task.title || '').toLowerCase();
  const key = String(task.key || '').toLowerCase();
  const assignee = String(task.assignee || '').toLowerCase();
  const description = String(task.description || '').toLowerCase();
  const columnName = String(columns.get(task.column)?.name || '').toLowerCase();

  if (key === query) return 100;
  if (title.startsWith(query)) return 90;
  if (key.startsWith(query)) return 80;
  if (title.includes(query)) return 70;
  if (assignee.startsWith(query)) return 60;
  if (columnName.includes(query)) return 40;
  if (assignee.includes(query)) return 35;
  if (description.includes(query)) return 20;
  return -1;
}

function search(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const columns = columnMap();
  return loadTasks()
    .map((task) => ({ task, score: scoreTask(task, columns, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((entry) => entry.task);
}

function setActive(index) {
  if (results.length === 0) return;
  activeIndex = (index + results.length) % results.length;
  const items = listEl.querySelectorAll('.spotlight-item');
  items.forEach((item, i) => item.classList.toggle('is-active', i === activeIndex));
  items[activeIndex]?.scrollIntoView({ block: 'nearest' });
}

function openResult(index) {
  const task = results[index];
  if (!task) return;
  closeSpotlight();
  showEditModal(task.id);
}

function renderResults(query) {
  results = search(query);
  activeIndex = 0;
  listEl.innerHTML = '';

  if (!query.trim()) {
    listEl.appendChild(hint('Type to search the active board'));
    return;
  }
  if (results.length === 0) {
    listEl.appendChild(hint('No matching tasks'));
    return;
  }

  const columns = columnMap();

  results.forEach((task, index) => {
    const item = document.createElement('li');
    item.className = `spotlight-item${index === activeIndex ? ' is-active' : ''}`;
    item.setAttribute('role', 'option');
    item.dataset.taskId = task.id;

    const key = document.createElement('span');
    key.className = 'spotlight-key';
    key.textContent = task.key || '';

    const title = document.createElement('span');
    title.className = 'spotlight-title';
    title.textContent = task.title || 'Untitled task';

    const meta = document.createElement('span');
    meta.className = 'spotlight-meta';
    meta.textContent = [
      columns.get(task.column)?.name,
      task.assignee
    ].filter(Boolean).join(' · ');

    item.append(key, title, meta);
    item.addEventListener('mouseenter', () => setActive(index));
    item.addEventListener('click', () => openResult(index));
    listEl.appendChild(item);
  });
}

function hint(text) {
  const item = document.createElement('li');
  item.className = 'spotlight-hint';
  item.textContent = text;
  return item;
}

function onKeyDown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setActive(activeIndex + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    setActive(activeIndex - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    openResult(activeIndex);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeSpotlight();
  }
}

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'spotlight';
  overlay.className = 'spotlight hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Search tasks');

  const panel = document.createElement('div');
  panel.className = 'spotlight-panel';

  const field = document.createElement('div');
  field.className = 'spotlight-field';

  const icon = document.createElement('span');
  icon.setAttribute('data-lucide', 'search');
  icon.setAttribute('aria-hidden', 'true');

  input = document.createElement('input');
  input.id = 'spotlight-input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.placeholder = 'Search tasks by name, key, column or assignee…';
  input.setAttribute('aria-label', 'Search tasks');
  input.setAttribute('aria-controls', 'spotlight-results');

  field.append(icon, input);

  listEl = document.createElement('ul');
  listEl.id = 'spotlight-results';
  listEl.className = 'spotlight-results';
  listEl.setAttribute('role', 'listbox');

  panel.append(field, listEl);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeSpotlight();
  });
  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', onKeyDown);

  renderIcons();
}

export function isSpotlightOpen() {
  return Boolean(overlay) && !overlay.classList.contains('hidden');
}

export function openSpotlight() {
  if (!overlay) buildOverlay();
  overlay.classList.remove('hidden');
  input.value = '';
  renderResults('');
  input.focus();
}

export function closeSpotlight() {
  if (!overlay) return;
  overlay.classList.add('hidden');
}

export function initializeSpotlight() {
  if (initialized) return;
  initialized = true;

  document.getElementById('search-btn')?.addEventListener('click', openSpotlight);

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k') {
      event.preventDefault();
      if (isSpotlightOpen()) closeSpotlight();
      else openSpotlight();
      return;
    }
    if (event.key === 'Escape' && isSpotlightOpen()) closeSpotlight();
  });
}
