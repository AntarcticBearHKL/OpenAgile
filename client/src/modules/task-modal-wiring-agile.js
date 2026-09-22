// Wire the task modal notes (key points) input.

import { $id } from './dom.js';
import { generateUUID } from './utils.js';
import { state } from './task-modal-state.js';
import { renderKeyPointsList } from './task-modal-status.js';

export function initializeKeyPointHandlers() {
  const keyPointInput = $id('task-key-point-input');

  function appendKeyPoint() {
    if (state.dialogAccess?.notes === false) return;
    const text = (keyPointInput?.value || '').trim();
    if (!text) {
      keyPointInput?.focus();
      return;
    }
    const id = generateUUID();
    state.selectedTaskKeyPoints.push({ id, text, at: new Date().toISOString() });
    state.lastAddedKeyPointId = id;
    if (keyPointInput) keyPointInput.value = '';
    renderKeyPointsList();
    keyPointInput?.focus();
  }

  keyPointInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    appendKeyPoint();
  });
}
