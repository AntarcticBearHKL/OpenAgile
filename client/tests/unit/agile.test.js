import { test, expect } from 'vitest';
import { BLOCKED_COLUMN_ID } from '../../src/modules/constants.js';
import {
  DEFAULT_TASK_TYPE,
  STALE_AFTER_DAYS,
  boardKeyPrefix,
  isBlockedColumnId,
  isTaskStale,
  nextTaskKey,
  normalizeKeyPoints,
  normalizeComments,
  normalizeEstimate,
  normalizeTaskType,
  taskAgeDays
} from '../../src/modules/agile.js';

// ── normalizeTaskType ───────────────────────────────────────────────

test('normalizeTaskType accepts the four agile types', () => {
  expect(normalizeTaskType('story')).toBe('story');
  expect(normalizeTaskType('bug')).toBe('bug');
  expect(normalizeTaskType('task')).toBe('task');
  expect(normalizeTaskType('spike')).toBe('spike');
});

test('normalizeTaskType is case-insensitive and trims', () => {
  expect(normalizeTaskType(' BUG ')).toBe('bug');
  expect(normalizeTaskType('Spike')).toBe('spike');
});

test('normalizeTaskType falls back to task for invalid values', () => {
  expect(normalizeTaskType('epic')).toBe(DEFAULT_TASK_TYPE);
  expect(normalizeTaskType('')).toBe(DEFAULT_TASK_TYPE);
  expect(normalizeTaskType(null)).toBe(DEFAULT_TASK_TYPE);
  expect(normalizeTaskType(42)).toBe(DEFAULT_TASK_TYPE);
});

// ── normalizeEstimate ───────────────────────────────────────────────

test('normalizeEstimate keeps finite numbers including zero', () => {
  expect(normalizeEstimate(5)).toBe(5);
  expect(normalizeEstimate(0)).toBe(0);
  expect(normalizeEstimate(2.5)).toBe(2.5);
  expect(normalizeEstimate('8')).toBe(8);
});

test('normalizeEstimate returns null for empty or invalid values', () => {
  expect(normalizeEstimate(null)).toBeNull();
  expect(normalizeEstimate(undefined)).toBeNull();
  expect(normalizeEstimate('')).toBeNull();
  expect(normalizeEstimate('abc')).toBeNull();
  expect(normalizeEstimate(Infinity)).toBeNull();
});

// ── normalizeKeyPoints ──────────────────────────────────────────────

test('normalizeKeyPoints keeps text, ids and timestamps and drops any done flag', () => {
  const result = normalizeKeyPoints([
    { id: 'k1', text: ' Works offline ', done: true, at: '2026-01-01T00:00:00.000Z' },
    { id: 'k2', text: 'Syncs', done: 'yes', at: '2026-01-02T00:00:00.000Z' }
  ]);

  expect(result).toEqual([
    { id: 'k1', text: 'Works offline', at: '2026-01-01T00:00:00.000Z' },
    { id: 'k2', text: 'Syncs', at: '2026-01-02T00:00:00.000Z' }
  ]);
});

test('normalizeKeyPoints generates missing ids and timestamps and drops empty text', () => {
  const result = normalizeKeyPoints([
    { text: 'No id' },
    { id: 'k2', text: '   ' },
    null
  ]);

  expect(result).toHaveLength(1);
  expect(result[0].text).toBe('No id');
  expect(typeof result[0].id).toBe('string');
  expect(result[0].id.length).toBeGreaterThan(0);
  expect(Number.isNaN(new Date(result[0].at).getTime())).toBe(false);
});

test('normalizeKeyPoints preserves a digestedAt stamp', () => {
  const result = normalizeKeyPoints([
    { id: 'k1', text: 'Folded in', at: '2026-01-01T00:00:00.000Z', digestedAt: '2026-01-02T00:00:00.000Z' }
  ]);

  expect(result[0].digestedAt).toBe('2026-01-02T00:00:00.000Z');
});

test('normalizeKeyPoints returns [] for non-arrays', () => {
  expect(normalizeKeyPoints(null)).toEqual([]);
  expect(normalizeKeyPoints('nope')).toEqual([]);
});

// ── normalizeComments ───────────────────────────────────────────────

test('normalizeComments defaults the author to You and preserves timestamps', () => {
  const result = normalizeComments([
    { id: 'c1', text: 'Hello', at: '2026-01-02T03:04:05.000Z' }
  ]);

  expect(result[0].author).toBe('You');
  expect(result[0].at).toBe('2026-01-02T03:04:05.000Z');
});

test('normalizeComments stamps a missing timestamp and drops empty text', () => {
  const result = normalizeComments([{ text: 'Hi' }, { text: '   ' }]);

  expect(result).toHaveLength(1);
  expect(Number.isNaN(new Date(result[0].at).getTime())).toBe(false);
});

// ── boardKeyPrefix / nextTaskKey ────────────────────────────────────

test('boardKeyPrefix uses initials for multi-word names', () => {
  expect(boardKeyPrefix('Default Board')).toBe('DB');
  expect(boardKeyPrefix('My Board')).toBe('MB');
  expect(boardKeyPrefix('Alpha Beta Gamma Delta Epsilon')).toBe('ABGD');
});

test('boardKeyPrefix uses the first three chars for single-word names', () => {
  expect(boardKeyPrefix('Test')).toBe('TES');
  expect(boardKeyPrefix('Work')).toBe('WOR');
  expect(boardKeyPrefix('x')).toBe('X');
});

test('boardKeyPrefix strips non-alphanumerics and falls back to BRD', () => {
  expect(boardKeyPrefix('My-Board')).toBe('MB');
  expect(boardKeyPrefix('Sprint #4!')).toBe('S4');
  expect(boardKeyPrefix('')).toBe('BRD');
  expect(boardKeyPrefix('   ')).toBe('BRD');
  expect(boardKeyPrefix(null)).toBe('BRD');
});

test('nextTaskKey starts at 1 for a fresh board', () => {
  expect(nextTaskKey('Default Board', [])).toBe('DB-1');
});

test('nextTaskKey increments past the highest matching suffix', () => {
  const tasks = [{ key: 'DB-3' }, { key: 'DB-1' }, { key: 'TES-9' }];
  expect(nextTaskKey('Default Board', tasks)).toBe('DB-4');
});

test('nextTaskKey ignores malformed or foreign keys', () => {
  const tasks = [{ key: 'DB-x' }, { key: 'DB-2-extra' }, { key: null }, {}];
  expect(nextTaskKey('Default Board', tasks)).toBe('DB-1');
});

// ── isBlockedColumnId ───────────────────────────────────────────────

test('isBlockedColumnId matches the Blocked column by id', () => {
  const columns = [
    { id: 'todo', name: 'To Do' },
    { id: BLOCKED_COLUMN_ID, name: 'Blocked' }
  ];

  expect(isBlockedColumnId(BLOCKED_COLUMN_ID, columns)).toBe(true);
  expect(isBlockedColumnId('todo', columns)).toBe(false);
  expect(isBlockedColumnId('missing', columns)).toBe(false);
  expect(isBlockedColumnId('', columns)).toBe(false);
  expect(isBlockedColumnId(BLOCKED_COLUMN_ID, null)).toBe(false);
});

// ── taskAgeDays / isTaskStale ───────────────────────────────────────

const NOW = new Date('2026-06-15T12:00:00Z');

test('taskAgeDays counts whole days since creationDate', () => {
  expect(taskAgeDays({ creationDate: '2026-06-15T08:00:00Z' }, NOW)).toBe(0);
  expect(taskAgeDays({ creationDate: '2026-06-05T12:00:00Z' }, NOW)).toBe(10);
});

test('taskAgeDays returns null without a valid creationDate', () => {
  expect(taskAgeDays({}, NOW)).toBeNull();
  expect(taskAgeDays({ creationDate: 'not-a-date' }, NOW)).toBeNull();
});

test('isTaskStale flags tasks unchanged for more than 14 days', () => {
  expect(isTaskStale({ changeDate: '2026-05-31T12:00:00Z' }, NOW)).toBe(true);
  expect(isTaskStale({ changeDate: '2026-06-10T12:00:00Z' }, NOW)).toBe(false);
  expect(STALE_AFTER_DAYS).toBe(14);
});

test('isTaskStale falls back to creationDate and ignores missing dates', () => {
  expect(isTaskStale({ creationDate: '2026-01-01T00:00:00Z' }, NOW)).toBe(true);
  expect(isTaskStale({}, NOW)).toBe(false);
});
