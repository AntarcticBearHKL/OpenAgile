// Open/close the add/edit task modal and populate it from a task.

import { loadTasks } from './storage.js';
import { clearFieldError } from './validation.js';
import { isTaskLocked } from './tasks.js';
import { normalizeKeyPoints } from './agile.js';
import { $id } from './dom.js';
import { state } from './task-modal-state.js';
import { setTaskModalFullscreen, updateDescriptionLinks } from './task-modal-chrome.js';
import { renderKeyPointsList, resetTaskLock, setTaskLocked } from './task-modal-status.js';
import { applyDialogAccess, dialogAccess } from './task-modal-access.js';

export function showModal() {
  state.editingTaskId = null;
  state.selectedTaskKeyPoints = [];
  state.editingKeyPointId = null;

  resetTaskLock();
  applyDialogAccess(dialogAccess(null), null);
  $id('task-modal-key')?.classList.add('hidden');

  setTaskModalFullscreen(false);
  $id('task-fullpage-btn')?.classList.add('hidden');

  const modal = $id('task-modal');
  const taskTitle = $id('task-title');
  const taskDescription = $id('task-description');
  const modalTitle = $id('task-modal-title');
  const submitBtn = $id('task-submit-btn');

  clearFieldError(taskTitle);

  modalTitle.textContent = 'Add New Task';
  submitBtn.textContent = 'Add Task';
  taskTitle.value = '';
  taskDescription.value = '';
  updateDescriptionLinks('');

  const keyPointInput = $id('task-key-point-input');
  if (keyPointInput) keyPointInput.value = '';

  renderKeyPointsList();
  modal.classList.remove('hidden');
  taskTitle.focus();
}

export function showEditModal(taskId) {
  const tasks = loadTasks();
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  state.editingTaskId = taskId;
  state.selectedTaskKeyPoints = normalizeKeyPoints(task.keyPoints ?? task.acceptanceCriteria).map((entry) => ({ ...entry }));
  state.editingKeyPointId = null;

  const access = dialogAccess(task);

  setTaskModalFullscreen(false);
  $id('task-fullpage-btn')?.classList.remove('hidden');

  const modal = $id('task-modal');
  const taskTitle = $id('task-title');
  const taskDescription = $id('task-description');
  const modalTitle = $id('task-modal-title');
  const submitBtn = $id('task-submit-btn');

  clearFieldError(taskTitle);

  modalTitle.textContent = 'Edit Task';
  submitBtn.textContent = 'Save Changes';

  const legacyTitle = typeof task.text === 'string' ? task.text : '';
  taskTitle.value = (typeof task.title === 'string' && task.title.trim() !== '') ? task.title : legacyTitle;
  taskDescription.value = typeof task.description === 'string' ? task.description : '';
  updateDescriptionLinks(taskDescription.value);

  const keyEl = $id('task-modal-key');
  if (keyEl) {
    const key = typeof task.key === 'string' ? task.key.trim() : '';
    keyEl.textContent = key;
    keyEl.classList.toggle('hidden', !key);
  }

  const keyPointInput = $id('task-key-point-input');
  if (keyPointInput) keyPointInput.value = '';

  applyDialogAccess(access, task);
  renderKeyPointsList();

  const locked = isTaskLocked(task);
  setTaskLocked(locked, task);

  modal.classList.remove('hidden');
  if (access.title) taskTitle.focus();
}

export function hideModal() {
  $id('task-modal').classList.add('hidden');
  state.editingTaskId = null;

  resetTaskLock();

  setTaskModalFullscreen(false);
  $id('task-fullpage-btn')?.classList.add('hidden');
}
