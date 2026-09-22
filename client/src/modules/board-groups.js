import { apiUrl } from './app-config.js';
import { generateUUID, readLocalJson as readJson } from './utils.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';
import { readModelProjector } from './storage-projector.js';
import { globalState } from './storage-state.js';

export const GROUPS_KEY = 'openagile:groups';
export const BOARD_GROUP_KEY = 'openagile:boardGroup';
export const UNTITLED_GROUP_NAME = 'Untitled group';

const GROUPS_MIGRATED_KEY = 'openagile:groupsMigrated';
const ITERATION_NAME_PREFIX = 'Iteration';
const GROUPS_API = apiUrl('/api/groups');

function markMigrated() {
  try { localStorage.setItem(GROUPS_MIGRATED_KEY, '1'); } catch { /* ignore */ }
}

function normalizeGroup(raw, index) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : UNTITLED_GROUP_NAME;
  const order = Number.isFinite(raw.order) ? raw.order : index + 1;
  return { id: raw.id, name, order, collapsed: raw.collapsed === true, prefixCollapsed: raw.prefixCollapsed === true };
}

function normalizeBoardGroupMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const map = {};
  for (const [boardId, groupId] of Object.entries(raw)) {
    if (typeof boardId === 'string' && typeof groupId === 'string' && groupId) {
      map[boardId] = groupId;
    }
  }
  return map;
}

export function iterationLabel(index) {
  return `${ITERATION_NAME_PREFIX} ${index + 1}`;
}

function migrateGroupsFromLocalStorage() {
  if (Array.isArray(globalState.groups) && globalState.groups.length > 0) return;
  const raw = readJson(GROUPS_KEY, []);
  if (!Array.isArray(raw) || raw.length === 0) return;

  const groups = raw.map((group, index) => normalizeGroup(group, index)).filter(Boolean);
  if (groups.length === 0) return;

  markMigrated();
  for (const group of groups) {
    scheduleDomainEvent({ type: 'group.created', scope: 'global', entityId: group.id, payload: { group } });
  }

  const known = new Set(groups.map((group) => group.id));
  const storedMap = normalizeBoardGroupMap(readJson(BOARD_GROUP_KEY, {}));
  for (const [boardId, groupId] of Object.entries(storedMap)) {
    if (!known.has(groupId)) continue;
    scheduleDomainEvent({ type: 'board.group.assigned', scope: 'global', entityId: boardId, payload: { group_id: groupId } });
  }
}

function ensureGroupsReady() {
  readModelProjector.register();
  migrateGroupsFromLocalStorage();
}

export function listGroups() {
  ensureGroupsReady();
  const raw = Array.isArray(globalState.groups) ? globalState.groups : [];
  return raw
    .filter((group) => group && group.deleted !== true)
    .map((group, index) => normalizeGroup(group, index))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

function liveGroupIds() {
  const groups = Array.isArray(globalState.groups) ? globalState.groups : [];
  return new Set(groups.filter((group) => group && group.deleted !== true).map((group) => group.id));
}

export function readBoardGroupMap() {
  ensureGroupsReady();
  const known = liveGroupIds();
  const stored = normalizeBoardGroupMap(globalState.boardGroups);
  const map = {};
  for (const [boardId, groupId] of Object.entries(stored)) {
    if (known.has(groupId)) map[boardId] = groupId;
  }
  return map;
}

export function getGroupIdForBoard(boardId) {
  const id = typeof boardId === 'string' ? boardId : '';
  if (!id) return null;
  return readBoardGroupMap()[id] || null;
}

export function createGroup(name = 'New Group') {
  ensureGroupsReady();
  const groups = listGroups();
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const group = {
    id: generateUUID(),
    name: trimmed || 'New Group',
    order: groups.length + 1,
    collapsed: false,
    prefixCollapsed: false
  };
  scheduleDomainEvent({ type: 'group.created', scope: 'global', entityId: group.id, payload: { group } });
  return group;
}

export function renameGroup(groupId, newName) {
  const id = typeof groupId === 'string' ? groupId : '';
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (!id || !name) return false;

  ensureGroupsReady();
  const group = listGroups().find((entry) => entry.id === id);
  if (!group) return false;

  if (group.name !== name) {
    scheduleDomainEvent({ type: 'group.updated', scope: 'global', entityId: id, payload: { fields: { name } } });
  }
  return true;
}

export function setGroupCollapsed(groupId, collapsed) {
  const id = typeof groupId === 'string' ? groupId : '';
  if (!id) return false;

  ensureGroupsReady();
  const group = listGroups().find((entry) => entry.id === id);
  if (!group) return false;

  const next = collapsed === true;
  if (group.collapsed !== next) {
    scheduleDomainEvent({ type: 'group.updated', scope: 'global', entityId: id, payload: { fields: { collapsed: next } } });
  }
  return true;
}

export function toggleGroupCollapsed(groupId) {
  const group = listGroups().find((entry) => entry.id === groupId);
  if (!group) return false;
  return setGroupCollapsed(groupId, !group.collapsed);
}

export function setGroupPrefixCollapsed(groupId, collapsed) {
  const id = typeof groupId === 'string' ? groupId : '';
  if (!id) return false;

  ensureGroupsReady();
  const group = listGroups().find((entry) => entry.id === id);
  if (!group) return false;

  const next = collapsed === true;
  if (group.prefixCollapsed !== next) {
    scheduleDomainEvent({ type: 'group.updated', scope: 'global', entityId: id, payload: { fields: { prefixCollapsed: next } } });
  }
  return true;
}

export function toggleGroupPrefixCollapsed(groupId) {
  const group = listGroups().find((entry) => entry.id === groupId);
  if (!group) return false;
  return setGroupPrefixCollapsed(groupId, !group.prefixCollapsed);
}

export function deleteGroup(groupId) {
  const id = typeof groupId === 'string' ? groupId : '';
  if (!id) return false;

  ensureGroupsReady();
  if (!listGroups().some((group) => group.id === id)) return false;

  const boundBoards = Object.entries(readBoardGroupMap())
    .filter(([, groupIdForBoard]) => groupIdForBoard === id)
    .map(([boardId]) => boardId);

  scheduleDomainEvent({ type: 'group.deleted', scope: 'global', entityId: id, payload: {} });
  for (const boardId of boundBoards) {
    scheduleDomainEvent({ type: 'board.group.assigned', scope: 'global', entityId: boardId, payload: { group_id: null } });
  }
  return true;
}

export function nextIterationName(groupId) {
  const groups = listGroups();
  const requested = typeof groupId === 'string' ? groupId : '';
  const target = requested || groups[groups.length - 1]?.id || '';
  if (!target) return iterationLabel(0);

  const map = readBoardGroupMap();
  const count = Object.values(map).filter((value) => value === target).length;
  return iterationLabel(count);
}

export function assignBoardToGroup(boardId, groupId) {
  const id = typeof boardId === 'string' ? boardId : '';
  if (!id) return false;

  ensureGroupsReady();
  const target = typeof groupId === 'string' ? groupId : '';
  const groupExists = target ? listGroups().some((group) => group.id === target) : false;
  const next = groupExists ? target : null;

  if ((readBoardGroupMap()[id] || null) !== next) {
    scheduleDomainEvent({ type: 'board.group.assigned', scope: 'global', entityId: id, payload: { group_id: next } });
  }
  return true;
}

export function pruneBoardGroups(validBoardIds) {
  const valid = new Set(Array.isArray(validBoardIds) ? validBoardIds : []);
  if (valid.size === 0) return false;

  ensureGroupsReady();
  const map = readBoardGroupMap();

  let changed = false;
  for (const boardId of Object.keys(map)) {
    if (valid.has(boardId)) continue;
    scheduleDomainEvent({ type: 'board.group.assigned', scope: 'global', entityId: boardId, payload: { group_id: null } });
    changed = true;
  }
  return changed;
}

export function ensureBoardsGrouped(boardIds) {
  const ids = Array.isArray(boardIds) ? boardIds.filter((boardId) => typeof boardId === 'string' && boardId) : [];
  if (ids.length === 0) return null;

  const groups = listGroups();
  const map = readBoardGroupMap();
  const known = new Set(groups.map((group) => group.id));
  const orphans = ids.filter((boardId) => !known.has(map[boardId]));
  if (orphans.length === 0) return null;

  const targetId = groups.length > 0 ? groups[groups.length - 1].id : createGroup().id;
  for (const boardId of orphans) assignBoardToGroup(boardId, targetId);
  return targetId;
}

export function adoptGroupsState(state) {
  if (!state || typeof state !== 'object') return false;
  const hasGroups = Array.isArray(state.groups);
  const incomingMap = state.boardGroups && typeof state.boardGroups === 'object' && !Array.isArray(state.boardGroups);
  if (!hasGroups && !incomingMap) return false;

  ensureGroupsReady();
  let changed = false;
  const current = new Map(listGroups().map((group) => [group.id, group]));
  const known = new Set(current.keys());

  if (hasGroups) {
    for (const [index, raw] of state.groups.entries()) {
      const group = normalizeGroup(raw, index);
      if (!group) continue;
      known.add(group.id);
      const existing = current.get(group.id);
      if (!existing) {
        scheduleDomainEvent({ type: 'group.created', scope: 'global', entityId: group.id, payload: { group } });
        changed = true;
        continue;
      }

      const fields = {};
      if (existing.name !== group.name) fields.name = group.name;
      if (existing.order !== group.order) fields.order = group.order;
      if (existing.collapsed !== group.collapsed) fields.collapsed = group.collapsed;
      if (existing.prefixCollapsed !== group.prefixCollapsed) fields.prefixCollapsed = group.prefixCollapsed;
      if (Object.keys(fields).length > 0) {
        scheduleDomainEvent({ type: 'group.updated', scope: 'global', entityId: group.id, payload: { fields } });
        changed = true;
      }
    }
  }

  if (incomingMap) {
    const currentMap = readBoardGroupMap();
    const map = normalizeBoardGroupMap(state.boardGroups);
    for (const [boardId, groupId] of Object.entries(map)) {
      if (!known.has(groupId)) continue;
      if (currentMap[boardId] === groupId) continue;
      scheduleDomainEvent({ type: 'board.group.assigned', scope: 'global', entityId: boardId, payload: { group_id: groupId } });
      changed = true;
    }
  }

  return changed;
}

export function initGroupSync() {
  if (initGroupSync._started) return;
  initGroupSync._started = true;

  ensureGroupsReady();

  fetch(GROUPS_API, { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((state) => {
      if (!state) return;
      if (Array.isArray(state.groups) && state.groups.length > 0) {
        adoptGroupsState(state);
      }
    })
    .catch(() => {});

  window.addEventListener('openagile:groups-changed', (event) => {
    adoptGroupsState(event.detail);
  });
}
