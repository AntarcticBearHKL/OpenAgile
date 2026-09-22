// Column-keyed edit permissions for the task dialog.

import { HIL_COLUMN_ID, IN_PROGRESS_COLUMN_ID, canonicalColumnId } from './constants.js';
import { $id } from './dom.js';
import { state } from './task-modal-state.js';

const HELP_EDIT_ALL = 'The human writes notes here. The agent reads them and folds them into the description before starting work.';
const HELP_NOTES_ONLY = 'The title and description belong to the agent. Add a note and press Enter; the agent folds it into the description before starting work.';
const HELP_VIEW_ONLY = 'The agent is working on this task, so notes are read-only until it hands the task back.';

export function dialogAccess(task) {
  if (!task) return { title: true, description: true, notes: true };
  const column = canonicalColumnId(task?.column);
  if (column === HIL_COLUMN_ID) return { title: true, description: true, notes: true };
  if (column === IN_PROGRESS_COLUMN_ID) return { title: false, description: false, notes: false };
  return { title: false, description: false, notes: true };
}

function taskTitle(task) {
  if (typeof task?.title === 'string' && task.title.trim() !== '') return task.title;
  return typeof task?.text === 'string' ? task.text : '';
}

export function applyDialogAccess(access, task) {
  state.dialogAccess = access;

  const titleInput = $id('task-title');
  const titleLabel = $id('task-title-label');
  const titleView = $id('task-title-view');
  const titleText = $id('task-title-view-text');
  const descriptionInput = $id('task-description');
  const descriptionLabel = $id('task-description-label');
  const descriptionView = $id('task-description-view');
  const descriptionText = $id('task-description-view-text');
  const help = $id('task-key-points-help');
  const addRow = $id('task-key-point-add-row');
  const notice = $id('task-notes-view-notice');

  titleInput?.classList.toggle('hidden', !access.title);
  titleLabel?.classList.toggle('hidden', !access.title);
  titleView?.classList.toggle('hidden', access.title);
  if (titleText) titleText.textContent = access.title ? '' : taskTitle(task);

  descriptionInput?.classList.toggle('hidden', !access.description);
  descriptionLabel?.classList.toggle('hidden', !access.description);
  descriptionView?.classList.toggle('hidden', access.description);
  if (descriptionText) descriptionText.textContent = access.description ? '' : (task?.description ?? '');

  addRow?.classList.toggle('hidden', !access.notes);
  notice?.classList.toggle('hidden', access.notes);
  if (help) {
    help.textContent = access.notes
      ? (access.title ? HELP_EDIT_ALL : HELP_NOTES_ONLY)
      : HELP_VIEW_ONLY;
  }
}
