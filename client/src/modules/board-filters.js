import { isDoneColumnId } from './storage.js';
import { compareColumnEntry } from './task-helpers.js';

let boardFilterQuery = '';

// Done column virtualization state
export const DONE_INITIAL_BATCH_SIZE = 50;
const DONE_LOAD_MORE_SIZE = 50;
let doneVisibleCount = DONE_INITIAL_BATCH_SIZE;

export function getDoneVisibleCount() {
  return doneVisibleCount;
}

export function growDoneVisibleCount() {
  doneVisibleCount += DONE_LOAD_MORE_SIZE;
}

function taskMatchesFilter(task, queryLower) {
  if (!queryLower) return true;

  const legacyTitle = typeof task?.text === 'string' ? task.text : '';
  const title = (typeof task?.title === 'string' && task.title.trim() !== '') ? task.title : legacyTitle;
  const description = typeof task?.description === 'string' ? task.description : '';

  if (title.toLowerCase().includes(queryLower)) return true;
  if (description.toLowerCase().includes(queryLower)) return true;

  return false;
}

// Apply the active board filter. Shared by the full rebuild and the reconcile
// adapter so both show and count exactly the same tasks under a filter.
export function selectVisibleTasks(tasks) {
  const queryLower = (boardFilterQuery || '').toString().trim().toLowerCase();
  if (!queryLower) return tasks;
  return tasks.filter((t) => taskMatchesFilter(t, queryLower));
}

// The Done-column "Show more" control. Shared by the full rebuild and the
// reconcile adapter so both grow the virtualized batch identically.
export function buildShowMoreButton(remaining, onShowMore) {
  const showMoreBtn = document.createElement('button');
  showMoreBtn.classList.add('show-more-btn');
  showMoreBtn.type = 'button';
  showMoreBtn.textContent = `Show more (${remaining} remaining)`;
  showMoreBtn.addEventListener('click', () => {
    growDoneVisibleCount();
    onShowMore();
  });
  return showMoreBtn;
}

// One Done-column slicing path, shared by the full rebuild and the reconcile
// adapter so both render - and paginate - exactly the same tasks.
export function selectColumnRenderPlan(columnId, visibleTasks) {
  const columnTasks = visibleTasks
    .filter((t) => t.column === columnId)
    .sort(compareColumnEntry);
  const doneVisibleCount = getDoneVisibleCount();
  const shouldVirtualize = isDoneColumnId(columnId) && columnTasks.length > DONE_INITIAL_BATCH_SIZE;
  return {
    columnTasks,
    tasksToRender: shouldVirtualize ? columnTasks.slice(0, doneVisibleCount) : columnTasks,
    remaining: shouldVirtualize ? columnTasks.length - doneVisibleCount : 0
  };
}
