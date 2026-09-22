import { openStore, EVENTS_STORE, SNAPSHOTS_STORE } from '../idb-store.js';
import { createProjectionState } from '../reducer.js';
import { compareHlc } from './hlc.js';

export const SNAPSHOT_EVENT_THRESHOLD = 500;
export const SNAPSHOT_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_JITTER_MS = 60_000;
export const GLOBAL_SNAPSHOT_KEY = '__global__';

const _pendingSnapshots = new Map();
let _getJitter = () => Math.floor(Math.random() * (MAX_JITTER_MS + 1));

function eventMatchesSnapshotScope(key, event) {
  if (!event || typeof event !== 'object') return false;
  if (key === GLOBAL_SNAPSHOT_KEY) return event.scope === 'global';
  return (event.scope ?? 'board') === 'board' && event.board_id === key;
}

export function serializeState(state) {
  return {
    boards: Array.isArray(state.boards) ? state.boards : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    columns: Array.isArray(state.columns) ? state.columns : [],
    settings: state.settings && typeof state.settings === 'object' ? state.settings : {},
    appliedEventIds: [...(state.appliedEventIds instanceof Set ? state.appliedEventIds : [])],
    taskTombstones: [...(state.taskTombstones instanceof Set ? state.taskTombstones : [])]
  };
}

export async function saveSnapshot(key, state, hlc) {
  const db = await openStore();
  await db.put(SNAPSHOTS_STORE, {
    payload: serializeState(state),
    hlc,
    at: new Date().toISOString()
  }, key);
}

export async function loadSnapshot(key) {
  const db = await openStore();
  const record = await db.get(SNAPSHOTS_STORE, key);
  if (!record) return null;
  const { payload, hlc, at } = record;
  const state = createProjectionState({
    ...payload,
    appliedEventIds: new Set(Array.isArray(payload.appliedEventIds) ? payload.appliedEventIds : []),
    taskTombstones: new Set(Array.isArray(payload.taskTombstones) ? payload.taskTombstones : [])
  });
  return { state, hlc, at };
}

export async function gcEvents(key, snapshotHlc) {
  const db = await openStore();
  const all = await db.getAll(EVENTS_STORE);
  const tx = db.transaction(EVENTS_STORE, 'readwrite');
  for (const event of all) {
    if (eventMatchesSnapshotScope(key, event) && compareHlc(event.hlc, snapshotHlc) <= 0) tx.store.delete(event.id);
  }
  await tx.done;
}

async function shouldTakeSnapshot(key) {
  const db = await openStore();
  const snapshot = await loadSnapshot(key);
  const scopedEvents = (await db.getAll(EVENTS_STORE)).filter((event) => eventMatchesSnapshotScope(key, event));

  if (snapshot) {
    const age = Date.now() - new Date(snapshot.at).getTime();
    if (age >= SNAPSHOT_AGE_MS) return { should: true, reason: 'age' };
    const since = scopedEvents.filter(e => compareHlc(e.hlc, snapshot.hlc) > 0).length;
    if (since >= SNAPSHOT_EVENT_THRESHOLD) return { should: true, reason: 'count' };
    return { should: false };
  }

  if (scopedEvents.length >= SNAPSHOT_EVENT_THRESHOLD) return { should: true, reason: 'count' };
  return { should: false };
}

export function checkAndScheduleSnapshot(key, state, hlc) {
  const pending = _pendingSnapshots.get(key);
  if (pending) return pending.done;

  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const jitter = _getJitter();
  const id = setTimeout(async () => {
    _pendingSnapshots.delete(key);
    try {
      const { should } = await shouldTakeSnapshot(key);
      if (should) {
        await saveSnapshot(key, state, hlc);
        // Deletion by HLC is intentionally disabled: with multiple concurrent writers, deleting events <= snapshotHlc would drop events another writer has not read yet. GC is deferred to a future owner-truncates protocol.
      }
    } catch (err) {
      if (err?.code !== 11) console.error('[OpenAgile] Snapshot failed', err);
    } finally {
      finish();
    }
  }, jitter);
  _pendingSnapshots.set(key, { id, done });
  return done;
}

export function _resetSnapshotSchedulerForTesting() {
  for (const { id } of _pendingSnapshots.values()) clearTimeout(id);
  _pendingSnapshots.clear();
  _getJitter = () => Math.floor(Math.random() * (MAX_JITTER_MS + 1));
}

export function _setJitterForTesting(fn) {
  _getJitter = fn;
}
