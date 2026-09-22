import { applyTaskCreated, applyTaskDeleted, applyTaskMoved, applyTaskUpdated } from './projection-task-handlers.js';

export function createProjectionState(seed = {}) {
  return {
    boards: Array.isArray(seed.boards) ? seed.boards : [],
    tasks: Array.isArray(seed.tasks) ? seed.tasks : [],
    columns: Array.isArray(seed.columns) ? seed.columns : [],
    groups: Array.isArray(seed.groups) ? seed.groups : [],
    boardGroups: seed.boardGroups && typeof seed.boardGroups === 'object' ? seed.boardGroups : {},
    skills: Array.isArray(seed.skills) ? seed.skills : [],
    settings: seed.settings && typeof seed.settings === 'object' ? seed.settings : {},
    appliedEventIds: seed.appliedEventIds instanceof Set ? new Set(seed.appliedEventIds) : new Set(),
    taskTombstones: seed.taskTombstones instanceof Set ? new Set(seed.taskTombstones) : new Set()
  };
}

function cloneState(state) {
  return {
    ...state,
    boards: [...state.boards],
    tasks: state.tasks.map((task) => ({
      ...task,
      ...(Array.isArray(task.relationships) ? { relationships: task.relationships.map((relationship) => ({ ...relationship })) } : {}),
      ...(Array.isArray(task.columnHistory) ? { columnHistory: [...task.columnHistory] } : {})
    })),
    columns: state.columns.map((column) => ({ ...column })),
    groups: state.groups.map((group) => ({ ...group })),
    boardGroups: { ...state.boardGroups },
    skills: state.skills.map((skill) => ({ ...skill })),
    settings: { ...state.settings },
    appliedEventIds: new Set(state.appliedEventIds),
    taskTombstones: new Set(state.taskTombstones)
  };
}

function updateTaskById(state, taskId, updater) {
  if (state.taskTombstones.has(taskId)) return state;
  return {
    ...state,
    tasks: state.tasks.map((task) => (task.id === taskId ? updater(task) : task))
  };
}

function applyRelationshipAdded(state, event) {
  const relationship = event.payload?.relationship;
  if (!relationship || typeof relationship !== 'object') return state;
  return updateTaskById(state, event.entity_id, (task) => {
    const relationships = Array.isArray(task.relationships) ? task.relationships : [];
    const exists = relationships.some((entry) => entry.targetTaskId === relationship.targetTaskId && entry.type === relationship.type);
    return exists ? task : { ...task, relationships: [...relationships, { ...relationship }] };
  });
}

function applyRelationshipRemoved(state, event) {
  const targetTaskId = event.payload?.targetTaskId;
  const relationshipType = event.payload?.relationship_type;
  return updateTaskById(state, event.entity_id, (task) => ({
    ...task,
    relationships: (Array.isArray(task.relationships) ? task.relationships : [])
      .filter((entry) => !(entry.targetTaskId === targetTaskId && entry.type === relationshipType))
  }));
}

function applyColumnCreated(state, event) {
  if (state.columns.some((column) => column.id === event.entity_id)) return state;
  return {
    ...state,
    columns: [...state.columns, { id: event.entity_id, ...(event.payload?.column || event.payload?.fields || {}) }]
  };
}

function applyColumnUpdated(state, event) {
  const fields = event.payload?.fields && typeof event.payload.fields === 'object' ? event.payload.fields : {};
  return {
    ...state,
    columns: state.columns.map((column) => (column.id === event.entity_id ? { ...column, ...fields } : column))
  };
}

function applyBoardCreated(state, event) {
  if (state.boards.some((board) => board.id === event.entity_id)) return state;
  return {
    ...state,
    boards: [...state.boards, { id: event.entity_id, ...(event.payload?.board || event.payload?.fields || {}) }]
  };
}

function applyBoardUpdated(state, event) {
  const fields = event.payload?.fields && typeof event.payload.fields === 'object' ? event.payload.fields : {};
  return {
    ...state,
    boards: state.boards.map((board) => (board.id === event.entity_id ? { ...board, ...fields } : board))
  };
}

function applyBoardDeleted(state, event) {
  return {
    ...state,
    boards: state.boards.map((board) => (board.id === event.entity_id ? { ...board, deleted: true } : board))
  };
}

function applyGroupCreated(state, event) {
  if (state.groups.some((group) => group.id === event.entity_id)) return state;
  return {
    ...state,
    groups: [...state.groups, { id: event.entity_id, ...(event.payload?.group || event.payload?.fields || {}) }]
  };
}

function applyGroupUpdated(state, event) {
  const fields = event.payload?.fields && typeof event.payload.fields === 'object' ? event.payload.fields : {};
  return {
    ...state,
    groups: state.groups.map((group) => (group.id === event.entity_id ? { ...group, ...fields } : group))
  };
}

function applyGroupDeleted(state, event) {
  return {
    ...state,
    groups: state.groups.map((group) => (group.id === event.entity_id ? { ...group, deleted: true } : group)),
    boardGroups: Object.fromEntries(
      Object.entries(state.boardGroups).map(([boardId, groupId]) => [boardId, groupId === event.entity_id ? null : groupId])
    )
  };
}

function applyBoardGroupAssigned(state, event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  if (!('group_id' in payload) || payload.group_id === undefined) return state;
  return { ...state, boardGroups: { ...state.boardGroups, [event.entity_id]: payload.group_id } };
}

function applySkillCreated(state, event) {
  if (state.skills.some((skill) => skill.id === event.entity_id)) return state;
  return {
    ...state,
    skills: [...state.skills, { id: event.entity_id, ...(event.payload?.skill || event.payload?.fields || {}) }]
  };
}

function applySkillUpdated(state, event) {
  const fields = event.payload?.fields && typeof event.payload.fields === 'object' ? event.payload.fields : {};
  return {
    ...state,
    skills: state.skills.map((skill) => (skill.id === event.entity_id ? { ...skill, ...fields } : skill))
  };
}

function applySkillDeleted(state, event) {
  return {
    ...state,
    skills: state.skills.map((skill) => (skill.id === event.entity_id ? { ...skill, deleted: true } : skill))
  };
}

function applySettingsUpdated(state, event) {
  const fields = event.payload?.fields && typeof event.payload.fields === 'object' ? event.payload.fields : {};
  const next = { ...state.settings, ...fields };
  delete next.columnSummaries;
  return { ...state, settings: next };
}

const handlers = {
  'task.created': applyTaskCreated,
  'task.updated': applyTaskUpdated,
  'task.moved': applyTaskMoved,
  'task.deleted': applyTaskDeleted,
  'relationship.added': applyRelationshipAdded,
  'relationship.removed': applyRelationshipRemoved,
  'column.created': applyColumnCreated,
  'column.updated': applyColumnUpdated,
  'board.created': applyBoardCreated,
  'board.updated': applyBoardUpdated,
  'board.deleted': applyBoardDeleted,
  'group.created': applyGroupCreated,
  'group.updated': applyGroupUpdated,
  'group.deleted': applyGroupDeleted,
  'board.group.assigned': applyBoardGroupAssigned,
  'skill.created': applySkillCreated,
  'skill.updated': applySkillUpdated,
  'skill.deleted': applySkillDeleted,
  'settings.updated': applySettingsUpdated
};

export function applyEvent(state, event) {
  if (state.appliedEventIds.has(event.id)) return state;

  const handler = handlers[event.type];
  if (!handler) {
    console.warn(`Unknown event type: ${event.type}`);
    return state;
  }

  const next = handler(cloneState(state), event);
  next.appliedEventIds.add(event.id);
  return next;
}

export function applyEvents(state, events) {
  return [...events].sort((a, b) => {
    if (a.hlc.wallTime !== b.hlc.wallTime) return a.hlc.wallTime - b.hlc.wallTime;
    if (a.hlc.counter !== b.hlc.counter) return a.hlc.counter - b.hlc.counter;
    return a.hlc.nodeId < b.hlc.nodeId ? -1 : a.hlc.nodeId > b.hlc.nodeId ? 1 : 0;
  }).reduce((nextState, event) => applyEvent(nextState, event), state);
}
