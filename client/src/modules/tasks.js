import { generateUUID } from './utils.js';
import { HIL_COLUMN_ID, IN_PROGRESS_COLUMN_ID } from './constants.js';
import { getActiveBoardId, getActiveBoardName, isDoneColumnId, loadTasks } from './storage.js';
import { normalizeRelationships } from './normalize.js';
import { nextTaskKey } from './agile.js';
import { normalizeAgileFields, syncRelationshipInverses } from './task-helpers.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';

export function addTask(title, description, extraFields = {}) {
  if (!title || title.trim() === '') return;

  const tasks = loadTasks();
  const columnName = HIL_COLUMN_ID;
  // Insert new tasks at the top of the column.
  // Normalize the column's existing task orders so they start at 2 (leaving 1 for the new task).
  const columnTasks = tasks
    .filter((t) => t.column === columnName)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const nextOrderById = new Map();
  columnTasks.forEach((task, index) => {
    nextOrderById.set(task.id, index + 2);
  });

  const updatedTasks = tasks.map((task) => {
    if (task.column !== columnName) return task;
    const nextOrder = nextOrderById.get(task.id);
    return typeof nextOrder === 'number' ? { ...task, order: nextOrder } : task;
  });

  const nowIso = new Date().toISOString();
  const source = extraFields && typeof extraFields === 'object' ? extraFields : {};
  const normalizedRelationships = normalizeRelationships(source.relationships);
  const agileFields = normalizeAgileFields(source);
  let newTask = {
    id: generateUUID(),
    key: nextTaskKey(getActiveBoardName(), tasks),
    title: title.trim(),
    description: (description || '').toString().trim(),
    column: columnName,
    order: 1,
    relationships: normalizedRelationships,
    type: agileFields.type,
    estimate: agileFields.estimate,
    assignee: agileFields.assignee,
    parentId: agileFields.parentId,
    keyPoints: agileFields.keyPoints,
    comments: agileFields.comments,
    needsDigest: agileFields.keyPoints.some((point) => !point.digestedAt),
    blockedReason: '',
    blockedAt: null,
    creationDate: nowIso,
    changeDate: nowIso,
    columnHistory: [{ column: columnName, at: nowIso }]
  };

  updatedTasks.push(newTask);
  syncRelationshipInverses(updatedTasks, newTask.id, [], normalizedRelationships, nowIso);
  const activeBoardId = getActiveBoardId();
  scheduleDomainEvent({
    type: 'task.created',
    boardId: activeBoardId,
    entityId: newTask.id,
    payload: { task: newTask }
  });
  // Inserting at the top renumbers the column's existing tasks; emit that reorder
  // so the read model replays from events alone (ADR-0005).
  if (columnTasks.length > 0) {
    scheduleDomainEvent({
      type: 'task.moved',
      boardId: activeBoardId,
      entityId: newTask.id,
      payload: {
        from_column: columnName,
        to_column: columnName,
        order: updatedTasks
          .filter((task) => task.column === columnName)
          .map((task) => ({ id: task.id, column: task.column, order: task.order }))
      }
    });
  }
}

// Delete a task
export function deleteTask(taskId) {
  const boardId = getActiveBoardId();
  const liveTasks = loadTasks();
  const task = liveTasks.find(t => t.id === taskId);
  if (!task) return false;
  if (isDoneColumnId(task.column)) return false;

  // task.deleted removes the task; the projection is the sole writer (ADR-0005).
  scheduleDomainEvent({
    type: 'task.deleted',
    boardId,
    entityId: task.id,
    payload: { column: task.column }
  });
  return true;
}

export function setTaskBlockedReason(taskId, reason) {
  const tasks = loadTasks();
  if (!tasks.some((task) => task.id === taskId)) return false;

  const nowIso = new Date().toISOString();
  const nextReason = typeof reason === 'string' ? reason.trim() : '';
  scheduleDomainEvent({
    type: 'task.updated',
    boardId: getActiveBoardId(),
    entityId: taskId,
    payload: {
      fields: {
        blockedReason: nextReason,
        blockedAt: nextReason ? nowIso : null,
        changeDate: nowIso
      }
    }
  });
  return true;
}

function emitTaskFields(taskId, fields) {
  if (!taskId || !fields) return false;
  const tasks = loadTasks();
  if (!tasks.some((task) => task.id === taskId)) return false;
  scheduleDomainEvent({
    type: 'task.updated',
    boardId: getActiveBoardId(),
    entityId: taskId,
    payload: { fields: { ...fields, changeDate: new Date().toISOString() } }
  });
  return true;
}

export function isTaskLocked(task) {
  const columnId = task?.column;
  if (!columnId) return false;
  return columnId === IN_PROGRESS_COLUMN_ID;
}
