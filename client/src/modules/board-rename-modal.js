import { ensureBoardsInitialized, listBoards, updateBoardFields } from './storage.js';
import { renderIcons } from './icons.js';
import { $id } from './dom.js';

let editingBoardId = null;

export function showBoardRenameModal(boardId) {
  ensureBoardsInitialized();
  const board = listBoards().find((b) => b.id === boardId);
  if (!board) return;

  editingBoardId = boardId;
  const modal = $id('board-rename-modal');
  const title = $id('board-rename-modal-title');
  const submitBtn = $id('board-rename-submit-btn');

  if (title) title.textContent = 'Edit Iteration';
  if (submitBtn) submitBtn.textContent = 'Save';

  const startDate = $id('board-start-date');
  if (startDate) startDate.value = typeof board.startDate === 'string' ? board.startDate.slice(0, 10) : '';
  const endDate = $id('board-end-date');
  if (endDate) endDate.value = typeof board.endDate === 'string' ? board.endDate.slice(0, 10) : '';
  const goal = $id('board-goal');
  if (goal) goal.value = typeof board.goal === 'string' ? board.goal : '';

  modal?.classList.remove('hidden');
}

export function hideBoardRenameModal() {
  const modal = $id('board-rename-modal');
  modal?.classList.add('hidden');
  editingBoardId = null;
}

export function initializeBoardRenameModalHandlers(setupModalCloseHandlers, refreshBoards) {
  $id('board-rename-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingBoardId) return;

    updateBoardFields(editingBoardId, {
      startDate: $id('board-start-date')?.value ?? '',
      endDate: $id('board-end-date')?.value ?? '',
      goal: $id('board-goal')?.value ?? ''
    });

    hideBoardRenameModal();
    refreshBoards();
    renderIcons();
  });
  setupModalCloseHandlers('board-rename-modal', hideBoardRenameModal);
}
