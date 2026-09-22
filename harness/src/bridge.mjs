// Admission rules for the browser bridge — the client's POST /api/events channel
// into the same log the MCP tools write. The client keeps publishing its
// legitimate events; a request is refused when it would reach a state the
// workflow forbids, so the browser path and the MCP path enforce the same rules.
//
// Exposure is limited to local, same-origin callers: loopback remote address,
// loopback Host, and Origin matching Host when present. There is no token, so
// this stops a web page in another origin and DNS rebinding, not a local process.

import { IN_PROGRESS_COLUMN_ID, appendEvents, findTask, pendingNotes, pendingNotesMessage } from './store.mjs';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function parseAuthority(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return { host: url.host, hostname: url.hostname };
  } catch {
    return null;
  }
}

export function bridgeRequestDenial(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string' || !LOOPBACK_ADDRESSES.has(address)) {
    return 'The event bridge only accepts requests from the local machine.';
  }

  const host = parseAuthority(req?.headers?.host);
  if (!host || !LOOPBACK_HOSTNAMES.has(host.hostname)) {
    return 'The event bridge only accepts a loopback Host header (127.0.0.1, localhost or [::1]).';
  }

  const origin = req?.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    const originAuthority = parseAuthority(origin);
    if (!originAuthority || originAuthority.host !== host.host) {
      return `The event bridge refuses a request that is not same-origin (Origin: ${origin}, Host: ${host.host}).`;
    }
  }

  const site = req?.headers?.['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return `The event bridge refuses cross-site requests (Sec-Fetch-Site: ${site}).`;
  }

  return null;
}

function movedColumn(event) {
  const order = Array.isArray(event.payload?.order) ? event.payload.order : [];
  const entry = order.find((item) => item?.id === event.entity_id);
  if (entry && typeof entry.column === 'string') return entry.column;
  return typeof event.payload?.to_column === 'string' ? event.payload.to_column : '';
}

function stampedIds(task) {
  return new Set(
    (Array.isArray(task?.keyPoints) ? task.keyPoints : [])
      .filter((point) => point?.digestedAt)
      .map((point) => point?.id)
  );
}

function stampedNoteRefusal(alreadyStamped, incoming, ref) {
  if (!Array.isArray(incoming)) return null;
  for (const point of incoming) {
    if (!point?.digestedAt) continue;
    if (!alreadyStamped.has(point?.id)) {
      return `Task ${ref?.key || ref?.id}: notes are digested by the agent through digest_key_points, which folds them into the description first — the browser cannot stamp digestedAt.`;
    }
  }
  return null;
}

function moveRefusal(event) {
  if (movedColumn(event) !== IN_PROGRESS_COLUMN_ID) return null;
  const found = findTask(event.entity_id);
  return found ? pendingNotesMessage(found.task) : null;
}

function updateRefusal(event) {
  const found = findTask(event.entity_id);
  if (!found) return null;
  const { task } = found;
  const fields = event.payload?.fields;
  if (!fields || typeof fields !== 'object') return null;

  if (fields.column !== undefined) {
    return `Task ${task.key || task.id}: a column change is a task.moved event — task.updated may not write the column field.`;
  }
  if (fields.claimedBy !== undefined || fields.claimedAt !== undefined) {
    return `Task ${task.key || task.id}: claims belong to the agent — claim_task is the only way to claim a task.`;
  }

  const noteRefusal = stampedNoteRefusal(stampedIds(task), fields.keyPoints, task);
  if (noteRefusal) return noteRefusal;

  if (fields.keyPoints !== undefined || fields.needsDigest !== undefined) {
    const next = { ...task, ...fields };
    if (next.needsDigest !== true && pendingNotes(next).length > 0) {
      return `Task ${task.key || task.id}: the event would leave undigested notes with needsDigest cleared; only digest_key_points may clear the flag.`;
    }
  }

  return null;
}

function createRefusal(event) {
  const task = event.payload?.task;
  if (!task || typeof task !== 'object') return null;

  const noteRefusal = stampedNoteRefusal(new Set(), task.keyPoints, task);
  if (noteRefusal) return noteRefusal;

  if (task.needsDigest !== true && pendingNotes(task).length > 0) {
    return `Task ${task.key || task.id}: a task with undigested notes must carry needsDigest — only digest_key_points may clear the flag.`;
  }
  if (task.column === IN_PROGRESS_COLUMN_ID) return pendingNotesMessage(task);
  return null;
}

function refusedMessage(event) {
  if (event.type === 'task.moved') return moveRefusal(event);
  if (event.type === 'task.updated') return updateRefusal(event);
  if (event.type === 'task.created') return createRefusal(event);
  return null;
}

export function appendBridgeEvents(list) {
  const batch = Array.isArray(list) ? list : [list];
  for (const event of batch) {
    if (!event || typeof event !== 'object' || !event.id || !event.type) continue;
    const message = refusedMessage(event);
    if (message) throw new Error(message);
  }
  return appendEvents(batch);
}
