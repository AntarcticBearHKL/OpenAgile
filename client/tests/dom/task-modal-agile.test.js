import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import { mountToBody } from './setup.js';

const mocks = vi.hoisted(() => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  setTaskBlockedReason: vi.fn(),
  isTaskLocked: vi.fn(() => false),
  promptDialog: vi.fn(async () => null),
  loadTasks: vi.fn(() => []),
  loadColumns: vi.fn(() => []),
  emit: vi.fn()
}));

vi.mock('../../src/modules/tasks.js', () => ({
  addTask: mocks.addTask,
  setTaskBlockedReason: mocks.setTaskBlockedReason,
  isTaskLocked: mocks.isTaskLocked
}));

vi.mock('../../src/modules/task-update.js', () => ({
  updateTask: mocks.updateTask
}));

vi.mock('../../src/modules/storage.js', () => ({
  isDoneColumnId: () => false,
  loadColumns: mocks.loadColumns,
  loadSettings: () => ({}),
  loadTasks: mocks.loadTasks
}));

vi.mock('../../src/modules/icons.js', () => ({ renderIcons: vi.fn() }));

vi.mock('../../src/modules/validation.js', () => ({
  validateAndShowTaskTitleError: () => true,
  clearFieldError: vi.fn()
}));

vi.mock('../../src/modules/events.js', () => ({
  emit: mocks.emit,
  DATA_CHANGED: 'data:changed'
}));

vi.mock('../../src/modules/dialog.js', () => ({
  promptDialog: mocks.promptDialog,
  confirmDialog: vi.fn()
}));

vi.mock('../../src/modules/render.js', () => ({
  renderBoard: vi.fn()
}));

vi.mock('sortablejs', () => ({
  default: vi.fn(function Sortable() {
    this.destroy = vi.fn();
  })
}));

import { initializeTaskModalHandlers, showEditModal, showModal } from '../../src/modules/task-modal.js';
import {
  BACKLOG_COLUMN_ID,
  BLOCKED_COLUMN_ID,
  FIXED_COLUMNS,
  HIL_COLUMN_ID,
  IN_PROGRESS_COLUMN_ID
} from '../../src/modules/constants.js';

const FINISHED_COLUMN_ID = FIXED_COLUMNS[4].id;

const FIXTURE = `
  <div id="task-modal" class="modal hidden">
    <div class="modal-backdrop" data-close-modal></div>
    <article class="modal-content">
      <header class="modal-header-row">
        <span id="task-modal-key" class="task-modal-key hidden"></span>
        <h3 id="task-modal-title">Add New Task</h3>
        <div class="modal-header-actions">
          <button id="task-fullpage-btn" type="button" class="btn-small hidden"></button>
          <button id="task-close-btn" type="button" class="btn-small"></button>
        </div>
      </header>
      <div id="task-lock-notice" class="task-lock-notice hidden" role="status"></div>
      <form id="task-form" novalidate>
        <div class="form-group" id="task-title-group">
          <label for="task-title" id="task-title-label">Title</label>
          <input id="task-title" type="text">
          <div id="task-title-view" class="task-readonly-block hidden">
            <span class="task-readonly-label">Title</span>
            <h4 id="task-title-view-text" class="task-readonly-title"></h4>
          </div>
        </div>
        <div class="form-group" id="task-description-group">
          <label for="task-description" id="task-description-label">Description</label>
          <textarea id="task-description"></textarea>
          <div id="task-description-view" class="task-readonly-block hidden">
            <span class="task-readonly-label">Description</span>
            <div id="task-description-view-text" class="task-readonly-description"></div>
          </div>
          <div id="task-description-links" hidden></div>
        </div>
        <fieldset class="form-group" id="task-key-points-fieldset">
          <legend>Notes to the agent</legend>
          <p class="form-help" id="task-key-points-help">The human writes notes here.</p>
          <ul id="task-key-points-list" aria-label="Notes to the agent"></ul>
          <div class="task-key-point-add-row" id="task-key-point-add-row">
            <input type="text" id="task-key-point-input">
            <span class="key-point-enter-hint" aria-hidden="true">Enter</span>
          </div>
          <p class="task-notes-view-notice hidden" id="task-notes-view-notice" role="status">Notes are read-only while a task is In Progress.</p>
        </fieldset>
        <div class="form-actions">
          <button type="button" id="cancel-task-btn" class="btn btn-secondary">Cancel</button>
          <button type="submit" id="task-submit-btn" class="btn btn-primary">Add Task</button>
        </div>
      </form>
    </article>
  </div>
`;

const REMOVED_IDS = [
  'task-type',
  'task-estimate',
  'task-comments-fieldset',
  'task-comments-list',
  'task-comments-count',
  'task-comment-author',
  'task-comment-input',
  'task-comment-add-btn',
  'task-relationships-fieldset',
  'task-active-relationships',
  'task-relationship-type',
  'rel-type-tooltip',
  'task-relationship-search',
  'task-relationship-results',
  'task-summary',
  'task-summary-column',
  'task-claim-chip',
  'task-claim-agent',
  'task-claim-time'
];

beforeEach(() => {
  mountToBody(FIXTURE);
  mocks.addTask.mockReset();
  mocks.updateTask.mockReset();
  mocks.setTaskBlockedReason.mockReset();
  mocks.promptDialog.mockReset();
  mocks.promptDialog.mockResolvedValue(null);
  mocks.loadTasks.mockReset();
  mocks.loadTasks.mockReturnValue([]);
  mocks.isTaskLocked.mockReset();
  mocks.isTaskLocked.mockReturnValue(false);
  mocks.emit.mockClear();
  localStorage.clear();
});

function loadTaskAt(column, extra = {}) {
  mocks.loadTasks.mockReturnValue([{
    id: 't1',
    title: 'Agent title',
    description: 'Agent description',
    column,
    keyPoints: [{ id: 'k1', text: 'Human note', at: '2026-01-01T10:00:00.000Z' }],
    ...extra
  }]);
  return mocks.loadTasks()[0];
}

test('the dialog renders the title, the description and the notes list and nothing else', () => {
  initializeTaskModalHandlers(() => {});
  showModal();

  const form = document.getElementById('task-form');
  expect(form.querySelector('.task-form-columns')).toBeNull();
  expect(form.querySelector('.task-form-column-left')).toBeNull();
  expect(form.querySelector('.task-form-column-right')).toBeNull();

  const blocks = [...form.children];
  expect(blocks).toHaveLength(4);
  expect(blocks[0].querySelector('#task-title')).not.toBeNull();
  expect(blocks[1].querySelector('#task-description')).not.toBeNull();
  expect(blocks[2].querySelector('#task-key-points-list')).not.toBeNull();
  expect(blocks[3].classList.contains('form-actions')).toBe(true);

  expect(document.getElementById('task-key-points-fieldset').querySelector('legend').textContent.trim()).toBe('Notes to the agent');
  expect(document.getElementById('task-key-points-list').getAttribute('aria-label')).toBe('Notes to the agent');

  REMOVED_IDS.forEach((id) => {
    expect(document.getElementById(id), `#${id} should not exist`).toBeNull();
  });
});

test('the add form saves the title, description and notes through addTask', () => {
  initializeTaskModalHandlers(() => {});
  showModal();

  document.getElementById('task-title').value = 'New task';
  document.getElementById('task-description').value = 'What the agent should do';

  fireEvent.submit(document.getElementById('task-form'));

  expect(mocks.addTask).toHaveBeenCalledTimes(1);
  const [title, description, fields] = mocks.addTask.mock.calls[0];
  expect(title).toBe('New task');
  expect(description).toBe('What the agent should do');
  expect(fields.keyPoints).toEqual([]);
  expect(Object.keys(fields)).toEqual(['keyPoints']);
});

test('the notes input appends one line per Enter press, clears itself and removes a line', () => {
  initializeTaskModalHandlers(() => {});
  showModal();
  document.getElementById('task-title').value = 'Notes task';

  const keyPointInput = document.getElementById('task-key-point-input');
  keyPointInput.value = 'First note';
  fireEvent.keyDown(keyPointInput, { key: 'Enter' });
  keyPointInput.value = 'Second note';
  fireEvent.keyDown(keyPointInput, { key: 'Enter' });

  expect(keyPointInput.value).toBe('');
  expect(document.getElementById('task-key-point-add-btn')).toBeNull();

  let items = document.querySelectorAll('#task-key-points-list .key-point-item');
  expect(items).toHaveLength(2);
  expect(items[0].querySelector('.key-point-text').textContent).toBe('First note');
  expect(items[1].querySelector('.key-point-text').textContent).toBe('Second note');
  expect(items[1].classList.contains('key-point-item--new')).toBe(true);

  fireEvent.keyDown(keyPointInput, { key: 'Enter' });
  expect(document.querySelectorAll('#task-key-points-list .key-point-item')).toHaveLength(2);

  fireEvent.click(items[1].querySelector('.key-point-remove-btn'));
  items = document.querySelectorAll('#task-key-points-list .key-point-item');
  expect(items).toHaveLength(1);

  fireEvent.submit(document.getElementById('task-form'));

  const fields = mocks.addTask.mock.calls[0][2];
  expect(fields.keyPoints).toHaveLength(1);
  expect(fields.keyPoints[0]).toMatchObject({ text: 'First note' });
  expect(fields.keyPoints[0].at).toBeTruthy();
});

test('opening the edit dialog prefills the title, description and notes', () => {
  mocks.loadTasks.mockReturnValue([
    {
      id: 't1',
      title: 'Fine task',
      description: 'Agent-written description',
      column: 'todo',
      keyPoints: [{ id: 'k1', text: 'Human note', at: '2026-01-01T10:00:00.000Z' }]
    }
  ]);
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  expect(document.getElementById('task-modal-title').textContent).toBe('Edit Task');
  expect(document.getElementById('task-title').value).toBe('Fine task');
  expect(document.getElementById('task-description').value).toBe('Agent-written description');

  const items = document.querySelectorAll('#task-key-points-list .key-point-item');
  expect(items).toHaveLength(1);
  expect(items[0].querySelector('.key-point-text').textContent).toBe('Human note');
});

test('editing a task saves the slim payload through updateTask', async () => {
  loadTaskAt(HIL_COLUMN_ID, {
    title: 'Fine task',
    description: 'old',
    type: 'task',
    estimate: 2,
    relationships: [],
    keyPoints: [],
    comments: []
  });
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  document.getElementById('task-title').value = 'Renamed task';
  fireEvent.submit(document.getElementById('task-form'));

  await waitFor(() => expect(mocks.updateTask).toHaveBeenCalledTimes(1));
  const [taskId, title, description, fields] = mocks.updateTask.mock.calls[0];
  expect(taskId).toBe('t1');
  expect(title).toBe('Renamed task');
  expect(description).toBe('old');
  expect(Object.keys(fields)).toEqual(['keyPoints']);
  expect(fields.column).toBeUndefined();
  expect(mocks.promptDialog).not.toHaveBeenCalled();
  expect(mocks.setTaskBlockedReason).not.toHaveBeenCalled();
});

test('a task outside Human In The Loop shows the agent title and description as content and only the notes stay interactive', () => {
  initializeTaskModalHandlers(() => {});

  for (const column of [BACKLOG_COLUMN_ID, BLOCKED_COLUMN_ID, FINISHED_COLUMN_ID]) {
    loadTaskAt(column);
    showEditModal('t1');

    expect(document.getElementById('task-title').classList.contains('hidden'), column).toBe(true);
    expect(document.getElementById('task-title-view').classList.contains('hidden'), column).toBe(false);
    expect(document.getElementById('task-title-view-text').textContent, column).toBe('Agent title');
    expect(document.getElementById('task-description').classList.contains('hidden'), column).toBe(true);
    expect(document.getElementById('task-description-view').classList.contains('hidden'), column).toBe(false);
    expect(document.getElementById('task-description-view-text').textContent, column).toBe('Agent description');
    expect(document.getElementById('task-key-point-add-row').classList.contains('hidden'), column).toBe(false);
    expect(document.getElementById('task-notes-view-notice').classList.contains('hidden'), column).toBe(true);
    expect(document.querySelector('#task-key-points-list .key-point-remove-btn'), column).not.toBeNull();
  }
});

test('a Human In The Loop task keeps the title and the description editable', () => {
  loadTaskAt(HIL_COLUMN_ID);
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  expect(document.getElementById('task-title').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('task-title-view').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('task-description').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('task-description-view').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('task-key-point-add-row').classList.contains('hidden')).toBe(false);
});

test('an In Progress task is view-only with the notes control visibly unavailable', () => {
  mocks.isTaskLocked.mockReturnValue(true);
  loadTaskAt(IN_PROGRESS_COLUMN_ID);
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  expect(document.getElementById('task-title-view').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('task-description-view').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('task-key-point-add-row').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('task-notes-view-notice').classList.contains('hidden')).toBe(false);
  expect(document.querySelector('#task-key-points-list .key-point-remove-btn')).toBeNull();

  const keyPointInput = document.getElementById('task-key-point-input');
  keyPointInput.value = 'Note that must not stick';
  fireEvent.keyDown(keyPointInput, { key: 'Enter' });
  expect(document.querySelectorAll('#task-key-points-list .key-point-item')).toHaveLength(1);
});

test('the dialog shows who holds the claim and for how long', () => {
  const claimedAt = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  mocks.isTaskLocked.mockReturnValue(true);
  loadTaskAt(IN_PROGRESS_COLUMN_ID, { claimedBy: 'agent-z', claimedAt });
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  const notice = document.getElementById('task-lock-notice');
  expect(notice.classList.contains('hidden')).toBe(false);
  expect(notice.textContent).toContain('agent-z');
  expect(notice.textContent).toContain('12 minutes');
  expect(notice.textContent).toContain('read-only');
});

test('the claim line is hidden when nobody holds the task', () => {
  loadTaskAt(BACKLOG_COLUMN_ID);
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  const notice = document.getElementById('task-lock-notice');
  expect(notice.classList.contains('hidden')).toBe(true);
  expect(notice.textContent).toBe('');
});

test('an undigested note edits inline: Enter commits the new text and Escape reverts it', () => {
  loadTaskAt(HIL_COLUMN_ID);
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  const editBtn = document.querySelector('#task-key-points-list .key-point-edit-btn');
  expect(editBtn).not.toBeNull();
  expect(editBtn.getAttribute('title')).toBe('Edit note');
  expect(editBtn.getAttribute('aria-label')).toBe('Edit note "Human note"');
  expect(editBtn.querySelector('[data-lucide="pencil"]')).not.toBeNull();

  fireEvent.click(editBtn);
  const input = document.querySelector('#task-key-points-list .key-point-edit-input');
  expect(input).not.toBeNull();
  expect(input.value).toBe('Human note');

  input.value = 'Sharper note';
  fireEvent.input(input);
  fireEvent.keyDown(input, { key: 'Enter' });

  expect(document.querySelector('#task-key-points-list .key-point-edit-input')).toBeNull();
  expect(document.querySelector('#task-key-points-list .key-point-text').textContent).toBe('Sharper note');

  fireEvent.click(document.querySelector('#task-key-points-list .key-point-edit-btn'));
  const reopened = document.querySelector('#task-key-points-list .key-point-edit-input');
  reopened.value = 'Discarded wording';
  fireEvent.input(reopened);
  fireEvent.keyDown(reopened, { key: 'Escape' });

  expect(document.querySelector('#task-key-points-list .key-point-edit-input')).toBeNull();
  expect(document.querySelector('#task-key-points-list .key-point-text').textContent).toBe('Sharper note');

  fireEvent.submit(document.getElementById('task-form'));

  expect(mocks.updateTask).toHaveBeenCalledTimes(1);
  const fields = mocks.updateTask.mock.calls[0][3];
  expect(fields.keyPoints).toEqual([{ id: 'k1', text: 'Sharper note', at: '2026-01-01T10:00:00.000Z' }]);
});

test('an edit typed without Enter still reaches the save', () => {
  loadTaskAt(BACKLOG_COLUMN_ID);
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  fireEvent.click(document.querySelector('#task-key-points-list .key-point-edit-btn'));
  const input = document.querySelector('#task-key-points-list .key-point-edit-input');
  input.value = 'Typed but not confirmed';
  fireEvent.input(input);

  fireEvent.submit(document.getElementById('task-form'));

  const fields = mocks.updateTask.mock.calls[0][3];
  expect(fields.keyPoints).toEqual([{ id: 'k1', text: 'Typed but not confirmed', at: '2026-01-01T10:00:00.000Z' }]);
});

test('a digested note is read-only and carries a marker that says why', () => {
  loadTaskAt(BACKLOG_COLUMN_ID, {
    keyPoints: [{ id: 'k1', text: 'Folded in', at: '2026-01-01T10:00:00.000Z', digestedAt: '2026-01-02T10:00:00.000Z' }]
  });
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  expect(document.querySelector('#task-key-points-list .key-point-edit-btn')).toBeNull();
  expect(document.querySelector('#task-key-points-list .key-point-remove-btn')).toBeNull();

  const marker = document.querySelector('#task-key-points-list .key-point-digested');
  expect(marker).not.toBeNull();
  expect(marker.textContent).toBe('Digested');
  expect(marker.querySelector('[data-lucide="bot"]')).not.toBeNull();
  expect(marker.getAttribute('title')).toContain('Digested by the agent');
  expect(marker.getAttribute('aria-label')).toContain('read-only');

  fireEvent.submit(document.getElementById('task-form'));

  const fields = mocks.updateTask.mock.calls[0][3];
  expect(fields.keyPoints).toEqual([
    { id: 'k1', text: 'Folded in', at: '2026-01-01T10:00:00.000Z', digestedAt: '2026-01-02T10:00:00.000Z' }
  ]);
});

test('a mixed notes list keeps edit and remove on the undigested note only', () => {
  loadTaskAt(HIL_COLUMN_ID, {
    keyPoints: [
      { id: 'k1', text: 'Human note', at: '2026-01-01T10:00:00.000Z' },
      { id: 'k2', text: 'Folded in', at: '2026-01-01T10:00:00.000Z', digestedAt: '2026-01-02T10:00:00.000Z' }
    ]
  });
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  const items = document.querySelectorAll('#task-key-points-list .key-point-item');
  expect(items).toHaveLength(2);
  expect(items[0].querySelector('.key-point-edit-btn')).not.toBeNull();
  expect(items[0].querySelector('.key-point-remove-btn')).not.toBeNull();

  expect(items[1].querySelector('.key-point-edit-btn')).toBeNull();
  expect(items[1].querySelector('.key-point-remove-btn')).toBeNull();
  expect(items[1].querySelector('.key-point-digested')).not.toBeNull();

  fireEvent.click(items[0].querySelector('.key-point-remove-btn'));

  const remaining = document.querySelectorAll('#task-key-points-list .key-point-item');
  expect(remaining).toHaveLength(1);
  expect(remaining[0].getAttribute('data-key-point-id')).toBe('k2');
});

test('adding a note to a Backlog task saves the unchanged agent title and description', () => {
  loadTaskAt(BACKLOG_COLUMN_ID);
  initializeTaskModalHandlers(() => {});
  showEditModal('t1');

  const keyPointInput = document.getElementById('task-key-point-input');
  keyPointInput.value = 'Please tighten the copy';
  fireEvent.keyDown(keyPointInput, { key: 'Enter' });
  fireEvent.submit(document.getElementById('task-form'));

  expect(mocks.updateTask).toHaveBeenCalledTimes(1);
  const [taskId, title, description, fields] = mocks.updateTask.mock.calls[0];
  expect(taskId).toBe('t1');
  expect(title).toBe('Agent title');
  expect(description).toBe('Agent description');
  expect(fields.keyPoints.map((point) => point.text)).toEqual(['Human note', 'Please tighten the copy']);
  expect(Object.keys(fields)).toEqual(['keyPoints']);
});
