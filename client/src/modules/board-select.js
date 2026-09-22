import { listBoards, getActiveBoardId } from './storage.js';
import { boardDisplayName } from './normalize.js';
import { APP_NAME } from './constants.js';

export function refreshBrandText() {
  const brandEl = document.getElementById('brand-text') || document.querySelector('.brand-text');
  if (!brandEl) return;
  brandEl.textContent = APP_NAME;
}

export function refreshBoardSelect(selectEl, activeId = getActiveBoardId()) {
  if (!selectEl) return;
  const boards = listBoards();
  selectEl.innerHTML = '';

  boards.forEach((b) => {
    const option = document.createElement('option');
    option.value = b.id;
    option.textContent = boardDisplayName(b);
    selectEl.appendChild(option);
  });

  if (activeId) selectEl.value = activeId;
}

// True when #board-select already reflects the current board list (ids + names).
// Lets us skip rebuilding on unrelated DATA_CHANGED churn (task moves, etc.).
export function boardSelectMatchesState(selectEl) {
  if (!selectEl) return true;
  const boards = listBoards();
  if (selectEl.options.length !== boards.length) return false;
  return boards.every(
    (b, i) =>
      selectEl.options[i].value === b.id &&
      selectEl.options[i].textContent === boardDisplayName(b)
  );
}
