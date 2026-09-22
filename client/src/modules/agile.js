// Agile task-model helpers: normalizers for the extended task fields, the
// human-readable task key generator, and the blocked/age/stale predicates.
// The key generator mirrors the server implementation in the MCP harness so
// client-created and agent-created tasks share one numbering scheme.

import { generateUUID } from './utils.js';
import { BLOCKED_COLUMN_ID } from './constants.js';

export const TASK_TYPES = ['story', 'bug', 'task', 'spike'];
export const DEFAULT_TASK_TYPE = 'task';
export const TASK_KEY_FALLBACK = 'BRD';
export const STALE_AFTER_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const TASK_TYPE_SET = new Set(TASK_TYPES);

export function normalizeTaskType(value) {
  const v = (value ?? '').toString().trim().toLowerCase();
  return TASK_TYPE_SET.has(v) ? v : DEFAULT_TASK_TYPE;
}

export function normalizeEstimate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeKeyPoints(value) {
  if (!Array.isArray(value)) return [];
  const nowIso = new Date().toISOString();
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const point = {
        id: (entry.id ?? '').toString().trim() || generateUUID(),
        text: (entry.text ?? '').toString().trim(),
        at: (entry.at ?? '').toString().trim() || nowIso
      };
      const digestedAt = (entry.digestedAt ?? '').toString().trim();
      if (digestedAt) point.digestedAt = digestedAt;
      return point;
    })
    .filter((entry) => entry.text);
}

export function normalizeComments(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: (entry.id ?? '').toString().trim() || generateUUID(),
      author: (entry.author ?? '').toString().trim() || 'You',
      text: (entry.text ?? '').toString().trim(),
      at: (entry.at ?? '').toString().trim() || new Date().toISOString()
    }))
    .filter((entry) => entry.text);
}

/**
 * Board-name → key prefix. Mirrors the server: strip non-alphanumerics, then
 * use the first letter of every word when there are 2+, otherwise the first
 * three characters of the single word. Uppercase, max 4 chars, fallback BRD.
 */
export function boardKeyPrefix(boardName) {
  const name = (boardName ?? '').toString().replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length >= 2
    ? words.map((word) => word[0]).join('')
    : (words[0] || TASK_KEY_FALLBACK).slice(0, 3);
  return letters.toUpperCase().slice(0, 4) || TASK_KEY_FALLBACK;
}

/**
 * Next `PREFIX-<n>` for the board, where n is the highest existing numeric
 * suffix for that prefix across the board's tasks plus one.
 */
export function nextTaskKey(boardName, tasks = []) {
  const prefix = boardKeyPrefix(boardName);
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const task of tasks) {
    const match = pattern.exec((task && task.key) || '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${max + 1}`;
}

/**
 * True when the column is the board's Blocked column. Columns are passed in
 * (rather than read from storage) so callers control the read.
 */
export function isBlockedColumnId(columnId, columns) {
  const id = typeof columnId === 'string' ? columnId.trim() : '';
  if (!id || !Array.isArray(columns)) return false;
  const column = columns.find((entry) => entry && entry.id === id);
  return column?.id === BLOCKED_COLUMN_ID;
}

/** Whole days since creationDate, or null when the task has no valid date. */
export function taskAgeDays(task, now = new Date()) {
  const created = new Date(task?.creationDate || '').getTime();
  if (!Number.isFinite(created)) return null;
  const diff = now.getTime() - created;
  if (diff <= 0) return 0;
  return Math.floor(diff / DAY_MS);
}

/** True when the task has not changed for more than `staleDays` days. */
export function isTaskStale(task, now = new Date(), staleDays = STALE_AFTER_DAYS) {
  const stamp = new Date(task?.changeDate || task?.creationDate || '').getTime();
  if (!Number.isFinite(stamp)) return false;
  return (now.getTime() - stamp) > staleDays * DAY_MS;
}
