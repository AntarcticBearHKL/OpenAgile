import {
  normalizeKeyPoints,
  normalizeComments,
  normalizeEstimate,
  normalizeTaskType
} from './agile.js';

export const RELATIONSHIP_INVERSE = { prerequisite: 'dependent', dependent: 'prerequisite', related: 'related' };

export function normalizeAgileFields(fields = {}) {
  const source = fields && typeof fields === 'object' ? fields : {};
  const parentId = (source.parentId ?? '').toString().trim();
  return {
    type: normalizeTaskType(source.type),
    estimate: normalizeEstimate(source.estimate),
    assignee: (source.assignee ?? '').toString().trim(),
    parentId: parentId || null,
    keyPoints: normalizeKeyPoints(source.keyPoints ?? source.acceptanceCriteria),
    comments: normalizeComments(source.comments)
  };
}

export function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function columnEntryTime(task) {
  const history = Array.isArray(task?.columnHistory) ? task.columnHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry && entry.column === task.column && typeof entry.at === 'string' && entry.at) {
      return entry.at;
    }
  }
  return typeof task?.creationDate === 'string' ? task.creationDate : '';
}

export function compareColumnEntry(left, right) {
  const leftPending = left?.needsDigest === true ? 0 : 1;
  const rightPending = right?.needsDigest === true ? 0 : 1;
  if (leftPending !== rightPending) return leftPending - rightPending;

  const leftAt = columnEntryTime(left);
  const rightAt = columnEntryTime(right);
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;

  const leftId = String(left?.id ?? '');
  const rightId = String(right?.id ?? '');
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function relationshipKey(relationship) {
  return `${relationship.targetTaskId}:${relationship.type}`;
}

/**
 * Apply bidirectional relationship sync on a tasks array.
 * Diffs oldRelationships vs newRelationships for a given taskId and mutates
 * the target tasks in-place to keep inverses consistent.
 */
export function syncRelationshipInverses(tasks, taskId, oldRelationships, newRelationships, at) {
  const oldMap = new Map(oldRelationships.map((r) => [r.targetTaskId, r.type]));
  const newMap = new Map(newRelationships.map((r) => [r.targetTaskId, r.type]));

  for (const [targetId, newType] of newMap) {
    const target = tasks.find((t) => t.id === targetId);
    if (!target) continue;
    if (!Array.isArray(target.relationships)) target.relationships = [];
    // Remove any existing entry pointing back at taskId, then add the correct inverse.
    const inverseType = RELATIONSHIP_INVERSE[newType];
    const targetIndex = tasks.findIndex((t) => t.id === targetId);
    let nextTarget = {
      ...target,
      relationships: [
        ...target.relationships.filter((r) => r.targetTaskId !== taskId),
        { type: inverseType, targetTaskId: taskId }
      ]
    };

    tasks[targetIndex] = nextTarget;
  }

  for (const [targetId, oldType] of oldMap) {
    if (newMap.has(targetId)) continue; // handled above
    const target = tasks.find((t) => t.id === targetId);
    if (!target || !Array.isArray(target.relationships)) continue;
    const inverseType = RELATIONSHIP_INVERSE[oldType];
    const targetIndex = tasks.findIndex((t) => t.id === targetId);
    tasks[targetIndex] = {
      ...target,
      relationships: target.relationships.filter((r) => r.targetTaskId !== taskId)
    };
  }
}
