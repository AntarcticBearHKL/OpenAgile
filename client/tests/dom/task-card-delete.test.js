import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';

const deleteTask = vi.fn();
const emit = vi.fn();
const isDoneColumnId = vi.fn(() => false);
const showEditModal = vi.fn();

vi.mock('../../src/modules/tasks.js', () => ({
  deleteTask
}));

vi.mock('../../src/modules/events.js', () => ({
  DATA_CHANGED: 'data:changed',
  emit
}));

vi.mock('../../src/modules/modals.js', () => ({
  showEditModal
}));

vi.mock('../../src/modules/storage.js', () => ({
  isDoneColumnId
}));

const { createTaskElement } = await import('../../src/modules/task-card.js');
const { BACKLOG_COLUMN_ID, FIXED_COLUMNS } = await import('../../src/modules/constants.js');

const FINISHED_COLUMN_ID = FIXED_COLUMNS[4].id;
const CONFIRM_WINDOW_MS = 3000;

beforeEach(() => {
  deleteTask.mockReset();
  emit.mockReset();
  isDoneColumnId.mockReset();
  isDoneColumnId.mockImplementation(() => false);
  vi.useRealTimers();
});

function renderTask(overrides = {}) {
  const task = {
    id: 'task-1',
    title: 'Delete me',
    description: '',
    priority: 'none',
    dueDate: '',
    column: 'todo',
    ...overrides
  };
  const element = createTaskElement(task, {});
  document.body.appendChild(element);
  return element;
}

test('the first click arms the delete button instead of deleting', () => {
  const element = renderTask();
  const btn = element.querySelector('.delete-task-btn');

  fireEvent.click(btn);

  expect(deleteTask).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  expect(btn.classList.contains('is-armed')).toBe(true);
  expect(btn.getAttribute('aria-label')).toBe('Click again to confirm delete');
});

test('the second click confirms and deletes the task', () => {
  deleteTask.mockReturnValue(true);
  const element = renderTask();
  const btn = element.querySelector('.delete-task-btn');

  fireEvent.click(btn);
  fireEvent.click(btn);

  expect(deleteTask).toHaveBeenCalledWith('task-1');
});

test('an armed button disarms itself after the confirm window', () => {
  vi.useFakeTimers();
  const element = renderTask();
  const btn = element.querySelector('.delete-task-btn');

  fireEvent.click(btn);
  expect(btn.classList.contains('is-armed')).toBe(true);

  vi.advanceTimersByTime(CONFIRM_WINDOW_MS);

  expect(btn.classList.contains('is-armed')).toBe(false);
  expect(btn.getAttribute('aria-label')).toBe('Delete task');
  expect(deleteTask).not.toHaveBeenCalled();
});

test('renders no delete control for a card in the Finished column', () => {
  isDoneColumnId.mockImplementation((columnId) => columnId === FINISHED_COLUMN_ID);
  const element = renderTask({ column: FINISHED_COLUMN_ID });

  expect(element.querySelector('.delete-task-btn')).toBeNull();
});

test('keeps the delete control for a card in another column', () => {
  isDoneColumnId.mockImplementation((columnId) => columnId === FINISHED_COLUMN_ID);
  const element = renderTask({ column: BACKLOG_COLUMN_ID });

  expect(element.querySelector('.task-actions .delete-task-btn')).not.toBeNull();
});

test('keeps the row actions container on both cards so the header does not shift', () => {
  isDoneColumnId.mockImplementation((columnId) => columnId === FINISHED_COLUMN_ID);
  const finished = renderTask({ column: FINISHED_COLUMN_ID });
  const other = renderTask({ id: 'task-2', column: BACKLOG_COLUMN_ID });

  expect(finished.querySelector('.task-row > .task-actions')).not.toBeNull();
  expect(other.querySelector('.task-row > .task-actions')).not.toBeNull();
});

test('a Finished card still opens the task dialog and keeps its notes', () => {
  isDoneColumnId.mockImplementation((columnId) => columnId === FINISHED_COLUMN_ID);
  const element = renderTask({
    column: FINISHED_COLUMN_ID,
    keyPoints: [{ id: 'kp1', text: 'Works offline', at: '2026-01-01T00:00:00.000Z' }]
  });

  expect(element.querySelector('.task-key-points .task-key-point').textContent).toBe('Works offline');
  fireEvent.click(element.querySelector('.task-title'));
  expect(showEditModal).toHaveBeenCalledWith('task-1');
});
