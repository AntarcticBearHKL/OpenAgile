// Task add/edit modal — extracted from modals.js

import { hideModal, showEditModal, showModal } from './task-modal-form.js';
import {
  initializeDescriptionHandlers,
  initializeFullpageHandlers
} from './task-modal-wiring-controls.js';
import { initializeKeyPointHandlers } from './task-modal-wiring-agile.js';
import { initializeSubmitHandler } from './task-modal-wiring-submit.js';

export { updateDescriptionLinks } from './task-modal-chrome.js';
export { showModal, showEditModal, hideModal };

export function initializeTaskModalHandlers(setupModalCloseHandlers) {
  initializeDescriptionHandlers();
  initializeFullpageHandlers();
  initializeKeyPointHandlers();
  initializeSubmitHandler();
  setupModalCloseHandlers('task-modal', hideModal);
}
