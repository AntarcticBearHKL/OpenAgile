import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { mountToBody } from './setup.js';

vi.mock('../../src/modules/dialog.js', () => ({ confirmDialog: vi.fn() }));
vi.mock('../../src/modules/tasks.js', () => ({ deleteTask: vi.fn() }));
vi.mock('../../src/modules/events.js', () => ({ DATA_CHANGED: 'data:changed', emit: vi.fn() }));
vi.mock('../../src/modules/modals.js', () => ({ showEditModal: vi.fn() }));
vi.mock('../../src/modules/storage.js', () => ({
  isDoneColumnId: vi.fn(() => false)
}));

const { createTaskElement } = await import('../../src/modules/task-card.js');
const { showEditModal } = await import('../../src/modules/modals.js');
const {
  BACKLOG_COLUMN_ID,
  BLOCKED_COLUMN_ID,
  FIXED_COLUMNS,
  HIL_COLUMN_ID,
  IN_PROGRESS_COLUMN_ID
} = await import('../../src/modules/constants.js');

const FINISHED_COLUMN_ID = FIXED_COLUMNS[4].id;

function render(task, settings = {}) {
  const element = createTaskElement(task, settings);
  mountToBody(element);
  return element;
}

const baseTask = {
  id: 'task-1',
  title: 'Ship the release',
  description: '',
  column: 'todo'
};

beforeEach(() => {
  showEditModal.mockClear();
});

test('renders a single compact row with the title and no card chrome', () => {
  const element = render(baseTask);

  expect(element.tagName).toBe('LI');
  expect(element.dataset.taskId).toBe('task-1');
  expect(element.querySelector('.task-row')).not.toBeNull();
  expect(element.querySelector('.task-title').textContent).toBe('Ship the release');
  expect(element.querySelector('.task-header')).toBeNull();
  expect(element.querySelector('.task-footer')).toBeNull();
});

test('renders a one-line description preview when a description is present', () => {
  const element = render({ ...baseTask, description: 'Short summary for the human' });
  const preview = element.querySelector('.task-description-preview');

  expect(preview).not.toBeNull();
  expect(preview.textContent).toBe('Short summary for the human');
});

test('omits the description preview when there is no description', () => {
  const element = render(baseTask);
  expect(element.querySelector('.task-description-preview')).toBeNull();
});

test('renders the key points list in order', () => {
  const element = render({
    ...baseTask,
    keyPoints: [
      { id: 'kp1', text: 'Works offline', at: '2026-01-01T00:00:00.000Z' },
      { id: 'kp2', text: 'Syncs on reconnect', at: '2026-01-02T00:00:00.000Z' }
    ]
  });

  const items = [...element.querySelectorAll('.task-key-points .task-key-point')];
  expect(items.map((item) => item.textContent)).toEqual(['Works offline', 'Syncs on reconnect']);
});

test('omits the key points list when there are none', () => {
  const element = render({ ...baseTask, keyPoints: [] });
  expect(element.querySelector('.task-key-points')).toBeNull();
});

test('shows needsDigest and isRework as quiet markers when set', () => {
  const element = render({ ...baseTask, needsDigest: true, isRework: true });
  const signal = element.querySelector('.task-signal');

  expect(signal).not.toBeNull();
  expect(signal.textContent).toContain('Needs digest');
  expect(signal.textContent).toContain('Rework');
  expect(signal.getAttribute('title')).toBe('Needs digest · Rework');
  expect(signal.querySelector('[data-lucide="message-square"]')).not.toBeNull();
  expect(signal.querySelector('.task-signal-label').textContent).toBe('Needs digest · Rework');
});

test('marks undigested notes in Backlog, Blocked and Finished only, with an icon and a label', () => {
  for (const column of [BACKLOG_COLUMN_ID, BLOCKED_COLUMN_ID, FINISHED_COLUMN_ID]) {
    const element = render({ ...baseTask, column, needsDigest: true });
    const signal = element.querySelector('.task-signal');
    expect(signal, column).not.toBeNull();
    expect(signal.classList.contains('task-signal--digest'), column).toBe(true);
    expect(signal.getAttribute('data-signal'), column).toBe('needs-digest');
    expect(signal.querySelector('[data-lucide="message-square"]'), column).not.toBeNull();
    expect(signal.querySelector('.task-signal-label').textContent, column).toBe('Needs digest');
  }

  for (const column of [HIL_COLUMN_ID, IN_PROGRESS_COLUMN_ID]) {
    const element = render({ ...baseTask, column, needsDigest: true });
    expect(element.querySelector('.task-signal'), column).toBeNull();
  }
});

test('carries rework as its own marker with an icon and a label', () => {
  const element = render({ ...baseTask, column: BACKLOG_COLUMN_ID, isRework: true });
  const signal = element.querySelector('.task-signal');

  expect(signal).not.toBeNull();
  expect(signal.getAttribute('data-signal')).toBe('rework');
  expect(signal.classList.contains('task-signal--rework')).toBe(true);
  expect(signal.querySelector('[data-lucide="history"]')).not.toBeNull();
  expect(signal.querySelector('.task-signal-label').textContent).toBe('Rework');
});

test('omits the signal marker when neither flag is set', () => {
  const element = render(baseTask);
  expect(element.querySelector('.task-signal')).toBeNull();
});

test('renders nothing else: no type, estimate, key, assignee, timer, notes or status chip', () => {
  const element = render({
    ...baseTask,
    key: 'DB-12',
    type: 'bug',
    estimate: 5,
    assignee: 'Ada Lovelace',
    claimedBy: 'agent-7',
    claimedAt: '2026-01-01T00:00:00.000Z',
    doneDate: '2026-01-02T00:00:00.000Z',
    blockedReason: 'Waiting',
    comments: [{ id: 'c1', author: 'Ada', text: 'Any update?', at: '2026-01-01T10:00:00.000Z' }]
  });

  [
    '.task-meta',
    '.task-key',
    '.task-type',
    '.task-estimate',
    '.task-assignee',
    '.task-claim-timer',
    '.task-blocked',
    '.task-notes',
    '.task-acceptance-progress',
    '.task-summary-chip'
  ].forEach((selector) => {
    expect(element.querySelector(selector), selector).toBeNull();
  });
});

test('clicking the title opens the task editor', () => {
  const element = render(baseTask);
  fireEvent.click(element.querySelector('.task-title'));

  expect(showEditModal).toHaveBeenCalledWith('task-1');
});

test('keeps the delete control inside the row actions', () => {
  const element = render(baseTask);
  expect(element.querySelector('.task-actions .delete-task-btn')).not.toBeNull();
});
