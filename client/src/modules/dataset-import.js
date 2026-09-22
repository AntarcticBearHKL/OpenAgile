import { generateUUID, nowIso } from './utils.js';
import { emit, DATA_CHANGED, EVENT_EMITTED } from './events.js';
import { openStore, persistEvent, EVENTS_STORE } from './idb-store.js';
import { emitLocalSync, observeRemote, compareHlc } from './event-sourcing/hlc.js';
import { normalizeBoardModelIds } from './board-serializer.js';
import { inspectImportPayload } from './import-payload.js';
import { setActiveBoardId } from './storage.js';
import { DATASET_FORMAT, DATASET_FORMAT_VERSION, computeDatasetChecksum } from './dataset-export.js';

const IMPORT_MODES = new Set(['merge', 'clone']);
const DEFAULT_ACTOR = { type: 'human', id: null };

const V1_LIMITATIONS = [
  'v1 payloads carry no board id: every import creates a new board and cannot update or deduplicate an existing one.',
  'v1 payloads carry no event history: HLC ordering, actors, event timestamps, tombstones, and unknown event types are lost.',
  'v1 payloads carry no global events (groups, board-to-group assignments, skills) and no snapshots.',
  'v1 payloads drop task fields the legacy reader does not know: priority, dueDate, labels, subTasks, attachments, customFields, annotations; acceptanceCriteria becomes keyPoints.'
];

function looksLikeDatasetBundle(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && ('format' in value || 'formatVersion' in value || Array.isArray(value.events));
}

function isSingleBoardPayload(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Array.isArray(value.columns) || Array.isArray(value.tasks));
}

async function verifyChecksum(bundle) {
  const { checksum } = bundle;
  if (checksum === undefined || checksum === null) return false;
  if (typeof checksum !== 'string' || !checksum.startsWith('sha256:')) {
    throw new Error('Dataset checksum is present but is not a "sha256:<hex>" value.');
  }
  const actual = await computeDatasetChecksum(bundle.events);
  if (actual !== checksum) {
    throw new Error('Dataset checksum mismatch — the bundle is corrupted or was modified. Nothing was imported.');
  }
  return true;
}

// Union by event id. External events are persisted as synced so the outbound
// queue never pushes them back; the projector folds each one synchronously.
async function mergeEvents(events) {
  const db = await openStore();
  const existing = await db.getAll(EVENTS_STORE);
  const seen = new Set(existing.map((event) => event.id));
  const sorted = [...events].sort((a, b) => compareHlc(a?.hlc || {}, b?.hlc || {}));

  let importedEvents = 0;
  let skippedEvents = 0;

  for (const event of sorted) {
    if (seen.has(event.id)) {
      skippedEvents += 1;
      continue;
    }
    if (event.hlc) await observeRemote(event.hlc);
    await persistEvent({ ...event, synced: true });
    emit(EVENT_EMITTED, event);
    seen.add(event.id);
    importedEvents += 1;
  }

  return { importedEvents, skippedEvents };
}

function buildGenesisEvent({ type, boardId, entityId, payload }) {
  return {
    id: generateUUID(),
    type,
    hlc: emitLocalSync(),
    at: new Date().toISOString(),
    actor: DEFAULT_ACTOR,
    scope: 'board',
    board_id: boardId,
    entity_id: entityId,
    payload
  };
}

function synthesizeGenesisEvents({ boardId, name, columns, tasks, settings }) {
  const events = [
    buildGenesisEvent({
      type: 'board.created',
      boardId,
      entityId: boardId,
      payload: { board: { id: boardId, name, createdAt: nowIso() } }
    })
  ];
  for (const column of columns) {
    events.push(buildGenesisEvent({ type: 'column.created', boardId, entityId: column.id, payload: { column } }));
  }
  for (const task of tasks) {
    events.push(buildGenesisEvent({ type: 'task.created', boardId, entityId: task.id, payload: { task } }));
  }
  if (settings && Object.keys(settings).length > 0) {
    events.push(buildGenesisEvent({ type: 'settings.updated', boardId, entityId: boardId, payload: { fields: settings } }));
  }
  return events;
}

function readV1Payload(payload) {
  const preview = inspectImportPayload(payload, null);
  if (preview.errors.length > 0) {
    throw new Error(`Invalid single-board payload: ${preview.errors.join(' ')}`);
  }
  return preview;
}

async function importV1Merge(payload) {
  const preview = readV1Payload(payload);
  const events = synthesizeGenesisEvents({
    boardId: generateUUID(),
    name: preview.importedName || 'Imported board',
    columns: preview.normalizedColumns || [],
    tasks: preview.normalizedTasks || [],
    settings: preview.normalizedSettings || null
  });
  const { importedEvents, skippedEvents } = await mergeEvents(events);

  return {
    mode: 'merge',
    source: 'v1',
    formatVersion: null,
    checksumVerified: false,
    importedEvents,
    skippedEvents,
    warnings: [...preview.warnings, ...V1_LIMITATIONS],
    limitations: V1_LIMITATIONS
  };
}

async function importV1Clone(payload) {
  const normalized = normalizeBoardModelIds({
    columns: payload.columns,
    tasks: payload.tasks,
    settings: payload.settings
  });
  const boardId = generateUUID();
  const name = typeof payload.boardName === 'string' && payload.boardName.trim()
    ? payload.boardName.trim()
    : 'Imported board';

  const events = synthesizeGenesisEvents({
    boardId,
    name,
    columns: normalized.columns,
    tasks: normalized.tasks,
    settings: normalized.settings
  });
  const { importedEvents, skippedEvents } = await mergeEvents(events);
  setActiveBoardId(boardId);
  emit(DATA_CHANGED, { event: 'dataset.clone', boardId });

  return {
    mode: 'clone',
    source: 'v1',
    formatVersion: null,
    checksumVerified: false,
    importedEvents,
    skippedEvents,
    boardId,
    warnings: [...V1_LIMITATIONS],
    limitations: V1_LIMITATIONS
  };
}

export async function importDataset(bundle, { mode = 'merge' } = {}) {
  if (!IMPORT_MODES.has(mode)) {
    throw new Error(`Unsupported import mode "${mode}". Use "merge" or "clone".`);
  }
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('Dataset import expects a JSON object.');
  }

  if (!looksLikeDatasetBundle(bundle)) {
    if (!isSingleBoardPayload(bundle)) {
      throw new Error('Unrecognized import payload: expected an "openagile.dataset" bundle or a single-board export.');
    }
    return mode === 'clone' ? importV1Clone(bundle) : importV1Merge(bundle);
  }

  if (bundle.format !== DATASET_FORMAT) {
    throw new Error(`Unsupported dataset format "${String(bundle.format)}". Expected "${DATASET_FORMAT}".`);
  }
  if (!Number.isFinite(bundle.formatVersion)) {
    throw new Error('Dataset formatVersion is missing or is not a number.');
  }
  if (!Array.isArray(bundle.events)) {
    throw new Error('Dataset bundle has no events array.');
  }
  for (const event of bundle.events) {
    if (!event || typeof event.id !== 'string' || !event.id) {
      throw new Error('Dataset contains an event without a string id.');
    }
  }
  if (mode === 'clone') {
    throw new Error('Clone mode only supports single-board payloads. Use merge mode to import a dataset bundle.');
  }

  const warnings = [];
  const checksumVerified = await verifyChecksum(bundle);
  if (!checksumVerified) {
    warnings.push('Dataset bundle has no checksum; integrity was not verified.');
  }
  if (bundle.formatVersion > DATASET_FORMAT_VERSION) {
    warnings.push(`Dataset formatVersion ${bundle.formatVersion} is newer than this app understands (${DATASET_FORMAT_VERSION}); unknown event types are preserved but not projected.`);
  }

  const { importedEvents, skippedEvents } = await mergeEvents(bundle.events);

  return {
    mode,
    source: 'dataset',
    formatVersion: bundle.formatVersion,
    checksumVerified,
    importedEvents,
    skippedEvents,
    warnings
  };
}
