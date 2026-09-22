import { isDoneColumn } from './constants.js';

export const MAX_WIP_LIMIT = 999;

export function normalizeWipLimit(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), MAX_WIP_LIMIT);
}

// Done is terminal and unbounded — a limit there would block finishing work.
export function getWipLimit(column) {
  if (!column || isDoneColumn(column)) return 0;
  return normalizeWipLimit(column.wipLimit);
}

export function getWipState(count, column) {
  const limit = getWipLimit(column);
  if (!limit) return 'under';
  if (count > limit) return 'over';
  if (count === limit) return 'at';
  return 'under';
}

export function syncColumnWip(columnEl, count, column) {
  if (!columnEl) return;
  const next = getWipState(count, column);
  const prev = columnEl.getAttribute('data-wip');
  if (prev === next) return;
  columnEl.setAttribute('data-wip', next);
}
