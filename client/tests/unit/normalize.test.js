import { test, expect } from 'vitest';
import {
  isHexColor,
  normalizeHexColor,
  boardDisplayName,
  normalizeActivityLog,
  normalizeStringKeys,
} from '../../src/modules/normalize.js';
import { DEFAULT_COLUMN_COLOR } from '../../src/modules/constants.js';

// ── isHexColor ──────────────────────────────────────────────────────

test('isHexColor accepts valid 6-digit hex colors', () => {
  expect(isHexColor('#aabbcc')).toBe(true);
  expect(isHexColor('#AABBCC')).toBe(true);
  expect(isHexColor('#3b82f6')).toBe(true);
});

test('isHexColor accepts valid 3-digit hex colors', () => {
  expect(isHexColor('#abc')).toBe(true);
  expect(isHexColor('#ABC')).toBe(true);
});

test('isHexColor rejects invalid values', () => {
  expect(isHexColor('aabbcc')).toBe(false);
  expect(isHexColor('#abcde')).toBe(false);
  expect(isHexColor('#abcdefg')).toBe(false);
  expect(isHexColor('')).toBe(false);
  expect(isHexColor(null)).toBe(false);
  expect(isHexColor(undefined)).toBe(false);
  expect(isHexColor(123)).toBe(false);
});

// ── normalizeHexColor ───────────────────────────────────────────────

test('normalizeHexColor returns valid color unchanged', () => {
  expect(normalizeHexColor('#3b82f6')).toBe('#3b82f6');
});

test('normalizeHexColor trims whitespace from valid color', () => {
  expect(normalizeHexColor('  #abc  ')).toBe('#abc');
});

test('normalizeHexColor returns default fallback for invalid color', () => {
  expect(normalizeHexColor('invalid')).toBe(DEFAULT_COLUMN_COLOR);
  expect(normalizeHexColor(null)).toBe(DEFAULT_COLUMN_COLOR);
});

test('normalizeHexColor uses custom fallback', () => {
  expect(normalizeHexColor('invalid', '#ff0000')).toBe('#ff0000');
});

// ── boardDisplayName ────────────────────────────────────────────────

test('boardDisplayName returns trimmed name', () => {
  expect(boardDisplayName({ name: '  My Board  ' })).toBe('My Board');
});

test('boardDisplayName returns Untitled board for missing/empty name', () => {
  expect(boardDisplayName({ name: '' })).toBe('Untitled board');
  expect(boardDisplayName({ name: '   ' })).toBe('Untitled board');
  expect(boardDisplayName(null)).toBe('Untitled board');
  expect(boardDisplayName(undefined)).toBe('Untitled board');
  expect(boardDisplayName({})).toBe('Untitled board');
});

// ── normalizeActivityLog ────────────────────────────────────────────

test('normalizeActivityLog drops malformed entries and preserves valid entries', () => {
  const validEvent = {
    type: 'task.created',
    at: '2026-05-01T00:00:00.000Z',
    actor: { type: 'human', id: null },
    details: { taskId: 'task-1' }
  };

  expect(normalizeActivityLog(null)).toEqual([]);
  expect(normalizeActivityLog('not-an-array')).toEqual([]);
  expect(normalizeActivityLog([
    validEvent,
    { at: validEvent.at, actor: validEvent.actor, details: validEvent.details },
    { type: 'task.created', actor: validEvent.actor, details: validEvent.details },
    { type: 'task.created', at: validEvent.at, details: validEvent.details },
    { type: 'task.created', at: validEvent.at, actor: validEvent.actor },
    { type: 'task.created', at: validEvent.at, actor: null, details: validEvent.details },
    { type: 'task.created', at: validEvent.at, actor: validEvent.actor, details: null }
  ])).toEqual([validEvent]);
});

test('normalizeActivityLog drops entries with empty type, non-parseable timestamp, or invalid actor', () => {
  const validEvent = {
    type: 'task.created',
    at: '2026-05-01T00:00:00.000Z',
    actor: { type: 'human', id: null },
    details: { taskId: 'task-1' }
  };

  expect(normalizeActivityLog([
    validEvent,
    { ...validEvent, type: '' },
    { ...validEvent, type: '   ' },
    { ...validEvent, at: 'not-a-date' },
    { ...validEvent, actor: { type: 'bot', id: 'bot-1' } },
    { ...validEvent, actor: { type: 'human', id: 'human-1' } },
    { ...validEvent, actor: { type: 'agent', id: '' } }
  ])).toEqual([validEvent]);
});

test('normalizeActivityLog accepts ISO timestamps with UTC offset and microsecond precision', () => {
  const base = {
    type: 'task.created',
    actor: { type: 'human', id: null },
    details: { taskId: 'task-1' }
  };
  // +00:00 offset form (valid ISO 8601)
  const withOffset = { ...base, at: '2026-05-01T00:00:00.000+00:00' };
  // microsecond precision (6 fractional digits)
  const withMicros = { ...base, at: '2026-05-01T00:00:00.000000Z' };

  expect(normalizeActivityLog([withOffset])).toEqual([withOffset]);
  expect(normalizeActivityLog([withMicros])).toEqual([withMicros]);
});

// ── normalizeStringKeys ─────────────────────────────────────────────

test('normalizeStringKeys deduplicates and trims', () => {
  expect(normalizeStringKeys(['a', ' b ', 'a', 'c'])).toEqual(['a', 'b', 'c']);
});

test('normalizeStringKeys filters empty strings and non-strings', () => {
  expect(normalizeStringKeys(['a', '', 42, null, 'b'])).toEqual(['a', 'b']);
});

test('normalizeStringKeys returns empty array for non-array input', () => {
  expect(normalizeStringKeys(null)).toEqual([]);
  expect(normalizeStringKeys('string')).toEqual([]);
  expect(normalizeStringKeys(undefined)).toEqual([]);
});

