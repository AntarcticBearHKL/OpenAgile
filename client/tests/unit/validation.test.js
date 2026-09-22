import { test, expect } from 'vitest';
import { validateTaskTitle } from '../../src/modules/validation.js';

// ── validateTaskTitle ───────────────────────────────────────────────

test('validateTaskTitle returns true for non-empty string', () => {
  expect(validateTaskTitle('My Task')).toBe(true);
});

test('validateTaskTitle returns true for whitespace-padded non-empty string', () => {
  expect(validateTaskTitle('  Task  ')).toBe(true);
});

test('validateTaskTitle returns false for empty string', () => {
  expect(validateTaskTitle('')).toBe(false);
});

test('validateTaskTitle returns false for whitespace-only string', () => {
  expect(validateTaskTitle('   ')).toBe(false);
});

test('validateTaskTitle returns false for null and undefined', () => {
  expect(validateTaskTitle(null)).toBe(false);
  expect(validateTaskTitle(undefined)).toBe(false);
});

// ── validateColumnName ──────────────────────────────────────────────


