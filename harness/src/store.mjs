// Server-side authoritative event log + read-model projection for the OpenAgile
// harness. It reuses the client's PURE reducer (client/src/modules/reducer.js)
// so the server and every browser project the identical domain events.
//
// Ordering authority: the server appends and assigns a monotonic `seq` in a
// single synchronous turn. SSE delivery follows seq order per connection, which
// is what the browser bridge relies on (live projection is per-event, so arrival
// order must equal commit order).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { applyEvent, createProjectionState } from '../../client/src/modules/reducer.js';
import { emitLocalSync, initHlc, observeRemote } from './hlc.mjs';
import { appendShard, ensureLayout, mergeShards, releaseLock, renameWithRetry, WRITER_ID_RE } from './shards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(HERE, '..');
const LEGACY_DATA_DIR = join(HARNESS_DIR, 'data');
// The launch scripts cd into harness/, but the project-local store belongs at the
// repository root, so a harness cwd is normalized one level up.
const LAUNCH_DIR = resolve(process.cwd()) === HARNESS_DIR ? resolve(HARNESS_DIR, '..') : resolve(process.cwd());
const DATA_DIR = process.env.OPENAGILE_DATA_DIR
  ? resolve(process.env.OPENAGILE_DATA_DIR)
  : join(LAUNCH_DIR, '.agileboard');
const STATE_FILE = join(DATA_DIR, 'state.json');
const EVENT_ARCHIVE_FILE = join(DATA_DIR, 'events-archive.ndjson');

// Same stable ids the browser seeds on first run, so both sides converge by id.
export const DEFAULT_BOARD_ID = '00000000-0000-4000-8000-000000000001';

export const STABLE_COLUMNS = [
  { id: '00000000-0000-4000-8000-000000000030', name: 'Backlog', color: '#3583ff', order: 1 },
  { id: '00000000-0000-4000-8000-000000000034', name: 'Human In The Loop', color: '#8b5cf6', order: 2 },
  { id: '00000000-0000-4000-8000-000000000031', name: 'In Progress', color: '#f59e0b', order: 3 },
  { id: '00000000-0000-4000-8000-000000000032', name: 'Blocked', color: '#ef4444', order: 4 },
  { id: '00000000-0000-4000-8000-000000000033', name: 'Finished', color: '#16a34a', order: 5, role: 'done' }
];

export const IN_PROGRESS_COLUMN_ID = STABLE_COLUMNS[2].id;
const BLOCKED_COLUMN_ID = STABLE_COLUMNS[3].id;
const BACKLOG_COLUMN_ID = STABLE_COLUMNS[0].id;
const HUMAN_IN_THE_LOOP_COLUMN_ID = STABLE_COLUMNS[1].id;

let meta = { nodeId: null, seq: 0 };
let events = [];
let groups = [];
let boardGroups = {};
let noBoards = false;
let skills = [];
let skillsSeeded = false;
let groupsSkillsEventSourced = false;
const seenIds = new Set();
const appliedIds = new Set();

let boards = [];
const tasksByBoard = new Map();
const columnsByBoard = new Map();
const settingsByBoard = new Map();

let persistTimer = null;
let writerId = null;
let heldLock = null;
let idempotency = {};
let taskKeyCounters = {};

const eventListeners = new Set();

const GROUP_FIELDS = ['name', 'order', 'collapsed', 'prefixCollapsed'];
const SKILL_FIELDS = ['name', 'description', 'content', 'order'];

function changedFields(previous, next, fields) {
  const changed = {};
  for (const field of fields) {
    if (next[field] !== previous[field]) changed[field] = next[field];
  }
  return changed;
}

function normalizeGroup(group, index) {
  return {
    id: typeof group?.id === 'string' && group.id ? group.id : randomUUID(),
    name: typeof group?.name === 'string' ? group.name : '',
    order: Number.isFinite(group?.order) ? group.order : index + 1,
    collapsed: group?.collapsed === true,
    prefixCollapsed: group?.prefixCollapsed === true
  };
}

function normalizeSkill(skill, index) {
  return {
    id: typeof skill?.id === 'string' && skill.id ? skill.id : randomUUID(),
    name: typeof skill?.name === 'string' ? skill.name : 'Untitled skill',
    description: typeof skill?.description === 'string' ? skill.description : '',
    content: typeof skill?.content === 'string' ? skill.content : '',
    order: Number.isFinite(skill?.order) ? skill.order : index + 1
  };
}

function emitGlobal(type, entityId, payload) {
  return emit(type, { entityId, payload, scope: 'global' });
}

// ── Projection (mirrors read-model-projector.js) ──────────────────────────────

function project(event) {
  if (!event?.id || appliedIds.has(event.id)) return;
  appliedIds.add(event.id);

  const scope = event.scope ?? 'board';
  if (scope === 'global') {
    const projected = applyEvent(createProjectionState({ groups, boardGroups, skills }), event);
    groups = projected.groups;
    boardGroups = projected.boardGroups;
    skills = projected.skills;
    return;
  }

  const boardId = event.board_id;
  if (typeof boardId !== 'string' || !boardId) return;

  if (event.type === 'task.created') {
    const issued = keyNumber(event.payload?.task?.key);
    if (issued > (Number.isFinite(taskKeyCounters[boardId]) ? taskKeyCounters[boardId] : 0)) {
      taskKeyCounters[boardId] = issued;
    }
  }

  const projected = applyEvent(createProjectionState({
    boards,
    tasks: tasksByBoard.get(boardId) || [],
    columns: columnsByBoard.get(boardId) || [],
    settings: settingsByBoard.get(boardId) || {}
  }), event);

  boards = projected.boards;
  tasksByBoard.set(boardId, projected.tasks);
  columnsByBoard.set(boardId, projected.columns);
  settingsByBoard.set(boardId, projected.settings);
}

function entityExists(type, entityId, boardId) {
  if (!entityId) return false;
  if (type === 'board.created') return boards.some((b) => b.id === entityId);
  if (type === 'column.created') return (columnsByBoard.get(boardId) || []).some((c) => c.id === entityId);
  if (type === 'task.created') return (tasksByBoard.get(boardId) || []).some((t) => t.id === entityId);
  if (type === 'group.created') return groups.some((g) => g.id === entityId);
  if (type === 'skill.created') return skills.some((s) => s.id === entityId);
  return false;
}

function notifyEventListeners(event) {
  for (const listener of eventListeners) {
    try { listener(event); } catch (err) { console.error('[OpenAgile] event listener failed', err); }
  }
}

// Append one already-built event. Idempotent: duplicate ids and duplicate
// *.created entities (browser scaffold vs server scaffold) are dropped.
function appendEvent(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.type) return null;
  if (seenIds.has(raw.id)) return null;
  if (raw.type.endsWith('.created') && entityExists(raw.type, raw.entity_id, raw.board_id)) return null;

  const nextSeq = meta.seq + 1;
  const event = { ...raw, seq: nextSeq };

  try {
    project(event);
  } catch (err) {
    console.error('[OpenAgile] Rejected an event that failed to project:', raw.type, err);
    return null;
  }

  if (raw.hlc) observeRemote(raw.hlc);
  meta.seq = nextSeq;
  events.push(event);
  seenIds.add(event.id);
  if (writerId) {
    try { appendShard(DATA_DIR, writerId, event); }
    catch (err) { console.error('[harness] shard append failed', err); }
  }
  notifyEventListeners(event);
  schedulePersist();
  if (events.length >= COMPACT_AFTER_EVENTS) compactEvents();
  return event;
}

export function appendEvents(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [list])) {
    const event = appendEvent(raw);
    if (event) out.push(event);
  }
  return out;
}

// Build + append a domain event authored by the server (MCP tools).
export function emit(type, {
  boardId = DEFAULT_BOARD_ID,
  entityId = '',
  payload = {},
  actor = { type: 'agent', id: 'openagile-harness' },
  scope = 'board'
} = {}) {
  const event = {
    id: randomUUID(),
    type,
    hlc: emitLocalSync(),
    at: new Date().toISOString(),
    actor,
    scope,
    board_id: scope === 'board' ? boardId : null,
    entity_id: entityId,
    payload
  };
  return appendEvent(event);
}

// ── Compaction ────────────────────────────────────────────────────────────────

// Highest seq already folded into the persisted read-model snapshot (0 = never
// compacted). Clients that are behind hydrate from /api/snapshot at boot and tail
// from snapshot.seq, so a trimmed range is never replayed.
let trimSeq = 0;
let archivedCount = 0;
const COMPACT_AFTER_EVENTS = 5000;

function snapshotReadModel() {
  return {
    seq: meta.seq,
    boards,
    tasksByBoard: [...tasksByBoard.entries()],
    columnsByBoard: [...columnsByBoard.entries()],
    settingsByBoard: [...settingsByBoard.entries()]
  };
}

function hydrateReadModel(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (Array.isArray(snapshot.boards)) boards = snapshot.boards;
  const restore = (map, entries) => {
    map.clear();
    for (const [key, value] of Array.isArray(entries) ? entries : []) map.set(key, value);
  };
  restore(tasksByBoard, snapshot.tasksByBoard);
  restore(columnsByBoard, snapshot.columnsByBoard);
  restore(settingsByBoard, snapshot.settingsByBoard);
  return true;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function persistNow() {
  const payload = JSON.stringify({
    nodeId: meta.nodeId,
    seq: meta.seq,
    trimSeq,
    archivedCount,
    idempotency,
    taskKeyCounters,
    snapshot: trimSeq > 0 ? snapshotReadModel() : null,
    events,
    groups,
    boardGroups,
    noBoards,
    skills,
    skillsSeeded,
    groupsSkillsEventSourced
  });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, payload);
  renameWithRetry(tmp, STATE_FILE);
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { persistNow(); } catch (err) { console.error('[harness] persist failed', err); }
  }, 200);
}

export function flushStore() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try { persistNow(); } catch { /* ignore */ }
  releaseHeldLock();
}

function releaseHeldLock() {
  if (!heldLock) return;
  releaseLock(DATA_DIR, heldLock);
  heldLock = null;
}

process.on('exit', releaseHeldLock);

// Archiving is best-effort: a failed write must never stop compaction.
function archiveEvents(list) {
  try {
    appendFileSync(EVENT_ARCHIVE_FILE, `${list.map((event) => JSON.stringify(event)).join('\n')}\n`);
  } catch (err) {
    console.error('[harness] event archive append failed', err);
  }
}

// Fold the whole log into a read-model snapshot and drop it. `getStats().trimSeq`
// reports the floor. Note this forgets event ids: a client that re-posts an event
// from before the floor after a restart is no longer rejected by id (the
// *.created dedupe still applies).
export function compactEvents() {
  if (events.length === 0) return { compacted: false, seq: meta.seq, trimSeq, archived: archivedCount };
  archiveEvents(events);
  archivedCount += events.length;
  trimSeq = meta.seq;
  events = [];
  schedulePersist();
  return { compacted: true, seq: meta.seq, trimSeq, archived: archivedCount };
}

export function getArchiveInfo() {
  return { archivePath: archivedCount > 0 ? EVENT_ARCHIVE_FILE : null, archivedCount };
}

// ── Seed ──────────────────────────────────────────────────────────────────────

function seedDefaultBoardIfEmpty() {
  if (boards.length > 0 || noBoards) return;
  const now = new Date().toISOString();
  appendEvent({
    id: randomUUID(), type: 'board.created', hlc: emitLocalSync(), at: now,
    actor: { type: 'agent', id: 'openagile-harness' }, scope: 'board',
    board_id: DEFAULT_BOARD_ID, entity_id: DEFAULT_BOARD_ID,
    payload: { board: { id: DEFAULT_BOARD_ID, name: 'Default Board', createdAt: now } }
  });
  for (const column of STABLE_COLUMNS) {
    appendEvent({
      id: randomUUID(), type: 'column.created', hlc: emitLocalSync(), at: now,
      actor: { type: 'agent', id: 'openagile-harness' }, scope: 'board',
      board_id: DEFAULT_BOARD_ID, entity_id: column.id,
      payload: { column: { ...column } }
    });
  }
}

// Sidecars written before groups/skills were event-sourced are folded into the
// log once, so the event-derived projection keeps every entity the state file held.
function migrateSidecarGlobalState(sidecarGroups, sidecarBoardGroups, sidecarSkills) {
  if (groupsSkillsEventSourced) return;

  (Array.isArray(sidecarGroups) ? sidecarGroups : [])
    .filter((group) => group?.deleted !== true)
    .forEach((group, index) => {
      const normalized = normalizeGroup(group, index);
      if (groups.some((entry) => entry.id === normalized.id)) return;
      emitGlobal('group.created', normalized.id, { group: normalized });
    });

  (Array.isArray(sidecarSkills) ? sidecarSkills : [])
    .filter((skill) => skill?.deleted !== true)
    .forEach((skill, index) => {
      const normalized = normalizeSkill(skill, index);
      if (skills.some((entry) => entry.id === normalized.id)) return;
      emitGlobal('skill.created', normalized.id, { skill: normalized });
    });

  const map = sidecarBoardGroups && typeof sidecarBoardGroups === 'object' ? sidecarBoardGroups : {};
  for (const boardId of Object.keys(map).sort()) {
    if (Object.prototype.hasOwnProperty.call(boardGroups, boardId)) continue;
    const groupId = map[boardId];
    emitGlobal('board.group.assigned', boardId, { group_id: typeof groupId === 'string' ? groupId : null });
  }

  groupsSkillsEventSourced = true;
}

// One-time, copy-only migration from the pre-.agileboard location. The source is
// never moved, deleted or rewritten.
function migrateLegacyState() {
  if (process.env.OPENAGILE_DATA_DIR) return;
  if (existsSync(STATE_FILE)) return;
  const legacyState = join(LEGACY_DATA_DIR, 'state.json');
  if (!existsSync(legacyState)) return;

  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, readFileSync(legacyState));
  renameWithRetry(tmp, STATE_FILE);
  console.log(`[harness] migrated legacy state into ${STATE_FILE}`);

  let entries = [];
  try { entries = readdirSync(LEGACY_DATA_DIR); } catch { entries = []; }
  for (const name of entries) {
    if (!/^state\.backup-.*\.json$/.test(name)) continue;
    const destination = join(DATA_DIR, name);
    if (existsSync(destination)) continue;
    try {
      const backupTmp = `${destination}.tmp`;
      writeFileSync(backupTmp, readFileSync(join(LEGACY_DATA_DIR, name)));
      renameWithRetry(backupTmp, destination);
    } catch (err) {
      console.warn('[harness] legacy backup not copied', name, err?.message);
    }
  }
}

export function initStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyState();
  heldLock = ensureLayout(DATA_DIR).lock;

  // Replay persisted events in commit (seq) order to rebuild the read model.
  let loadedEvents = [];
  let loadedSnapshot = null;
  let sidecarGroups = null;
  let sidecarBoardGroups = null;
  let sidecarSkills = null;
  if (existsSync(STATE_FILE)) {
    try {
      const loaded = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
      meta = {
        nodeId: typeof loaded?.nodeId === 'string' ? loaded.nodeId : null,
        seq: Number.isFinite(loaded?.seq) ? loaded.seq : 0
      };
      if (Array.isArray(loaded?.events)) loadedEvents = loaded.events;
      if (Array.isArray(loaded?.groups)) sidecarGroups = loaded.groups;
      if (loaded?.boardGroups && typeof loaded.boardGroups === 'object') sidecarBoardGroups = loaded.boardGroups;
      if (loaded?.noBoards === true) noBoards = true;
      if (Array.isArray(loaded?.skills)) sidecarSkills = loaded.skills;
      if (loaded?.skillsSeeded === true) skillsSeeded = true;
      if (loaded?.groupsSkillsEventSourced === true) groupsSkillsEventSourced = true;
      if (Number.isFinite(loaded?.trimSeq)) trimSeq = loaded.trimSeq;
      if (Number.isFinite(loaded?.archivedCount)) archivedCount = loaded.archivedCount;
      if (loaded?.idempotency && typeof loaded.idempotency === 'object' && !Array.isArray(loaded.idempotency)) idempotency = loaded.idempotency;
      if (loaded?.taskKeyCounters && typeof loaded.taskKeyCounters === 'object' && !Array.isArray(loaded.taskKeyCounters)) taskKeyCounters = loaded.taskKeyCounters;
      if (loaded?.snapshot && typeof loaded.snapshot === "object") loadedSnapshot = loaded.snapshot;
    } catch (err) {
      console.error('[harness] state file unreadable, starting fresh', err?.message);
      meta = { nodeId: null, seq: 0 };
      sidecarGroups = null;
      sidecarBoardGroups = null;
      sidecarSkills = null;
      noBoards = false;
      skillsSeeded = false;
      groupsSkillsEventSourced = false;
    }
  }
  if (!meta.nodeId) meta.nodeId = randomUUID();
  initHlc(meta.nodeId);
  const candidateWriterId = `mcp-${meta.nodeId}`;
  if (WRITER_ID_RE.test(candidateWriterId)) {
    writerId = candidateWriterId;
  } else {
    writerId = `mcp-${randomUUID()}`;
    console.warn('[harness] nodeId is not a legal writer id; using', writerId);
  }

  // Before the one-time migration the global projection is rebuilt from the log
  // alone, so a sidecar entity genuinely lacks an event and the emitted *.created
  // is not dropped by the appendEvent entity dedupe.
  if (groupsSkillsEventSourced) {
    if (Array.isArray(sidecarGroups)) groups = sidecarGroups;
    if (sidecarBoardGroups && typeof sidecarBoardGroups === 'object') boardGroups = sidecarBoardGroups;
    if (Array.isArray(sidecarSkills)) skills = sidecarSkills;
  } else {
    groups = [];
    boardGroups = {};
    skills = [];
  }

  // A persisted snapshot already contains every event at or below its seq, so
  // those are not replayed (the log holds only what came after it).
  const snapshotSeq = hydrateReadModel(loadedSnapshot) && Number.isFinite(loadedSnapshot.seq) ? loadedSnapshot.seq : 0;

  for (const event of loadedEvents) {
    if (!event?.id || seenIds.has(event.id)) continue;
    if (Number.isFinite(event.seq) && event.seq <= snapshotSeq) { seenIds.add(event.id); continue; }
    if (!Number.isFinite(event.seq)) event.seq = ++meta.seq;
    else meta.seq = Math.max(meta.seq, event.seq);
    if (event.hlc) observeRemote(event.hlc);
    events.push(event);
    seenIds.add(event.id);
    project(event);
  }

  mergeShards(DATA_DIR, appendEvent);
  migrateSidecarGlobalState(sidecarGroups, sidecarBoardGroups, sidecarSkills);
  seedDefaultBoardIfEmpty();
  seedDefaultSkillsIfEmpty();
  schedulePersist();

  return { boardId: DEFAULT_BOARD_ID, seq: meta.seq, events: events.length };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

function liveGroupIds() {
  return new Set(groups.filter((group) => group && group.deleted !== true).map((group) => group.id));
}

export function getBoards() {
  const liveGroups = liveGroupIds();
  return boards
    .filter((b) => !b.deleted)
    .map((b) => ({ id: b.id, name: b.name, createdAt: b.createdAt, groupId: liveGroups.has(boardGroups[b.id]) ? boardGroups[b.id] : '' }));
}

export function getBoard(boardId) {
  return boards.find((b) => b.id === boardId && !b.deleted) || null;
}

export function getColumns(boardId) {
  const stored = new Map(
    (columnsByBoard.get(boardId) || [])
      .filter((column) => !column.deleted && typeof column.id === 'string')
      .map((column) => [column.id, column])
  );

  return STABLE_COLUMNS.map((template) => {
    const previous = stored.get(template.id) || {};
    return {
      ...template,
      color: typeof previous.color === 'string' && previous.color ? previous.color : template.color,
      collapsed: previous.collapsed === true,
      wipLimit: Number.isFinite(previous.wipLimit) ? previous.wipLimit : 0
    };
  });
}

export function getTasks(boardId) {
  return (tasksByBoard.get(boardId) || []).filter((t) => !t.deleted);
}

function keyNumber(key) {
  const match = /-(\d+)$/.exec(typeof key === 'string' ? key : '');
  return match ? Number(match[1]) : 0;
}

// A deleted task is hard-removed from the read model, so the highest number ever
// issued cannot be recovered from the tasks themselves; the counter is persisted.
export function reserveTaskKeyNumber(boardId, floor = 0) {
  const issued = Number.isFinite(taskKeyCounters[boardId]) ? taskKeyCounters[boardId] : 0;
  const next = Math.max(issued, Number.isFinite(floor) ? floor : 0) + 1;
  taskKeyCounters[boardId] = next;
  schedulePersist();
  return next;
}

export function getSettings(boardId) {
  return settingsByBoard.get(boardId) || {};
}

export function findTask(taskId) {
  for (const [boardId, list] of tasksByBoard) {
    const task = (list || []).find((t) => t.id === taskId && !t.deleted);
    if (task) return { task, boardId };
  }
  return null;
}

function buildBoardOrder(boardId, taskId, targetColumnId) {
  const byColumn = new Map();
  for (const task of tasksByBoard.get(boardId) || []) {
    if (task.deleted) continue;
    const column = task.id === taskId ? targetColumnId : task.column;
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column).push({ ...task, column });
  }
  const order = [];
  for (const [columnId, list] of byColumn) {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    list.forEach((task, index) => order.push({ id: task.id, column: columnId, order: index + 1 }));
  }
  return order;
}

const CLAIM_STALE_MS = 5 * 60 * 1000;
const CLAIM_STALE_REASON = 'Auto-blocked: no agent sync for over 5 minutes.';

// task.moved is structural and never writes changeDate, so activity is the later of
// changeDate and the moment the task entered the column it sits in (last history entry).
function lastActivityAt(task) {
  let latest = Date.parse(task.changeDate);
  const history = Array.isArray(task.columnHistory) ? task.columnHistory : [];
  const entered = history[history.length - 1];
  if (entered && entered.column === task.column) {
    const enteredAt = Date.parse(entered.at);
    if (Number.isFinite(enteredAt)) latest = Number.isFinite(latest) ? Math.max(latest, enteredAt) : enteredAt;
  }
  return latest;
}

export function isClaimExpired(task, now = Date.now()) {
  if (!task || !task.claimedBy) return false;
  const activity = lastActivityAt(task);
  if (!Number.isFinite(activity)) return true;
  return now - activity > CLAIM_STALE_MS;
}

export function isReadyTask(task, now = Date.now()) {
  if (!task || task.deleted) return false;
  if (task.column !== BACKLOG_COLUMN_ID && task.column !== HUMAN_IN_THE_LOOP_COLUMN_ID) return false;
  if (pendingNotesMessage(task)) return false;
  if (task.claimedBy && !isClaimExpired(task, now)) return false;
  return true;
}

const READY_COLUMN_RANK = new Map([[BACKLOG_COLUMN_ID, 0], [HUMAN_IN_THE_LOOP_COLUMN_ID, 1]]);

export function nextReadyTask(boardId, now = Date.now()) {
  return getTasks(boardId)
    .filter((task) => isReadyTask(task, now))
    .sort((a, b) => (READY_COLUMN_RANK.get(a.column) - READY_COLUMN_RANK.get(b.column))
      || ((a.order ?? 0) - (b.order ?? 0))
      || String(a.id).localeCompare(String(b.id)))[0] || null;
}

export function isLastBoardInGroup(boardId) {
  const board = getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  const groupId = boardGroups[boardId] || '';
  const siblings = getBoards().filter((entry) => (entry.groupId || '') === groupId);
  return siblings.length === 0 || siblings[siblings.length - 1].id === boardId;
}

// Stale claims move with two events, exactly like a client drag: task.moved plus the blocked task.updated.
export function sweepStaleClaims(now = Date.now()) {
  const stale = [];
  for (const [boardId, tasks] of tasksByBoard) {
    for (const task of tasks) {
      if (task.deleted || task.column !== IN_PROGRESS_COLUMN_ID) continue;
      if (!task.claimedBy && !task.claimedAt) continue;
      const changedAt = lastActivityAt(task);
      if (Number.isFinite(changedAt) && now - changedAt > CLAIM_STALE_MS) stale.push({ boardId, taskId: task.id });
    }
  }

  const moved = [];
  for (const { boardId, taskId } of stale) {
    const task = (tasksByBoard.get(boardId) || []).find((entry) => entry.id === taskId && !entry.deleted && entry.column === IN_PROGRESS_COLUMN_ID);
    if (!task) continue;
    const order = buildBoardOrder(boardId, taskId, BLOCKED_COLUMN_ID);
    emit('task.moved', { boardId, entityId: taskId, payload: { order } });
    const at = new Date(now).toISOString();
    const fields = { blockedAt: at, changeDate: at };
    if (!task.blockedReason) fields.blockedReason = CLAIM_STALE_REASON;
    emit('task.updated', {
      boardId,
      entityId: taskId,
      payload: { fields }
    });
    console.log(`[harness] auto-blocked ${task.key || taskId} (no sync for 5 minutes)`);
    moved.push(taskId);
  }
  return moved;
}

// Digest gate shared by the MCP tools and the browser bridge: both paths must
// refuse the same states, so the predicate and its message live here.
export function pendingNotes(task) {
  return (Array.isArray(task?.keyPoints) ? task.keyPoints : []).filter((point) => !point?.digestedAt);
}

export function pendingNotesMessage(task) {
  if (task?.needsDigest !== true && pendingNotes(task).length === 0) return null;
  return `Task ${task.key || task.id} still has notes from the human that the agent has not digested; run digest_key_points first to fold them into the description before starting.`;
}

export function digestKeyPoints(taskId, pointIds) {
  const found = findTask(taskId);
  if (!found) throw new Error(`Task not found: ${taskId}`);
  const { task, boardId } = found;
  const keyPoints = Array.isArray(task.keyPoints) ? task.keyPoints : [];
  const selected = Array.isArray(pointIds) && pointIds.length > 0 ? new Set(pointIds) : null;
  const now = new Date().toISOString();
  const digested = [];
  const next = keyPoints.map((point) => {
    const target = selected ? selected.has(point.id) : !point.digestedAt;
    if (!target) return point;
    digested.push(point.id);
    return { ...point, digestedAt: now };
  });
  const fields = { keyPoints: next, needsDigest: false, changeDate: now };
  if (task.isRework === true) fields.isRework = false;
  emit('task.updated', {
    boardId,
    entityId: taskId,
    payload: { fields }
  });
  return { taskId, digested };
}

export function getSeq() {
  return meta.seq;
}

// Storage only: the tool layer owns the create/dedupe decision.
export function lookupIdempotency(key) {
  if (typeof key !== 'string' || !key) return null;
  const entry = idempotency[key];
  if (!entry || typeof entry !== 'object') return null;
  return { taskId: entry.taskId, boardId: entry.boardId, at: entry.at };
}

export function recordIdempotency(key, taskId, boardId) {
  if (typeof key !== 'string' || !key) return;
  idempotency[key] = { taskId, boardId, at: new Date().toISOString() };
  schedulePersist();
}

export const MAX_WAIT_MS = 30_000;

export function subscribeEvents(listener) {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

export function getEventListenerCount() {
  return eventListeners.size;
}

export function waitForEvent({ since = 0, timeoutMs = MAX_WAIT_MS, type = '', boardId = '' } = {}) {
  const after = Number.isFinite(since) ? since : 0;
  const matches = (event) => (event.seq ?? 0) > after
    && (!type || event.type === type)
    && (!boardId || event.board_id === boardId);
  const existing = events.find(matches);
  if (existing) return Promise.resolve(existing);

  const bounded = Math.max(1, Math.min(MAX_WAIT_MS, Number.isFinite(timeoutMs) ? timeoutMs : MAX_WAIT_MS));
  return new Promise((resolveWait) => {
    let settled = false;
    let timer = null;
    let unsubscribe = null;
    const finish = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      resolveWait(event);
    };
    timer = setTimeout(() => finish(null), bounded);
    timer.unref();
    unsubscribe = subscribeEvents((event) => { if (matches(event)) finish(event); });
  });
}

export function getEventsSince(since) {
  return events.filter((e) => (e.seq ?? 0) > since);
}

export function getSnapshot(boardId = DEFAULT_BOARD_ID) {
  return {
    seq: meta.seq,
    boardId,
    state: {
      boards,
      tasks: tasksByBoard.get(boardId) || [],
      columns: getColumns(boardId),
      settings: settingsByBoard.get(boardId) || {}
    }
  };
}

export function getStats() {
  return {
    boards: getBoards().length,
    events: events.length,
    seq: meta.seq,
    trimSeq,
    nodeId: meta.nodeId
  };
}

export function resolveGroup(groupId = '') {
  const groups = getGroups();
  const target = groupId ? groups.find((entry) => entry.id === groupId) : groups[groups.length - 1];
  if (!target) {
    throw new Error(groupId
      ? `Group not found: ${groupId}`
      : 'No groups exist; create a group first: every iteration belongs to a group');
  }
  return target;
}

export function createBoard({ groupId = '' } = {}) {
  const group = resolveGroup(groupId);
  const highest = getBoards()
    .filter((board) => board.groupId === group.id)
    .reduce((max, board) => {
      const match = /^Iteration (\d+)$/.exec(board.name);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
  const position = highest + 1;
  const boardId = randomUUID();
  const board = { id: boardId, name: `Iteration ${position}`, createdAt: new Date().toISOString() };
  emit('board.created', { boardId, entityId: boardId, payload: { board } });
  emitGlobal('board.group.assigned', boardId, { group_id: group.id });
  noBoards = false;
  schedulePersist();
  return { ...board, groupId: group.id };
}

export function deleteBoard(boardId) {
  if (!getBoard(boardId)) throw new Error(`Board not found: ${boardId}`);
  emit('board.deleted', { boardId, entityId: boardId, payload: {} });
  if (getBoardGroupMap()[boardId]) emitGlobal('board.group.assigned', boardId, { group_id: null });
  if (getBoards().length === 0) noBoards = true;
  schedulePersist();
  return { deleted: boardId };
}

export const DEFAULT_SKILLS = [
  {
    name: '人与 subagent 的协作工作方式',
    description: '人与 AI subagent 在这块看板上如何分工与交接。',
    content: [
      '这块看板是「人 + 多个 AI subagent」共享的唯一事实来源。任务主要由 AI 填写与搬动，人负责看、定方向、下指令。',
      '',
      '【职责分工——谁写什么】',
      '- 描述（description）是 agent 的：立项时由 agent 写，之后由 agent 维护，也是 agent 的回复面。',
      '- 给 agent 的备注（notes to the agent，数据字段 keyPoints）是人的：人一次加一条，agent 只读，不得增删改。',
      '- 任务对话框里只有标题、描述和给 agent 的备注这三样；人写备注，agent 把备注折进描述。',
      '',
      '【人的职责】',
      '- 随时点开任务：看清它要干什么（描述、给 agent 的备注）。',
      '- 用「给 agent 的备注」写下想法、决定和要 agent 做的事。',
      '- 加备注：除 In Progress 外都能加（Backlog、Human In The Loop、Blocked、Finished）；In Progress 整份表单只读。',
      '- 非 Human In The Loop 的任务，标题和描述都是 agent 的，人只改备注；Human In The Loop 里人可以改全部。',
      '- 人只在 Human In The Loop 列手工建任务；其他列的任务由 agent 或流程产生。',
      '',
      '【AI / subagent 的职责】',
      '- 动手前先读：get_task（含给 agent 的备注）、list_tasks、list_skills。',
      '- 认领：claim_task 写明是哪个 subagent 在做；已被别人认领且认领未过期时会被拒绝；认领超过 5 分钟没有活动即过期，过期后才能接管（结果里会写 tookOver）。做完或中断时 release_task；任务还有未消化的备注时 claim_task 会被拒绝。',
      '- 描述由 agent 维护；人的备注不得删改，只能折进描述后标记已消化。',
      '- 开工前必须先消化：把备注折进描述，再用 digest_key_points 清掉 needsDigest；没消化就 claim_task、或把任务移进 In Progress，都会被拒绝。',
      '- 卡住时移到 Blocked 并写 set_blocked_reason。',
      '- 等变化不要轮询 list_events：用 wait_for_event（带上你已经见过的 seq，可加 type / boardId 过滤）；等人的备注或等同波任务收尾都靠它。',
      '',
      '【任务字段（当前模型）】',
      '- 创建任务只需要标题和描述；没有优先级、没有截止日期、没有标签、没有子任务。',
      '- 给 agent 的备注（keyPoints）= 人写的一条条要求；描述（description）= agent 维护的完整说明。',
      '',
      '【五列的语义（固定，不可增删）】',
      '- Backlog：已立项、待认领。人在这里读需求、加备注。',
      '- Human In The Loop：人手工建任务的地方；新任务从这里出发。',
      '- In Progress：已被某个 subagent 认领并在处理中 → 任务表单完全锁定（只读）。',
      '- Blocked：卡住了，必须写原因；连续两次日报仍卡住就升级。',
      '- Finished：已完成，是完成情况的统计来源。',
      '',
      '【交接约定】',
      '- 同一时刻一个任务只应被一个 subagent 认领；已被别人认领（且认领未过期）的任务不要动，认领过期后才允许接管。',
      '- 交接前把进展写进描述，让人不用逐个点开也知道发生了什么。',
      '- 人加了备注后，agent 应把它当成新的输入，折进描述，再用 digest_key_points 标记已消化；备注未消化前不能开工，claim_task 会被拒绝。'
    ].join('\n')
  },
  {
    name: '如何与 AI agent 一起运转这块看板',
    description: '人与 agent 之间的分工约定。',
    content: [
      '这块看板是人（human）与 AI agent 之间共享的状态。',
      '',
      '人负责：工作方向、给 agent 的备注（keyPoints），以及最终「算不算完成」的拍板。',
      'agent 负责：动手前先通过 MCP 读看板；写并维护描述（description）；认领任务；把人的备注折进描述；',
      '记录卡住的原因；用证据汇报进展。',
      '',
      '协作规则：',
      '- 看板上没有的工作不要凭空开做：先用 create_task 建任务，再做。建任务只需要标题和描述——',
      '  没有优先级、没有截止日期、没有标签、没有子任务。',
      '- 一波任务用 create_tasks 一次建完：{boardId, tasks:[{title, description?}]}，全部落在 Backlog；整批先校验后写入，一条不合法就整批拒绝，绝不部分生效。',
      '- 描述是 agent 的，备注是人的：agent 不得增删改 keyPoints，只能读。',
      '- 动手前先消化：任务带 needsDigest 时，先把新备注折进描述，再用 digest_key_points 标记已消化；没消化就 claim_task、或把任务移进 In Progress，都会被拒绝。',
      '- 只有真的动了才移动任务：开始做时移到 In Progress，做不下去时移到 Blocked 并写原因，',
      '  主工作完成后才移到 Finished。',
      '- 人只通过 Human In The Loop 列手工建任务；Backlog 与其余列由 agent 与流程驱动。',
      '- 与其建一个大任务，不如拆成能一次做完的小任务。',
      '- 人写在「给 agent 的备注」里的指示必须回应：把它折进描述，不要让人的话悬着。',
      '- 评审者需要知道的任何事，都写进任务的描述（description）。',
      '',
      '【计时提醒】任务从 claim_task 那一刻开始计时，任何更新都会重置 5 分钟窗口；只想续命、不改任何内容时用 heartbeat_task（只写 changeDate），把任务移进 In Progress 也会重新开始窗口；细则见「认领工作」。'
    ].join('\n')
  },
  {
    name: '任务拆分与备注',
    description: '如何把工作切到能一次做完的程度。',
    content: [
      '一个任务只需要标题和描述就能创建；没有优先级、没有截止日期、没有标签、没有子任务。',
      '',
      '给 agent 的备注（keyPoints）是人的输入，不是勾选清单：人一次加一条，agent 只读，不得增删改。',
      '描述（description）是 agent 的：动手前先把任务上的备注折进描述，再用 digest_key_points 标记已消化。',
      '只有 needsDigest 清掉之后，才算真正准备好开工；带未消化备注就 claim_task 会被直接拒绝。',
      '',
      '拆分规则：',
      '- 一个任务 = 一个结果，一天内可交付。',
      '- 按结果切，不要按阶段或文档切。',
      '- 一个任务一天内做不完，就继续拆成多个任务。',
      '- 需要交代的背景和步骤，都写进描述，由 agent 维护。',
    ].join('\n')
  },
  {
    name: '迭代规划',
    description: '如何用 group／迭代组织工作。',
    content: [
      'group 是人命名的容器，可以改名（人在界面上改名，agent 用 rename_group），里面装着一个或多个迭代。',
      '迭代（iteration）是 group 里的一块看板，按顺序编号（Iteration 1、Iteration 2……），不能手工命名。',
      '一块看板永远属于某个 group，不会独立存在。',
      'group 开头连续若干个「任务全部在 Finished」的迭代，可以用一个控件折叠起来。',
      '',
      '规划流程：',
      '- 开始前先设好迭代日期（startDate/endDate）和一句话目标。',
      '- 只把近期做得了的工作拉进迭代，其余留在 Backlog。',
      '- 让五列保持如实：Backlog、Human In The Loop、In Progress、Blocked、Finished。',
      '- 人只在 Human In The Loop 列手工建任务；Backlog 是 agent 立项的队列。',
      '',
      '读懂数字：',
      '- 每个迭代的起止日期和 Finished 列一起，说明这一轮做完了什么。',
      '',
      '【迭代 = 一波工作（wave）】',
      '- 同一波、可以同时进行的工作放进同一个迭代；必须等前一波做完才能开始的工作，放进下一个迭代（create_board 新建）。',
      '- 一波任务用 create_tasks 一次建完（全部落 Backlog）；整批换列用 move_tasks。',
      '- 一个迭代里的工作全部完成之前，不开始下一个迭代里的工作：先收掉当前这一波，再开新的。',
      '- 这是给 agent 的协作约定，不是硬性闸门：工具不会因为你认领了后面迭代的任务而拒绝，但请自觉按波次推进。',
      '- list_roadmap 会给出每个迭代还有多少没完成（unfinishedTasks），并标出当前的活动迭代（isActive：按 group 顺序第一个没有全部完成的迭代）。',
    ].join('\n')
  },
  {
    name: '认领工作',
    description: 'subagent 的归属规则。',
    content: [
      '这块看板是 subagent 级别的协作工具：subagent 认领任务、推进、然后交回。',
      '',
      '认领：',
      '- 动手前先认领（claim_task 填上你的 agent 名），让人看得见任务归谁；任务还有未消化的备注时认领会被拒绝。',
      '- 停下时释放（release_task），即使任务还没做完。',
      '- 不要做没人认领的任务；已被别人认领的就别碰——除非那份认领已经过期（见下）。',
      '',
      '【认领是硬锁，过期才可接管】',
      '- 认领是硬锁：任务已被别的 subagent 认领、且认领还新鲜时，claim_task 会被拒绝，并在错误里点名持有人。',
      '- 同一 agent 再次认领自己的任务是续期：刷新认领时间和 changeDate，不是冲突。',
      '- 最后一次活动超过 5 分钟，认领即过期；list_tasks / get_task 会返回 claimedBy、claimedAt、changeDate、blockedReason 和 claimExpired，谁持有、持有多久、是否安静一眼可见。',
      '- 看门狗不会替你清掉认领：它只把仍然卡住的 In Progress 任务移进 Blocked 并记录原因；认领是否过期由时间判定，是否接管由 agent 决定。',
      '- 认领过期后可以接管：claim_task 会成功并在结果里说明 tookOver: true；仍然 live 的认领永远不能抢。',
      '- 不知道从哪个任务开始时用 claim_next：它原子地认领下一个 ready 任务。ready = 在 Backlog 或 Human In The Loop、备注已消化、且无人认领或认领已过期；顺序固定为 Backlog 先于 Human In The Loop，再按任务 order，最后按任务 id。',
      '',
      '【计时约定】',
      '- 认领那一刻就开始计时：claim_task 会写入认领时间戳；看门狗按它判断你是否还在线。',
      '- 如果预计还要超过约 5 分钟才能做完，agent 必须在到点前同步一次：任务上的任何更新都算同步',
      '  （改描述、digest_key_points 或重新认领），并重新开始 5 分钟窗口。',
      '- 只想续命、不想动任何内容时，用 heartbeat_task：它只写 changeDate，不动描述、备注、消化标记和列；',
      '  只有「已认领且在 In Progress」的任务能用，其他状态会被拒绝。',
      '- 把任务移进 In Progress 同样算一次活动：窗口从进列那一刻重新开始，刚开工的任务不会被误判为卡住。',
      '- 如果大约 5 分钟内没有任何同步，服务端会把任务移到 Blocked、记录原因，计时随即停止；它不会清掉认领，认领是否过期只由时间判定，接管与否由 agent 决定。',
      '- 正常流程是由 agent 自己移动卡片：主工作完成就移到 Finished；做不下去或需要人拍板就移到',
      '  Blocked 并写原因。移动卡片才是停止计时的方式，计时因此始终如实。',
      '- 任务主要由 agent 用 create_task 创建（落在 Backlog）；人只能在 Human In The Loop 列手工建任务。',
      '',
      '【备注与返工】',
      '- 任务带 needsDigest 时先别开工：把给 agent 的备注折进描述，再 digest_key_points 标记已消化；未消化就 claim_task 会被直接拒绝。',
      '- 已 Finished 的任务若被人加了新备注，会自动回到 Backlog 并带上 isRework——按返工处理，',
      '  消化新备注后再做；digest_key_points 之后 isRework 会被清掉，它只表示还有活要干，不表示曾经返工过。',
      '',
      '【等变化，不要轮询】',
      '- 等人的新备注、或等同波其他任务收尾时，不要循环调用 list_events：用 wait_for_event 传你已经见过的 seq，有事件追加会立刻返回；超时返回 timedOut: true。',
      '- wait_for_event 可以加 type、boardId 过滤；timeoutMs 上限 30000 毫秒（默认 15000）；每次等待结束都会自动清理，反复调用不会留下残留。',
      '',
      '备注与回复：',
      '- 给 agent 的备注（keyPoints）是人给 agent 下指令的通道。动手前先读（get_task），人的话不要删。',
      '- 人的每条备注都要读懂并折进描述（description），再用 digest_key_points 标记已消化。任务处于 In Progress 时整个表单都是只读的。',
    ].join('\n')
  },
  {
    name: '阻塞处理与每日同步',
    description: '工作停摆时怎么办，以及每日更新长什么样。',
    content: [
      'Blocked 的含义：没有你控制之外的东西就无法继续推进。',
      '',
      '- 一定要写阻塞原因（set_blocked_reason）；只写「blocked」而没原因是没用的。',
      '- Blocked 的任务还没完成；它们是进行中的工作，不是已完成的工作。',
      '- 任务连续两次每日更新仍然卡住，就要升级处理。',
      '',
      '每日更新（agent 写进迭代任务的描述 description）：',
      '- 进展：今天有哪些卡换了列。',
      '- 下一步：接下来要动什么。',
      '- 阻塞：卡住了什么、需要我们做什么。',
    ].join('\n')
  }
];

function seedDefaultSkillsIfEmpty() {
  if (skillsSeeded || skills.length > 0) return;
  DEFAULT_SKILLS.forEach((skill, index) => {
    const seeded = normalizeSkill(skill, index);
    emitGlobal('skill.created', seeded.id, { skill: seeded });
  });
  skillsSeeded = true;
}

export function getSkills() {
  return skills
    .filter((skill) => skill && skill.deleted !== true)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function setSkills(list) {
  const next = (Array.isArray(list) ? list : [])
    .filter((skill) => skill?.deleted !== true)
    .map(normalizeSkill);
  const current = getSkills();
  const currentById = new Map(current.map((skill) => [skill.id, skill]));
  const nextIds = new Set(next.map((skill) => skill.id));

  for (const skill of next) {
    if (!currentById.has(skill.id)) emitGlobal('skill.created', skill.id, { skill });
  }
  for (const skill of next) {
    const previous = currentById.get(skill.id);
    if (!previous) continue;
    const fields = changedFields(previous, skill, SKILL_FIELDS);
    if (Object.keys(fields).length > 0) emitGlobal('skill.updated', skill.id, { fields });
  }
  const removed = current
    .filter((skill) => !nextIds.has(skill.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const skill of removed) emitGlobal('skill.deleted', skill.id, {});

  skillsSeeded = true;
  return getSkills();
}

export function getSkillsState() {
  return { skills: getSkills() };
}

export function getGroups() {
  return groups
    .filter((group) => group && group.deleted !== true)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function setGroups(list) {
  const next = (Array.isArray(list) ? list : [])
    .filter((group) => group?.deleted !== true)
    .map(normalizeGroup);
  const current = getGroups();
  const currentById = new Map(current.map((group) => [group.id, group]));
  const nextIds = new Set(next.map((group) => group.id));
  const bindings = getBoardGroupMap();

  for (const group of next) {
    if (!currentById.has(group.id)) emitGlobal('group.created', group.id, { group });
  }
  for (const group of next) {
    const previous = currentById.get(group.id);
    if (!previous) continue;
    const fields = changedFields(previous, group, GROUP_FIELDS);
    if (Object.keys(fields).length > 0) emitGlobal('group.updated', group.id, { fields });
  }
  const removed = current
    .filter((group) => !nextIds.has(group.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const group of removed) {
    const boundBoards = Object.keys(bindings).filter((boardId) => bindings[boardId] === group.id).sort();
    emitGlobal('group.deleted', group.id, {});
    for (const boardId of boundBoards) emitGlobal('board.group.assigned', boardId, { group_id: null });
  }

  return getGroups();
}

export function getBoardGroupMap() {
  const liveGroups = liveGroupIds();
  return Object.fromEntries(
    Object.entries(boardGroups).filter(([, groupId]) => groupId !== null && groupId !== undefined && liveGroups.has(groupId))
  );
}

export function setBoardGroupMap(map) {
  const next = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  const current = getBoardGroupMap();
  const boardIds = [...new Set([...Object.keys(current), ...Object.keys(next)])].sort();

  for (const boardId of boardIds) {
    const before = Object.prototype.hasOwnProperty.call(current, boardId) ? current[boardId] : null;
    const raw = Object.prototype.hasOwnProperty.call(next, boardId) ? next[boardId] : null;
    const after = typeof raw === 'string' ? raw : null;
    if (before !== after) emitGlobal('board.group.assigned', boardId, { group_id: after });
  }

  return getBoardGroupMap();
}

export function getGroupsState() {
  return { groups: getGroups(), boardGroups: getBoardGroupMap() };
}

export function getRecentEvents(limit = 100) {
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(1000, limit)) : 100;
  return events.slice(-count).map((event) => ({
    seq: event.seq,
    type: event.type,
    boardId: event.board_id,
    entityId: event.entity_id,
    at: event.at,
    actor: event.actor
  }));
}
