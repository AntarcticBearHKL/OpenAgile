import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

// .agileboard/ layout. The harness (MCP) owns manifest.json, lock, state.json,
// snapshot.json and cursors/mcp.json; the browser only appends to
// events/<writer>.ndjson.
export const WRITER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const CURSOR_FILE = 'mcp.json';

function resolveLockStaleMs() {
  const parsed = Number(process.env.OPENAGILE_LOCK_STALE_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
}

const LOCK_STALE_MS = resolveLockStaleMs();
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_WAIT_MS = 15;
const RENAME_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function shardPath(dataDir, writerId) {
  if (!WRITER_ID_RE.test(writerId)) throw new Error(`invalid writer id: ${writerId}`);
  return join(dataDir, 'events', `${writerId}.ndjson`);
}

function cursorPath(dataDir) {
  return join(dataDir, 'cursors', CURSOR_FILE);
}

function writeLock(path, contents) {
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, JSON.stringify(contents)); } finally { closeSync(fd); }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function isLockFresh(existing) {
  const startedAt = Date.parse(existing?.startedAt);
  if (!Number.isFinite(startedAt) || Date.now() - startedAt > LOCK_STALE_MS) return false;
  return isPidAlive(existing.pid);
}

function ensureManifest(dataDir) {
  const path = join(dataDir, 'manifest.json');
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* rebuild an unreadable manifest */ }
  }
  const manifest = {
    format: 'openagile.board',
    formatVersion: 1,
    projectId: randomUUID(),
    createdAt: new Date().toISOString()
  };
  try {
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return manifest;
}

function acquireLock(dataDir) {
  const path = join(dataDir, 'lock');
  const token = randomUUID();
  const contents = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), token };
  try {
    writeLock(path, contents);
    return { path, token };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  let existing = null;
  try { existing = JSON.parse(readFileSync(path, 'utf8')); } catch { existing = null; }
  if (existing && isLockFresh(existing)) {
    console.warn(`[harness] advisory lock held by pid ${existing.pid} on ${existing.host}; continuing without it`);
    return null;
  }

  console.warn('[harness] taking over a stale advisory lock');
  try { unlinkSync(path); } catch { /* already gone */ }
  try {
    writeLock(path, contents);
    return { path, token };
  } catch (err) {
    console.warn('[harness] advisory lock not acquired', err?.message);
    return null;
  }
}

function loadCursors(dataDir) {
  const path = cursorPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveCursors(dataDir, cursors) {
  const path = cursorPath(dataDir);
  mkdirSync(join(dataDir, 'cursors'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursors));
  renameWithRetry(tmp, path);
}

function readShardFrom(dataDir, writerId, offset) {
  const path = shardPath(dataDir, writerId);
  if (!existsSync(path)) return { events: [], offset };
  const bytes = readFileSync(path);
  const start = Number.isFinite(offset) && offset >= 0 && offset <= bytes.length ? offset : 0;
  const events = [];
  let cursor = start;
  while (cursor < bytes.length) {
    const newline = bytes.indexOf(0x0a, cursor);
    if (newline === -1) break;
    const line = bytes.toString('utf8', cursor, newline);
    if (line === '') break;
    let event;
    try { event = JSON.parse(line); } catch { break; }
    if (!event || typeof event !== 'object') break;
    events.push(event);
    cursor = newline + 1;
  }
  return { events, offset: cursor };
}

export function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY';
      if (!transient || attempt >= RENAME_ATTEMPTS) throw err;
      Atomics.wait(RENAME_SLEEP, 0, 0, RENAME_RETRY_WAIT_MS);
    }
  }
}

export function ensureLayout(dataDir) {
  mkdirSync(join(dataDir, 'events'), { recursive: true });
  mkdirSync(join(dataDir, 'cursors'), { recursive: true });
  if (!existsSync(cursorPath(dataDir))) saveCursors(dataDir, {});
  const manifest = ensureManifest(dataDir);
  const lock = acquireLock(dataDir);
  return { manifest, lock };
}

export function releaseLock(dataDir, lock) {
  if (!lock) return;
  const path = lock.path || join(dataDir, 'lock');
  try {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (current?.token !== lock.token) return;
    unlinkSync(path);
  } catch { /* lock already released */ }
}

export function appendShard(dataDir, writerId, event) {
  appendFileSync(shardPath(dataDir, writerId), `${JSON.stringify(event)}\n`);
}

export function listShardWriters(dataDir) {
  const dir = join(dataDir, 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => name.slice(0, -'.ndjson'.length))
    .filter((writerId) => WRITER_ID_RE.test(writerId))
    .sort();
}

export function mergeShards(dataDir, accept) {
  const cursors = loadCursors(dataDir);
  let accepted = 0;
  for (const writerId of listShardWriters(dataDir)) {
    const start = Number.isFinite(cursors[writerId]) ? cursors[writerId] : 0;
    const { events, offset } = readShardFrom(dataDir, writerId, start);
    for (const event of events) {
      if (accept(event)) accepted += 1;
    }
    if (offset !== start || !Object.prototype.hasOwnProperty.call(cursors, writerId)) {
      cursors[writerId] = offset;
      saveCursors(dataDir, cursors);
    }
  }
  return accepted;
}
