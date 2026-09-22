// Thin facade — delegates to per-modal sub-modules.
// Keeps shared utilities (setupModalCloseHandlers, Escape handler).

import { showModal, showEditModal, hideModal as hideTaskModal,
  initializeTaskModalHandlers } from './task-modal.js';
import { hideBoardsModal,
  initializeBoardsModalHandlers, showBoardsModal } from './boards-modal.js';
import { hideBoardRenameModal } from './board-rename-modal.js';
import { $id } from './dom.js';
import { setupModalCloseHandlers } from './modal-utils.js';

// ── Shared utility ──────────────────────────────────────────────────

function isModalOpen(modalId) {
  const modal = $id(modalId);
  return !!modal && !modal.classList.contains('hidden');
}

// ── Master initializer ──────────────────────────────────────────────

export function initializeModalHandlers() {
  initializeTaskModalHandlers(setupModalCloseHandlers);
  initializeBoardsModalHandlers(setupModalCloseHandlers);

  // Close top-most modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (isModalOpen('board-rename-modal')) { hideBoardRenameModal(); return; }
      if (isModalOpen('boards-modal')) { hideBoardsModal(); return; }
      if (isModalOpen('task-modal')) { hideTaskModal(); }
    }
  });
}

// ── Public API re-exports ───────────────────────────────────────────

export {
  showModal,
  showEditModal,
  showBoardsModal
};
