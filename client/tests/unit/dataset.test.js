import { beforeEach, expect, test, vi } from 'vitest';
import { deleteDB } from 'idb';
import { resetLocalStorage } from './setup.js';
import { exportDataset, computeDatasetChecksum } from '../../src/modules/dataset-export.js';
import { importDataset } from '../../src/modules/dataset-import.js';
import { openStore } from '../../src/modules/idb-store.js';
import {
  initStorage,
  ensureBoardsInitialized,
  getActiveBoardId,
  listBoards,
  loadTasksForBoard,
  _flushPersistsForTesting,
  _resetStorageForTesting
} from '../../src/modules/storage.js';
import { scheduleDomainEvent } from '../../src/modules/event-sourcing/emitter.js';
import { generateUUID } from '../../src/modules/utils.js';
import { FIXED_COLUMNS } from '../../src/modules/constants.js';

const DB_NAME = 'openagile-db';
const BACKLOG_COLUMN_ID = FIXED_COLUMNS[0].id;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const V1_PAYLOAD = {
  boardName: 'Legacy Board',
  columns: [
    { id: 'todo', name: 'Todo', color: '#3b82f6', order: 1 },
    { id: 'done', name: 'Done', color: '#16a34a', order: 2, role: 'done' }
  ],
  tasks: [{ id: 'task-1', title: 'Legacy task', column: 'todo', order: 1 }],
  labels: [{ id: 'label-1', name: 'Bug', color: '#ff0000' }],
  settings: { showChangeDate: false },
  exportMeta: { schemaVersion: 1, appVersion: '1.0.0', exportedAt: '2024-01-01T00:00:00.000Z' }
};

beforeEach(async () => {
  vi.restoreAllMocks();
  resetLocalStorage();
  await deleteDB(DB_NAME);
});

async function readAllEvents() {
  const db = await openStore();
  return db.getAll('events');
}

async function seedEventLog() {
  await initStorage();
  ensureBoardsInitialized();
  const boardId = getActiveBoardId();
  const taskId = generateUUID();
  await scheduleDomainEvent({
    type: 'task.created',
    boardId,
    entityId: taskId,
    payload: { task: { id: taskId, title: 'Round-trip task', column: BACKLOG_COLUMN_ID, order: 1 } }
  });
  await _flushPersistsForTesting();
  return { boardId, taskId };
}

async function resetToEmptyStore() {
  _resetStorageForTesting();
  await deleteDB(DB_NAME);
  await initStorage();
}

test('exportDataset writes a v2 bundle with counts, snapshots and a sha256 checksum', async () => {
  const { boardId } = await seedEventLog();
  const db = await openStore();
  await db.put('snapshots', {
    payload: { boards: [], tasks: [], columns: [], settings: {}, appliedEventIds: [], taskTombstones: [] },
    hlc: { wallTime: 1, counter: 0, nodeId: 'node-a' },
    at: '2024-01-01T00:00:00.000Z'
  }, 'snapshot-board');

  const bundle = await exportDataset();

  expect(bundle.format).toBe('openagile.dataset');
  expect(bundle.formatVersion).toBe(2);
  expect(bundle.protocolVersion).toBe(1);
  expect(bundle.writtenBy.nodeId).toMatch(UUID_RE);
  expect(typeof bundle.writtenBy.appVersion).toBe('string');
  expect(typeof bundle.exportedAt).toBe('string');
  expect(bundle.events.length).toBeGreaterThan(0);
  expect(bundle.snapshots['snapshot-board'].hlc).toEqual({ wallTime: 1, counter: 0, nodeId: 'node-a' });
  expect(bundle.boards.some((board) => board.id === boardId)).toBe(true);
  expect(bundle.counts).toEqual({ events: bundle.events.length, boards: 1, tasks: 1 });
  expect(bundle.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(await computeDatasetChecksum(bundle.events)).toBe(bundle.checksum);
  expect([...db.objectStoreNames].sort()).toEqual(['events', 'kv', 'read_model', 'snapshots']);
});

test('merge import round-trips the exported event set into an empty store', async () => {
  const { boardId, taskId } = await seedEventLog();
  const bundle = await exportDataset();
  const exportedIds = bundle.events.map((event) => event.id).sort();

  await resetToEmptyStore();

  const report = await importDataset(bundle);
  await _flushPersistsForTesting();

  const stored = await readAllEvents();
  expect(stored.map((event) => event.id).sort()).toEqual(exportedIds);
  expect(stored.every((event) => event.synced === true)).toBe(true);
  expect(report.importedEvents).toBe(exportedIds.length);
  expect(report.skippedEvents).toBe(0);
  expect(report.checksumVerified).toBe(true);
  expect(listBoards().some((board) => board.id === boardId)).toBe(true);
  expect(loadTasksForBoard(boardId).some((task) => task.id === taskId)).toBe(true);
});

test('merge import is idempotent: a second import adds no events and changes no projection', async () => {
  const { boardId } = await seedEventLog();
  const bundle = await exportDataset();

  await resetToEmptyStore();
  await importDataset(bundle);

  const eventsAfterFirst = await readAllEvents();
  const projectionAfterFirst = JSON.stringify({
    boards: listBoards(),
    tasks: loadTasksForBoard(boardId)
  });

  const second = await importDataset(bundle);

  expect(second.importedEvents).toBe(0);
  expect(second.skippedEvents).toBe(bundle.events.length);
  expect((await readAllEvents()).length).toBe(eventsAfterFirst.length);
  expect(JSON.stringify({ boards: listBoards(), tasks: loadTasksForBoard(boardId) })).toBe(projectionAfterFirst);
});

test('merge import accepts a v1 single-board payload by synthesizing genesis events', async () => {
  await initStorage();

  const report = await importDataset(V1_PAYLOAD);

  expect(report.source).toBe('v1');
  expect(report.mode).toBe('merge');
  expect(report.importedEvents).toBe(5);
  expect(report.limitations.join(' ')).toMatch(/no board id/);
  expect(report.limitations.join(' ')).toMatch(/no event history/);

  const board = listBoards().find((entry) => entry.name === 'Legacy Board');
  expect(board).toBeTruthy();

  const tasks = loadTasksForBoard(board.id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].id).toMatch(UUID_RE);
  expect(tasks[0].title).toBe('Legacy task');
  expect(tasks[0].column).toBe(BACKLOG_COLUMN_ID);

  const stored = await readAllEvents();
  expect(stored).toHaveLength(5);
  expect(stored.every((event) => event.synced === true)).toBe(true);
});

test('clone import remaps ids and creates a new board on every import', async () => {
  await initStorage();

  const first = await importDataset(V1_PAYLOAD, { mode: 'clone' });

  expect(first.mode).toBe('clone');
  expect(first.boardId).toMatch(UUID_RE);

  let boards = listBoards().filter((entry) => entry.name === 'Legacy Board');
  expect(boards).toHaveLength(1);
  expect(getActiveBoardId()).toBe(boards[0].id);

  const tasks = loadTasksForBoard(boards[0].id);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].id).toMatch(UUID_RE);
  expect(tasks[0].column).toBe(BACKLOG_COLUMN_ID);

  await importDataset(V1_PAYLOAD, { mode: 'clone' });

  boards = listBoards().filter((entry) => entry.name === 'Legacy Board');
  expect(boards).toHaveLength(2);
  expect(boards[0].id).not.toBe(boards[1].id);
});

test('merge import refuses a bundle whose checksum does not match and imports nothing', async () => {
  await seedEventLog();
  const bundle = await exportDataset();

  await resetToEmptyStore();
  bundle.events[0].payload = { ...bundle.events[0].payload, tampered: true };

  await expect(importDataset(bundle)).rejects.toThrow(/checksum mismatch/i);
  expect(await readAllEvents()).toHaveLength(0);
});

test('unknown event types are persisted and skipped by the reducer without throwing', async () => {
  const { boardId } = await seedEventLog();
  const taskIdsBefore = loadTasksForBoard(boardId).map((task) => task.id).sort();
  const unknownEvent = {
    id: generateUUID(),
    type: 'future.unknown.event',
    hlc: { wallTime: Date.now() + 60_000, counter: 0, nodeId: 'node-future' },
    at: new Date().toISOString(),
    actor: { type: 'human', id: null },
    scope: 'board',
    board_id: boardId,
    entity_id: generateUUID(),
    payload: {}
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const report = await importDataset({
    format: 'openagile.dataset',
    formatVersion: 2,
    protocolVersion: 1,
    writtenBy: { nodeId: 'node-test', appVersion: 'test' },
    exportedAt: new Date().toISOString(),
    events: [unknownEvent],
    snapshots: {},
    boards: [],
    counts: { events: 1, boards: 1, tasks: 0 }
  });

  expect(report.importedEvents).toBe(1);
  expect((await readAllEvents()).some((event) => event.id === unknownEvent.id)).toBe(true);
  expect(loadTasksForBoard(boardId).map((task) => task.id).sort()).toEqual(taskIdsBefore);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Unknown event type/));
});

test('importDataset rejects malformed payloads and modes with clear errors', async () => {
  await expect(importDataset({ format: 'other.format', formatVersion: 2, events: [] }))
    .rejects.toThrow(/Unsupported dataset format/);
  await expect(importDataset({ format: 'openagile.dataset', events: [] }))
    .rejects.toThrow(/formatVersion/);
  await expect(importDataset({ format: 'openagile.dataset', formatVersion: 2 }))
    .rejects.toThrow(/events array/);
  await expect(importDataset({ hello: 'world' }))
    .rejects.toThrow(/Unrecognized import payload/);
  await expect(importDataset({ format: 'openagile.dataset', formatVersion: 2, events: [] }, { mode: 'bogus' }))
    .rejects.toThrow(/Unsupported import mode/);
  await expect(importDataset({ format: 'openagile.dataset', formatVersion: 2, events: [] }, { mode: 'clone' }))
    .rejects.toThrow(/single-board payloads/);
});
