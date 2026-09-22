// Domain constants — single source of truth for values used across modules.

export const LEGACY_DONE_COLUMN_ID = 'done';
export const DONE_COLUMN_ROLE = 'done';
export const DONE_COLUMN_ID = LEGACY_DONE_COLUMN_ID;

export function isDoneColumn(column) {
  return column?.role === DONE_COLUMN_ROLE || column?.id === LEGACY_DONE_COLUMN_ID;
}

export const FIXED_COLUMNS = [
  { id: '00000000-0000-4000-8000-000000000030', name: 'Backlog', color: '#3583ff', order: 1 },
  { id: '00000000-0000-4000-8000-000000000034', name: 'Human In The Loop', color: '#8b5cf6', order: 2 },
  { id: '00000000-0000-4000-8000-000000000031', name: 'In Progress', color: '#f59e0b', order: 3 },
  { id: '00000000-0000-4000-8000-000000000032', name: 'Blocked', color: '#ef4444', order: 4 },
  { id: '00000000-0000-4000-8000-000000000033', name: 'Finished', color: '#16a34a', order: 5, role: DONE_COLUMN_ROLE }
];

export const BACKLOG_COLUMN_ID = FIXED_COLUMNS[0].id;
export const HIL_COLUMN_ID = FIXED_COLUMNS[1].id;
export const IN_PROGRESS_COLUMN_ID = FIXED_COLUMNS[2].id;
export const BLOCKED_COLUMN_ID = FIXED_COLUMNS[3].id;

export const APP_NAME = 'OpenAgile';

export const NO_BOARDS_KEY = 'openagile:noBoards';

export const LEGACY_COLUMN_ALIASES = new Map([
  ['todo', BACKLOG_COLUMN_ID],
  ['inprogress', IN_PROGRESS_COLUMN_ID],
  ['done', FIXED_COLUMNS[4].id],
  ['00000000-0000-4000-8000-000000000010', BACKLOG_COLUMN_ID],
  ['00000000-0000-4000-8000-000000000011', IN_PROGRESS_COLUMN_ID],
  ['00000000-0000-4000-8000-000000000012', FIXED_COLUMNS[4].id]
]);

export function canonicalColumnId(columnId) {
  const id = typeof columnId === 'string' ? columnId.trim() : '';
  return LEGACY_COLUMN_ALIASES.get(id) || id;
}

export const DEFAULT_COLUMN_COLOR = '#3b82f6';

export const DEFAULT_APP_KEYBINDINGS = {
  openBoardsModal: { key: 'b', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }
};

export function matchesKey(event, binding) {
  return event.key?.toLowerCase() === binding.key.toLowerCase()
    && Boolean(event.ctrlKey) === binding.ctrlKey
    && Boolean(event.shiftKey) === binding.shiftKey
    && Boolean(event.altKey) === binding.altKey
    && Boolean(event.metaKey) === binding.metaKey;
}
