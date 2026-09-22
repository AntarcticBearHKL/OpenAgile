// Bridge to the OpenAgile harness server (same origin, same port as the MCP
// endpoint). The browser stays local-first for instant UI; this module keeps it
// in step with the server's authoritative event log:
//
//   • server → browser : SSE /api/stream, applied through EVENT_EMITTED so the
//                        read-model projector + reducer update the board live.
//   • browser → server : local domain events are POSTed to /api/events (skipping
//                        events that came from the server, which prevents loops).
//
// Safe no-op when the app is served without the harness: the /api/harness probe
// fails and nothing connects.

import { apiUrl } from './app-config.js';
import { emit, on, EVENT_EMITTED } from './events.js';
import { NO_BOARDS_KEY } from './constants.js';
import { observeRemote } from './event-sourcing/hlc.js';
import { getActiveBoardId, hydrateFromSnapshotState } from './storage.js';
import { parseJsonSafely } from './utils.js';

const SEQ_KEY = 'openagile:harness:seq';
const CLIENT_KEY = 'openagile:harness:clientId';
const DEFAULT_BOARD_ID = '00000000-0000-4000-8000-000000000001';

const remoteIds = new Set();
const appliedLocal = new Set();
const buffered = [];

let started = false;
let active = false;
let source = null;
let queue = Promise.resolve();

let lastSeq = Number(localStorage.getItem(SEQ_KEY) || 0) || 0;
let clientId = localStorage.getItem(CLIENT_KEY);
if (!clientId) {
  clientId = crypto.randomUUID();
  try { localStorage.setItem(CLIENT_KEY, clientId); } catch { /* private mode */ }
}

function setSeq(next) {
  if (Number.isFinite(next) && next > lastSeq) {
    lastSeq = next;
    try { localStorage.setItem(SEQ_KEY, String(next)); } catch { /* ignore */ }
  }
}

const MAX_PENDING_FORWARDS = 500;
const FORWARD_RETRY_MS = 5000;
const pendingForwards = [];
let retryTimer = null;

function postEvent(event) {
  return fetch(apiUrl(`/api/events?clientId=${encodeURIComponent(clientId)}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    keepalive: true
  }).then((res) => {
    if (!res.ok) throw new Error(`harness responded ${res.status}`);
  });
}

function scheduleForwardRetry() {
  if (retryTimer || pendingForwards.length === 0) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushPendingForwards();
  }, FORWARD_RETRY_MS);
}

function flushPendingForwards() {
  if (pendingForwards.length === 0) return;
  const batch = pendingForwards.splice(0, pendingForwards.length);
  let failed = false;
  Promise.all(batch.map((event) => postEvent(event).catch(() => {
    failed = true;
    if (pendingForwards.length < MAX_PENDING_FORWARDS) pendingForwards.push(event);
  }))).then(() => { if (failed) scheduleForwardRetry(); });
}

function resetSeq() {
  lastSeq = 0;
  try { localStorage.removeItem(SEQ_KEY); } catch { /* ignore */ }
}

function forward(event) {
  postEvent(event).catch(() => {
    if (pendingForwards.length < MAX_PENDING_FORWARDS) pendingForwards.push(event);
    scheduleForwardRetry();
  });
}

// Registered at module load (before the app emits its first-run scaffold) so no
// local event is missed while the async probe/snapshot is in flight.
on(EVENT_EMITTED, (e) => {
  const event = e.detail;
  if (!event?.id || remoteIds.has(event.id)) return;
  if (!active) { buffered.push(event); return; }
  forward(event);
});

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function boot() {
  let info;
  try { info = await getJson(apiUrl('/api/harness')); } catch { return; }
  if (!info?.harness) return;

  try {
    if (Number.isFinite(info.boards) && info.boards === 0) localStorage.setItem(NO_BOARDS_KEY, '1');
    else localStorage.removeItem(NO_BOARDS_KEY);
  } catch { /* ignore */ }

  const activeBoardId = getActiveBoardId();
  const snapshotUrl = apiUrl(
    activeBoardId
      ? `/api/snapshot?boardId=${encodeURIComponent(activeBoardId)}`
      : '/api/snapshot'
  );

  // Snapshot first (idempotent hydration), then tail strictly after snapshot.seq
  // so there is no replay gap and no duplicate application. This avoids full-log
  // replay, which is unsafe for non-idempotent events.
  try {
    const snapshot = await getJson(snapshotUrl);
    if (Number.isFinite(snapshot?.seq)) {
      const serverHasBoard = Array.isArray(snapshot.state?.boards) && snapshot.state.boards.length > 0;
      const hydrateKey = activeBoardId || snapshot.boardId || DEFAULT_BOARD_ID;
      // A stored seq ahead of the server means the harness store was reset: new epoch.
      if (lastSeq > snapshot.seq) resetSeq();
      if (serverHasBoard && (lastSeq === 0 || snapshot.seq > lastSeq)) {
        hydrateFromSnapshotState(hydrateKey, snapshot.state);
      }
      setSeq(snapshot.seq);
    }
  } catch { /* snapshot unavailable — tail only */ }

  active = true;
  flushPendingForwards();
  for (const event of buffered) forward(event);
  buffered.length = 0;

  openStream();
}

function openStream() {
  if (source) return;
  try {
    source = new EventSource(apiUrl(`/api/stream?since=${lastSeq}&clientId=${encodeURIComponent(clientId)}`));
  } catch { return; }

  source.addEventListener('groups', (e) => {
    const payload = parseJsonSafely(e.data);
    if (payload === undefined) return;
    window.dispatchEvent(new CustomEvent('openagile:groups-changed', { detail: payload }));
  });

  source.addEventListener('skills', (e) => {
    const payload = parseJsonSafely(e.data);
    if (payload === undefined) return;
    window.dispatchEvent(new CustomEvent('openagile:skills-changed', { detail: payload }));
  });

  source.onmessage = (e) => {
    const event = parseJsonSafely(e.data);
    if (event === undefined) return;
    if (!event?.id) return;
    if (e.lastEventId) setSeq(Number(e.lastEventId));
    // Serialize application: observeRemote() is async, so concurrent handlers
    // could otherwise reorder events.
    queue = queue.then(() => ingest(event)).catch(() => {});
  };
}

async function ingest(event) {
  if (appliedLocal.has(event.id)) return;
  appliedLocal.add(event.id);
  remoteIds.add(event.id);
  try { if (event.hlc) await observeRemote(event.hlc); } catch { /* ignore */ }
  emit(EVENT_EMITTED, event);
}

export function initLocalServer() {
  if (started) return Promise.resolve();
  started = true;
  return boot().catch((err) => {
    console.warn('[openagile] local server bridge unavailable:', err?.message || err);
  });
}
