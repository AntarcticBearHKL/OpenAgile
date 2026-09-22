import { parseJsonSafely } from './utils.js';

// ── Constants ──────────────────────────────────────────────────────────────────

export const BOARDS_KEY = 'kanbanBoards';
export const ACTIVE_BOARD_KEY = 'kanbanActiveBoardId';
export const GLOBAL_PROJECTION_KEY = 'openagile:global:projection';

export const LEGACY_COLUMNS_KEY = 'kanbanColumns';
export const LEGACY_TASKS_KEY = 'kanbanTasks';

export const DEFAULT_BOARD_ID = 'default';
// Well-known stable id for the auto-seeded "Default Board". Every fresh device
// mints the default board with THIS id (not a random UUID) so two devices on the
// same account converge onto a single board instead of accruing duplicates.
// Valid uuid-v4 shape so it passes existing id validation/UUID_RE checks.
export const STABLE_DEFAULT_BOARD_ID = '00000000-0000-4000-8000-000000000001';

// ── In-memory state ────────────────────────────────────────────────────────────
//
// All public CRUD functions read/write this object synchronously.
// IDB persistence happens asynchronously via schedulePersist().
// Call initStorage() once at app startup to populate from IDB.

export const state = {
  boards: [],
  activeBoardId: null,
  tasks: {},    // { [boardId]: task[] | null }
  columns: {},  // { [boardId]: column[] | null }
  settings: {}  // { [boardId]: object | null }
};

export const globalState = {
  groups: [],
  boardGroups: {},
  skills: []
};

// Per-board default-task cache (keeps defaults stable within a session).
export const taskCacheByBoard = new Map();

// Handles both pre-parsed objects (from IDB) and JSON strings (from legacy localStorage).
export function safeParseArray(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseJsonSafely(value);
    return Array.isArray(parsed) ? parsed : null;
  }
  return null;
}

export function safeParseObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseJsonSafely(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  }
  return null;
}

export function emitLocalChange(boardId, entity) {
  if (typeof window === 'undefined') return;
}

