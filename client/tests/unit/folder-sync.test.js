import { beforeEach, expect, test, vi } from 'vitest';
import { deleteDB } from 'idb';
import { resetLocalStorage } from './setup.js';
import { EVENT_EMITTED, off, on, _resetEventsForTesting } from '../../src/modules/events.js';
import { EVENTS_STORE, openStore, _resetIdbForTesting } from '../../src/modules/idb-store.js';
import { _resetHlcForTesting } from '../../src/modules/event-sourcing/hlc.js';
import {
  WRITER_ID_RE,
  getLinkStatus,
  getTransportMode,
  isLinked,
  linkFolder,
  pickFolder,
  flushPendingOutbound,
  reconcile,
  routeOutbound,
  setTransportMode,
  unlinkFolder,
  _resetFolderSyncForTesting
} from '../../src/modules/folder-sync.js';

const DB_NAME = 'openagile-db';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeAt(base, pos, chunk) {
  const out = new Uint8Array(Math.max(base.length, pos + chunk.length));
  out.set(base, 0);
  out.set(chunk, pos);
  return out;
}

class FakeFile {
  constructor() {
    this.bytes = new Uint8Array(0);
  }
  get size() {
    return this.bytes.length;
  }
  async text() {
    return decoder.decode(this.bytes);
  }
  async arrayBuffer() {
    return this.bytes.slice().buffer;
  }
}

class FakeFileHandle {
  constructor(file) {
    this.kind = 'file';
    this.file = file;
  }
  async getFile() {
    return this.file;
  }
  async createWritable(options = {}) {
    let buffer = options.keepExistingData === true ? this.file.bytes : new Uint8Array(0);
    let position = 0;
    const handle = this;
    return {
      async seek(pos) { position = pos; },
      async write(data) {
        const chunk = typeof data === 'string' ? encoder.encode(data) : data;
        buffer = writeAt(buffer, position, chunk);
        position += chunk.length;
      },
      async close() { handle.file.bytes = buffer; }
    };
  }
}

class FakeDirHandle {
  constructor(name = 'agileboard') {
    this.kind = 'directory';
    this.name = name;
    this.dirs = new Map();
    this.files = new Map();
  }
  async getDirectoryHandle(name, options = {}) {
    if (!this.dirs.has(name)) {
      if (options.create !== true) throw new Error(`NotFoundError: ${name}`);
      this.dirs.set(name, new FakeDirHandle(name));
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (options.create !== true) throw new Error(`NotFoundError: ${name}`);
      this.files.set(name, new FakeFileHandle(new FakeFile()));
    }
    return this.files.get(name);
  }
  async *entries() {
    yield* this.files;
    yield* this.dirs;
  }
}

async function seedShard(dir, writerId, text) {
  const eventsDir = await dir.getDirectoryHandle('events', { create: true });
  const file = new FakeFile();
  file.bytes = encoder.encode(text);
  eventsDir.files.set(`${writerId}.ndjson`, new FakeFileHandle(file));
  return file;
}

async function readShardText(dir, writerId) {
  const handle = dir.dirs.get('events')?.files.get(`${writerId}.ndjson`);
  return handle ? handle.file.text() : null;
}

async function readCursor(dir, sessionId) {
  const handle = dir.dirs.get('cursors')?.files.get(`browser-${sessionId}.json`);
  return handle ? JSON.parse(await handle.file.text()) : null;
}

function makeEvent(id, wallTime = 1000) {
  return {
    id,
    type: 'task.created',
    hlc: { wallTime, counter: 0, nodeId: 'node-remote' },
    at: '2026-05-26T00:00:00.000Z',
    actor: { type: 'human', id: null },
    scope: 'board',
    board_id: 'board-a',
    entity_id: 'task-a',
    payload: { task: { id: 'task-a', title: 'T', column: 'todo', columnHistory: [] } }
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  resetLocalStorage();
  _resetFolderSyncForTesting();
  _resetHlcForTesting();
  _resetEventsForTesting();
  _resetIdbForTesting();
  await deleteDB(DB_NAME);
});

test('pickFolder returns null and reports unsupported when the API is absent', async () => {
  delete globalThis.window.showDirectoryPicker;

  await expect(pickFolder()).resolves.toBeNull();
  expect(getLinkStatus().lastError).toBe('unsupported');
});

test('pickFolder returns null when the user cancels the picker', async () => {
  globalThis.window.showDirectoryPicker = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };

  await expect(pickFolder()).resolves.toBeNull();
  expect(getLinkStatus().lastError).toBeNull();
  delete globalThis.window.showDirectoryPicker;
});

test('illegal writer id is rejected and the regex refuses path traversal', async () => {
  const dir = new FakeDirHandle('board');

  await expect(linkFolder({ directory: dir, sessionId: 'bad id!' })).rejects.toThrow(/invalid writer id/);
  expect(WRITER_ID_RE.test('../mcp')).toBe(false);
  expect(WRITER_ID_RE.test('browser-2f3c')).toBe(true);
});

test('first append creates the shard with exactly one line', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'append-one' });
  const event = makeEvent('append-1');

  expect(await routeOutbound(event)).toBe(true);
  expect(await readShardText(dir, 'browser-append-one')).toBe(`${JSON.stringify(event)}\n`);
  expect(await routeOutbound(event)).toBe(false);
  expect((await readShardText(dir, 'browser-append-one')).trimEnd().split('\n')).toHaveLength(1);
});

test('second append grows the shard without rewriting prior lines', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'append-two' });
  const first = makeEvent('append-2a', 1000);
  const second = makeEvent('append-2b', 1001);

  await routeOutbound(first);
  await routeOutbound(second);

  const text = await readShardText(dir, 'browser-append-two');
  expect(text).toBe(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
});

test('concurrent appends are serialized in call order', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'append-conc' });
  const first = makeEvent('conc-a', 1000);
  const second = makeEvent('conc-b', 1001);

  await Promise.all([routeOutbound(first), routeOutbound(second)]);

  const lines = (await readShardText(dir, 'browser-append-conc')).split('\n');
  expect(lines[0]).toBe(JSON.stringify(first));
  expect(lines[1]).toBe(JSON.stringify(second));
});

test('torn last line is not consumed and does not advance the cursor', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'torn' });
  const first = makeEvent('torn-1', 1000);
  const second = makeEvent('torn-2', 1001);
  const line1 = `${JSON.stringify(first)}\n`;
  const torn = await seedShard(dir, 'mcp', line1 + JSON.stringify(second));

  const result = await reconcile();
  expect(result).toEqual({ merged: 1, scanned: 1 });
  expect(getLinkStatus().lastMergedEventId).toBe('torn-1');
  expect(await readCursor(dir, 'torn')).toEqual({ mcp: encoder.encode(line1).length });

  const again = await reconcile();
  expect(again).toEqual({ merged: 0, scanned: 0 });
  expect(await readCursor(dir, 'torn')).toEqual({ mcp: encoder.encode(line1).length });

  torn.bytes = encoder.encode(line1 + JSON.stringify(second) + '\n');
  expect(await reconcile()).toEqual({ merged: 1, scanned: 1 });
  expect(getLinkStatus().lastMergedEventId).toBe('torn-2');
  expect(await readCursor(dir, 'torn')).toEqual({ mcp: encoder.encode(line1 + JSON.stringify(second) + '\n').length });
});

test('duplicate event id is merged once across shards', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'dupe' });
  const event = makeEvent('dupe-1');
  await seedShard(dir, 'mcp', `${JSON.stringify(event)}\n`);
  await seedShard(dir, 'browser-other', `${JSON.stringify(event)}\n`);

  expect((await reconcile()).merged).toBe(1);
  expect((await reconcile()).merged).toBe(0);
});

test('unlinked routeOutbound buffers and flushes on link', async () => {
  const event = makeEvent('buffered-1');
  expect(isLinked()).toBe(false);

  expect(await routeOutbound(event)).toBe(false);
  expect(getLinkStatus().pendingOutbound).toBe(1);

  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'buffered' });

  expect(isLinked()).toBe(true);
  expect(getLinkStatus().pendingOutbound).toBe(0);
  expect(await readShardText(dir, 'browser-buffered')).toBe(`${JSON.stringify(event)}\n`);
});

test('merge persists remote events as synced and does not re-append them', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'merge' });
  const event = makeEvent('remote-1');
  await seedShard(dir, 'mcp', `${JSON.stringify(event)}\n`);

  expect((await reconcile()).merged).toBe(1);

  const db = await openStore();
  expect((await db.get(EVENTS_STORE, 'remote-1')).synced).toBe(true);
  expect(await readShardText(dir, 'browser-merge')).toBeNull();
  expect(await routeOutbound(event)).toBe(false);
});

test('merge emits EVENT_EMITTED once per unseen event and is idempotent', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'emit' });
  await seedShard(dir, 'mcp', `${JSON.stringify(makeEvent('emit-1'))}\n`);

  const seen = [];
  const handler = (e) => seen.push(e.detail.id);
  on(EVENT_EMITTED, handler);
  try {
    await reconcile();
    expect(seen).toEqual(['emit-1']);
    await reconcile();
    expect(seen).toEqual(['emit-1']);
  } finally {
    off(EVENT_EMITTED, handler);
  }
});

test('global events flow through the transport like any other event', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'global' });
  const group = {
    id: 'group-1',
    type: 'group.created',
    hlc: { wallTime: 2000, counter: 0, nodeId: 'node-remote' },
    at: '2026-05-26T00:00:00.000Z',
    actor: { type: 'agent', id: 'harness' },
    scope: 'global',
    board_id: null,
    entity_id: 'group-1',
    payload: { group: { id: 'group-1', name: 'Alpha', order: 1 } }
  };
  await seedShard(dir, 'mcp', `${JSON.stringify(group)}\n`);

  expect((await reconcile()).merged).toBe(1);
  const db = await openStore();
  expect((await db.get(EVENTS_STORE, 'group-1')).scope).toBe('global');
});

test('transport mode gates outbound appends', async () => {
  const dir = new FakeDirHandle('board');
  await linkFolder({ directory: dir, sessionId: 'mode' });
  const event = makeEvent('mode-1');

  expect(getTransportMode()).toBe('folder');
  expect(() => setTransportMode('nonsense')).toThrow(/Unknown transport mode/);

  setTransportMode('offline');
  expect(await routeOutbound(event)).toBe(false);
  expect(getLinkStatus().pendingOutbound).toBe(1);
  expect(await readShardText(dir, 'browser-mode')).toBeNull();

  setTransportMode('folder');
  expect(await flushPendingOutbound()).toBe(1);
  expect(getLinkStatus().pendingOutbound).toBe(0);
  expect(await readShardText(dir, 'browser-mode')).toBe(`${JSON.stringify(event)}\n`);

  await unlinkFolder();
  expect(getTransportMode()).toBe('bridge');
});

test('linkFolder injects the clock and logger hooks', async () => {
  const dir = new FakeDirHandle('board');
  const now = vi.fn(() => '2026-05-26T00:00:00.000Z');
  const log = { warn: vi.fn() };

  await linkFolder({ directory: dir, sessionId: 'hooks', now, log });

  expect(now).toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
  expect(getLinkStatus().folderName).toBe('board');
  expect(getLinkStatus().linkedAt).toBe('2026-05-26T00:00:00.000Z');
  await unlinkFolder();
  expect(getLinkStatus().linkedAt).toBeNull();
});
