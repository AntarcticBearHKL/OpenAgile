import { getActiveBoardId, isDoneColumnId, loadColumns, loadTasks } from './storage.js';
import { BACKLOG_COLUMN_ID } from './constants.js';
import { normalizeRelationships } from './normalize.js';
import {
  isBlockedColumnId,
  normalizeKeyPoints,
  normalizeComments,
  normalizeEstimate,
  normalizeTaskType
} from './agile.js';
import { RELATIONSHIP_INVERSE, relationshipKey, sameJson, syncRelationshipInverses } from './task-helpers.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';

// A column move is only honoured when the caller passes `column` explicitly.
export function updateTask(taskId, title, description, extraFields = undefined) {
  if (!title || title.trim() === '') return;

  const tasks = loadTasks();
  const taskIndex = tasks.findIndex(t => t.id === taskId);
  if (taskIndex !== -1) {
    const source = extraFields && typeof extraFields === 'object' ? extraFields : null;
    const prevColumn = tasks[taskIndex].column;
    let nextColumn = prevColumn;
    const nowIso = new Date().toISOString();

    // Ensure we have a baseline history entry before appending transitions.
    if (!Array.isArray(tasks[taskIndex].columnHistory) || tasks[taskIndex].columnHistory.length === 0) {
      const seededAt = tasks[taskIndex].creationDate || tasks[taskIndex].changeDate || nowIso;
      tasks[taskIndex].columnHistory = [{ column: prevColumn, at: seededAt }];
    }

    const oldRelationships = Array.isArray(tasks[taskIndex].relationships) ? tasks[taskIndex].relationships : [];
    const newRelationships = normalizeRelationships(source?.relationships ?? oldRelationships);

    const previousTask = { ...tasks[taskIndex] };
    const nextTitle = title.trim();
    const nextDescription = (description || '').toString().trim();
    const has = (key) => source !== null && Object.prototype.hasOwnProperty.call(source, key);
    const changedFields = {};

    tasks[taskIndex].title = nextTitle;
    tasks[taskIndex].description = nextDescription;
    tasks[taskIndex].relationships = newRelationships;
    if (has('type')) {
      tasks[taskIndex].type = normalizeTaskType(source.type);
    }
    if (has('estimate')) {
      tasks[taskIndex].estimate = normalizeEstimate(source.estimate);
    }
    if (has('assignee')) {
      tasks[taskIndex].assignee = (source.assignee ?? '').toString().trim();
    }
    if (has('parentId')) {
      const requestedParentId = (source.parentId ?? '').toString().trim();
      tasks[taskIndex].parentId = requestedParentId && requestedParentId !== taskId ? requestedParentId : null;
    }
    if (has('keyPoints')) {
      const nextKeyPoints = normalizeKeyPoints(source.keyPoints);
      const previousKeyPoints = normalizeKeyPoints(previousTask.keyPoints ?? previousTask.acceptanceCriteria);
      const appended = nextKeyPoints.some((point) => !previousKeyPoints.some((prev) => prev.id === point.id));
      tasks[taskIndex].keyPoints = nextKeyPoints;
      tasks[taskIndex].needsDigest = nextKeyPoints.some((point) => !point.digestedAt);

      if (appended && isDoneColumnId(nextColumn)) {
        nextColumn = BACKLOG_COLUMN_ID;
        tasks[taskIndex].column = nextColumn;
        tasks[taskIndex].isRework = true;
      }
    }
    if (has('comments')) {
      tasks[taskIndex].comments = normalizeComments(source.comments);
    }

    syncRelationshipInverses(tasks, taskId, oldRelationships, newRelationships, nowIso);

    if (prevColumn !== nextColumn) {
      tasks[taskIndex].columnHistory.push({ column: nextColumn, at: nowIso });
    }

    if (previousTask.title !== nextTitle) {
      changedFields.title = nextTitle;
    }
    if ((previousTask.description || '') !== nextDescription) {
      changedFields.description = nextDescription;
    }
    if (has('type') && normalizeTaskType(previousTask.type) !== tasks[taskIndex].type) {
      changedFields.type = tasks[taskIndex].type;
    }
    if (has('estimate') && normalizeEstimate(previousTask.estimate) !== tasks[taskIndex].estimate) {
      changedFields.estimate = tasks[taskIndex].estimate;
    }
    if (has('assignee') && (previousTask.assignee ?? '').toString().trim() !== tasks[taskIndex].assignee) {
      changedFields.assignee = tasks[taskIndex].assignee;
    }
    if (has('parentId')) {
      const previousParentId = (previousTask.parentId ?? '').toString().trim() || null;
      if (previousParentId !== tasks[taskIndex].parentId) {
        changedFields.parentId = tasks[taskIndex].parentId;
      }
    }
    if (has('keyPoints') && !sameJson(normalizeKeyPoints(previousTask.keyPoints ?? previousTask.acceptanceCriteria), tasks[taskIndex].keyPoints)) {
      changedFields.keyPoints = tasks[taskIndex].keyPoints;
    }
    if (has('keyPoints') && tasks[taskIndex].needsDigest !== (previousTask.needsDigest === true)) {
      changedFields.needsDigest = tasks[taskIndex].needsDigest;
    }
    if (tasks[taskIndex].isRework === true && previousTask.isRework !== true) {
      changedFields.isRework = true;
    }
    if (has('comments') && !sameJson(normalizeComments(previousTask.comments), tasks[taskIndex].comments)) {
      changedFields.comments = tasks[taskIndex].comments;
    }
    const previousRelationshipKeys = new Set(oldRelationships.map(relationshipKey));
    const nextRelationshipKeys = new Set(newRelationships.map(relationshipKey));

    if (!isDoneColumnId(prevColumn) && isDoneColumnId(nextColumn)) {
      tasks[taskIndex].doneDate = nowIso;
    } else if (isDoneColumnId(prevColumn) && !isDoneColumnId(nextColumn)) {
      delete tasks[taskIndex].doneDate;
    }

    const columns = loadColumns();
    if (isBlockedColumnId(prevColumn, columns) && !isBlockedColumnId(nextColumn, columns)) {
      tasks[taskIndex].blockedReason = '';
      tasks[taskIndex].blockedAt = null;
      changedFields.blockedReason = '';
      changedFields.blockedAt = null;
    }

    tasks[taskIndex].changeDate = nowIso;
    const boardId = getActiveBoardId();
    if (Object.keys(changedFields).length > 0) {
      scheduleDomainEvent({
        type: 'task.updated',
        boardId,
        entityId: taskId,
        payload: { fields: changedFields }
      });
    }
    if (prevColumn !== nextColumn) {
      scheduleDomainEvent({
        type: 'task.moved',
        boardId,
        entityId: taskId,
        payload: {
          from_column: prevColumn,
          to_column: nextColumn,
          order: tasks.map((task) => ({ id: task.id, column: task.column, order: task.order }))
        }
      });
    }
    newRelationships
      .filter((relationship) => !previousRelationshipKeys.has(relationshipKey(relationship)))
      .forEach((relationship) => {
        scheduleDomainEvent({ type: 'relationship.added', boardId, entityId: taskId, payload: { relationship } });
        // Emit the inverse on the target task so the bidirectional link replays
        // from events alone (the reducer is the sole read-model writer — ADR-0005).
        const inverseType = RELATIONSHIP_INVERSE[relationship.type];
        if (inverseType) {
          scheduleDomainEvent({
            type: 'relationship.added',
            boardId,
            entityId: relationship.targetTaskId,
            payload: { relationship: { type: inverseType, targetTaskId: taskId } }
          });
        }
      });
    oldRelationships
      .filter((relationship) => !nextRelationshipKeys.has(relationshipKey(relationship)))
      .forEach((relationship) => {
        scheduleDomainEvent({
          type: 'relationship.removed',
          boardId,
          entityId: taskId,
          payload: { targetTaskId: relationship.targetTaskId, relationship_type: relationship.type }
        });
        const inverseType = RELATIONSHIP_INVERSE[relationship.type];
        if (inverseType) {
          scheduleDomainEvent({
            type: 'relationship.removed',
            boardId,
            entityId: relationship.targetTaskId,
            payload: { targetTaskId: taskId, relationship_type: inverseType }
          });
        }
      });
  }
}
