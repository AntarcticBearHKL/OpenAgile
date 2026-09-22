// Append-only JSONL journal for the supervisor.
//
// It is three things at once:
//   • the authoritative audit trail (list_events is truncated by compaction, so
//     the harness event log is not a durable record)
//   • an idempotency map: any entry carrying an `idempotencyKey` is indexed
//   • a persisted lease table: `setLease` appends a lease entry and the latest
//     entry per taskId wins, so leases survive a supervisor restart
//
// Every append is one synchronous line write, so a crash never loses an entry.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function openJournal({ path } = {}) {
  if (!path || typeof path !== 'string') throw new Error('openJournal requires a path');

  mkdirSync(dirname(path), { recursive: true });

  const entries = load();
  const leases = new Map();
  const idempotency = new Map();

  function load() {
    if (!existsSync(path)) return [];
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { return []; }
    const parsed = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      try {
        const entry = JSON.parse(text);
        if (entry && typeof entry === 'object') parsed.push(entry);
      } catch {
        // A torn final line from a hard crash is skipped; everything before it is real.
      }
    }
    return parsed;
  }

  function index(entry) {
    if (entry.type === 'lease') {
      if (entry.lease && typeof entry.lease === 'object') leases.set(entry.taskId, entry.lease);
      else leases.delete(entry.taskId);
    }
    if (typeof entry.idempotencyKey === 'string' && entry.idempotencyKey) {
      idempotency.set(entry.idempotencyKey, entry);
    }
  }

  for (const entry of entries) index(entry);

  function append(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('journal.append requires an entry object');
    }
    const record = { ts: new Date().toISOString(), ...entry };
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    entries.push(record);
    index(record);
    return record;
  }

  function read() {
    return entries.slice();
  }

  function findByIdempotencyKey(key) {
    if (typeof key !== 'string' || !key) return null;
    return idempotency.get(key) || null;
  }

  function setLease(taskId, leaseOrNull) {
    if (!taskId) throw new Error('setLease requires a taskId');
    const lease = leaseOrNull
      ? { ...leaseOrNull, taskId: leaseOrNull.taskId || taskId }
      : null;
    return append({ type: 'lease', taskId, lease });
  }

  function getLeases() {
    const out = {};
    for (const [taskId, lease] of leases) out[taskId] = lease;
    return out;
  }

  function close() {
    // appendFileSync already flushed every line; nothing to release.
  }

  return { append, read, findByIdempotencyKey, setLease, getLeases, close };
}
