// Wire the task modal description and header controls.

import { $id } from './dom.js';
import { setTaskModalFullscreen, updateDescriptionLinks } from './task-modal-chrome.js';

export function initializeDescriptionHandlers() {
  $id('task-description')?.addEventListener('input', (e) => {
    updateDescriptionLinks(e.target.value);
  });
}

export function initializeFullpageHandlers() {
  $id('task-fullpage-btn')?.addEventListener('click', () => {
    const modal = $id('task-modal');
    if (!modal) return;
    setTaskModalFullscreen(!modal.classList.contains('fullscreen'));
  });
}
