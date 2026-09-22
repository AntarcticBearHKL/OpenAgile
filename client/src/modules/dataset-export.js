import { openStore, EVENTS_STORE, SNAPSHOTS_STORE, KV_STORE } from './idb-store.js';
import { initHlc, compareHlc, HLC_NODE_KEY } from './event-sourcing/hlc.js';
import { listBoards, loadTasksForBoard } from './storage.js';

export const DATASET_FORMAT = 'openagile.dataset';
export const DATASET_FORMAT_VERSION = 2;
export const DATASET_PROTOCOL_VERSION = 1;

function getCurrentAppVersion() {
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim()) {
    return __APP_VERSION__.trim();
  }
  return 'unknown';
}

// Key order must be stable across machines so the checksum covers the same
// bytes no matter how an event object was constructed. Array order is kept.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJsonString(value) {
  return JSON.stringify(canonicalize(value));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeDatasetChecksum(events) {
  return `sha256:${await sha256Hex(canonicalJsonString(events))}`;
}

export async function exportDataset() {
  await initHlc();
  const db = await openStore();
  const nodeId = await db.get(KV_STORE, HLC_NODE_KEY);

  const events = (await db.getAll(EVENTS_STORE))
    .sort((a, b) => compareHlc(a?.hlc || {}, b?.hlc || {}));

  const snapshotKeys = await db.getAllKeys(SNAPSHOTS_STORE);
  const snapshotRecords = await db.getAll(SNAPSHOTS_STORE);
  const snapshots = {};
  snapshotKeys.forEach((key, index) => {
    snapshots[String(key)] = snapshotRecords[index];
  });

  const boards = listBoards().map((board) => ({ ...board }));
  const counts = {
    events: events.length,
    boards: boards.length,
    tasks: boards.reduce((total, board) => total + loadTasksForBoard(board.id).length, 0)
  };

  return {
    format: DATASET_FORMAT,
    formatVersion: DATASET_FORMAT_VERSION,
    protocolVersion: DATASET_PROTOCOL_VERSION,
    writtenBy: {
      nodeId: typeof nodeId === 'string' ? nodeId : null,
      appVersion: getCurrentAppVersion()
    },
    exportedAt: new Date().toISOString(),
    events,
    snapshots,
    boards,
    counts,
    checksum: await computeDatasetChecksum(events)
  };
}
