// Folder sync — the third, independent transport. Mirrors this client's event
// log to a user-chosen `.agileboard/` folder through the File System Access API.
// Chromium desktop only: Firefox has no directory picker and Safari does not
// expose arbitrary read/write directory handles, so pickFolder() returns null
// there and callers surface "unsupported" as a designed outcome, not an error.
//
// The browser owns exactly two files and never touches the rest of the layout:
//
//   <folder>/events/<writerId>.ndjson   append-only, one compact JSON event/line
//   <folder>/cursors/<writerId>.json    { [writerId]: byteOffset } for every shard
//
// writerId is `browser-<sessionUUID>`: one shard per tab, generated at link time
// and never persisted, so two tabs can never share a file. The harness
// (harness/src/shards.mjs) owns manifest.json / state.json / snapshot.json /
// lock and reads the browser shards with the same byte-cursor rules.
//
// Transport precedence: exactly one outbound transport runs at a time. Linking
// selects 'folder'; unlinking returns to the 'bridge' default. While the mode is
// not 'folder' this module buffers instead of appending, and the wiring layer is
// responsible for pausing local-server in the reciprocal direction.

import { EVENT_EMITTED, emit } from './events.js';
import { EVENTS_STORE, openStore, persistEvent } from './idb-store.js';
import { observeRemote } from './event-sourcing/hlc.js';
import { generateUUID, parseJsonSafely } from './utils.js';

export const WRITER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const TRANSPORT_MODES = Object.freeze(['folder', 'bridge', 'offline']);

const EVENTS_DIR = 'events';
const CURSORS_DIR = 'cursors';
const SHARD_SUFFIX = '.ndjson';
const CURSOR_SUFFIX = '.json';
const SESSION_PREFIX = 'browser-';
const MAX_PENDING_OUTBOUND = 500;
const DEFAULT_MODE = 'bridge';

let _directory = null;
let _sessionId = null;
let _cursor = {};
let _transportMode = DEFAULT_MODE;
let _linkedAt = null;
let _lastError = null;
let _lastMergedEventId = null;
let _now = () => new Date().toISOString();
let _log = console;

const _remoteIds = new Set();
const _appendedIds = new Set();
const _pendingOutbound = [];

let _lockChain = Promise.resolve();
let _reconcileChain = Promise.resolve();

function writerIdFor(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`;
}

function cursorNameFor(writerId) {
  return `${writerId}${CURSOR_SUFFIX}`;
}

function recordError(err) {
  _lastError = err?.message || String(err);
  return _lastError;
}

async function ensureDirs(directory) {
  await directory.getDirectoryHandle(EVENTS_DIR, { create: true });
  await directory.getDirectoryHandle(CURSORS_DIR, { create: true });
}

async function loadCursor(directory, cursorName) {
  const dir = await directory.getDirectoryHandle(CURSORS_DIR, { create: true });
  const handle = await dir.getFileHandle(cursorName, { create: true });
  const parsed = parseJsonSafely(await (await handle.getFile()).text());
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

async function saveCursor(directory, cursorName, cursor) {
  const dir = await directory.getDirectoryHandle(CURSORS_DIR, { create: true });
  const handle = await dir.getFileHandle(cursorName, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(cursor));
  } finally {
    await writable.close();
  }
}

// createWritable() truncates by default, so keep the existing bytes and seek
// past them before writing the one new line. The shard is never rewritten.
async function appendLine(directory, writerId, line) {
  const dir = await directory.getDirectoryHandle(EVENTS_DIR, { create: true });
  const handle = await dir.getFileHandle(`${writerId}${SHARD_SUFFIX}`, { create: true });
  const size = (await handle.getFile()).size;
  const writable = await handle.createWritable({ keepExistingData: true });
  try {
    await writable.seek(size);
    await writable.write(line);
  } finally {
    await writable.close();
  }
}

// Serialize appends per shard. Web Locks coordinates across same-origin tabs;
// where it is unavailable this module-level promise chain serializes within the
// tab (Node/tests, non-Chromium browsers).
function withShardLock(writerId, fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (locks && typeof locks.request === 'function') {
    return locks.request(`${EVENTS_DIR}/${writerId}${SHARD_SUFFIX}`, fn);
  }
  const run = _lockChain.then(fn, fn);
  _lockChain = run.then(() => undefined, () => undefined);
  return run;
}

// Mirror of harness readShardFrom: only complete, parseable lines are consumed.
// An empty line, an unterminated final line, or a line that fails JSON.parse
// stops the read without advancing the cursor. Re-reading is harmless because
// merging dedupes by event id.
async function readShard(eventsDir, writerId, offset) {
  let handle;
  try {
    handle = await eventsDir.getFileHandle(`${writerId}${SHARD_SUFFIX}`);
  } catch {
    return { events: [], offset };
  }
  const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
  const start = Number.isFinite(offset) && offset >= 0 && offset <= bytes.length ? offset : 0;
  const events = [];
  let cursor = start;
  while (cursor < bytes.length) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline === -1) break;
    const line = new TextDecoder().decode(bytes.subarray(cursor, newline));
    if (line === '') break;
    let event;
    try { event = JSON.parse(line); } catch { break; }
    if (!event || typeof event !== 'object') break;
    events.push(event);
    cursor = newline + 1;
  }
  return { events, offset: cursor };
}

async function listShardWriters(eventsDir) {
  const writers = [];
  for await (const [name, handle] of eventsDir.entries()) {
    if (!name.endsWith(SHARD_SUFFIX)) continue;
    if (handle && handle.kind !== 'file') continue;
    const writerId = name.slice(0, -SHARD_SUFFIX.length);
    if (WRITER_ID_RE.test(writerId)) writers.push(writerId);
  }
  return writers.sort();
}

async function mergeEvent(event, seen) {
  if (!event?.id || seen.has(event.id)) return false;
  if (event.hlc) await observeRemote(event.hlc);
  await persistEvent({ ...event, synced: true });
  seen.add(event.id);
  _remoteIds.add(event.id);
  _lastMergedEventId = event.id;
  emit(EVENT_EMITTED, event);
  return true;
}

async function runReconcile() {
  if (!isLinked()) return { merged: 0, scanned: 0 };
  const directory = _directory;
  const writerId = writerIdFor(_sessionId);
  const cursorName = cursorNameFor(writerId);

  let eventsDir;
  try {
    eventsDir = await directory.getDirectoryHandle(EVENTS_DIR, { create: true });
  } catch (err) {
    recordError(err);
    _log.warn('[openagile] folder reconcile failed', _lastError);
    return { merged: 0, scanned: 0 };
  }

  const db = await openStore();
  const seen = new Set((await db.getAll(EVENTS_STORE)).map((event) => event.id));
  let merged = 0;
  let scanned = 0;

  for (const remoteWriter of await listShardWriters(eventsDir)) {
    const start = Number.isFinite(_cursor[remoteWriter]) ? _cursor[remoteWriter] : 0;
    const { events, offset } = await readShard(eventsDir, remoteWriter, start);
    for (const event of events) {
      scanned += 1;
      if (await mergeEvent(event, seen)) merged += 1;
    }
    if (offset !== start || !Object.prototype.hasOwnProperty.call(_cursor, remoteWriter)) {
      _cursor[remoteWriter] = offset;
      await saveCursor(directory, cursorName, _cursor);
    }
  }

  return { merged, scanned };
}

export async function pickFolder() {
  const picker = typeof window !== 'undefined' ? window.showDirectoryPicker : null;
  if (typeof picker !== 'function') {
    _lastError = 'unsupported';
    return null;
  }
  try {
    return await picker.call(window, { mode: 'readwrite' });
  } catch (err) {
    if (err?.name === 'AbortError') {
      _lastError = null;
      return null;
    }
    recordError(err);
    return null;
  }
}

export function isLinked() {
  return _directory !== null;
}

export function getLinkStatus() {
  return {
    linked: _directory !== null,
    writerId: _sessionId ? writerIdFor(_sessionId) : null,
    folderName: _directory ? _directory.name ?? null : null,
    lastError: _lastError,
    pendingOutbound: _pendingOutbound.length,
    lastMergedEventId: _lastMergedEventId,
    linkedAt: _linkedAt
  };
}

export async function linkFolder({ directory, sessionId, now, log } = {}) {
  if (!directory || typeof directory.getDirectoryHandle !== 'function') {
    throw new Error('linkFolder requires a directory handle');
  }
  const sid = typeof sessionId === 'string' && sessionId ? sessionId : generateUUID();
  const writerId = writerIdFor(sid);
  if (!WRITER_ID_RE.test(writerId)) {
    throw new Error(`invalid writer id: ${writerId}`);
  }

  if (typeof now === 'function') _now = now;
  if (log && typeof log.warn === 'function') _log = log;

  await ensureDirs(directory);
  const cursor = await loadCursor(directory, cursorNameFor(writerId));

  _directory = directory;
  _sessionId = sid;
  _cursor = cursor;
    _transportMode = 'folder';
    _linkedAt = _now();
    _lastError = null;

    try {
    await flushPendingOutbound();
    await reconcile();
  } catch (err) {
    recordError(err);
    _log.warn('[openagile] folder link reconcile failed', _lastError);
  }
  return getLinkStatus();
}

export function unlinkFolder() {
  _directory = null;
  _sessionId = null;
  _cursor = {};
  _linkedAt = null;
  _lastMergedEventId = null;
  _transportMode = DEFAULT_MODE;
  _remoteIds.clear();
  _appendedIds.clear();
  _pendingOutbound.length = 0;
  return getLinkStatus();
}

export function setTransportMode(mode) {
  if (!TRANSPORT_MODES.includes(mode)) throw new Error(`Unknown transport mode: ${mode}`);
  _transportMode = mode;
  return _transportMode;
}

export function getTransportMode() {
  return _transportMode;
}

export async function routeOutbound(event) {
  if (!event?.id) return false;
  if (_remoteIds.has(event.id)) return false;
  if (!isLinked() || _transportMode !== 'folder') {
    if (_pendingOutbound.length < MAX_PENDING_OUTBOUND) _pendingOutbound.push(event);
    return false;
  }

  const writerId = writerIdFor(_sessionId);
  return withShardLock(writerId, async () => {
    if (_appendedIds.has(event.id)) return false;
    try {
      await appendLine(_directory, writerId, `${JSON.stringify(event)}\n`);
    } catch (err) {
      recordError(err);
      _log.warn('[openagile] folder shard append failed', _lastError);
      return false;
    }
    _appendedIds.add(event.id);
    return true;
  });
}

export async function flushPendingOutbound() {
  if (!isLinked() || _transportMode !== 'folder' || _pendingOutbound.length === 0) return 0;
  const batch = _pendingOutbound.splice(0, _pendingOutbound.length);
  let written = 0;
  for (const event of batch) {
    if (await routeOutbound(event)) written += 1;
  }
  return written;
}

export function reconcile() {
  const run = _reconcileChain.then(runReconcile, runReconcile);
  _reconcileChain = run.then(() => undefined, () => undefined);
  return run;
}

export function _resetFolderSyncForTesting() {
  _directory = null;
  _sessionId = null;
  _cursor = {};
  _transportMode = DEFAULT_MODE;
  _linkedAt = null;
  _lastError = null;
  _lastMergedEventId = null;
  _now = () => new Date().toISOString();
  _log = console;
  _remoteIds.clear();
  _appendedIds.clear();
  _pendingOutbound.length = 0;
  _lockChain = Promise.resolve();
  _reconcileChain = Promise.resolve();
}
