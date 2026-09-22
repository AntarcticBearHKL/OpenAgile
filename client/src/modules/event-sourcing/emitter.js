import { emit, EVENT_EMITTED } from '../events.js';
import { flushPendingPersists, getDbRef, persistEvent } from '../idb-store.js';
import { generateUUID } from '../utils.js';
import { emitLocalSync } from './hlc.js';

const DEFAULT_ACTOR = { type: 'human', id: null };
const pendingDomainEvents = new Set();

export const DOMAIN_EVENT_TYPES = new Set([
  'board.created', 'board.updated', 'board.deleted',
  'column.created', 'column.updated',
  'task.created', 'task.updated', 'task.moved', 'task.deleted',
  'relationship.added', 'relationship.removed',
  'group.created', 'group.updated', 'group.deleted',
  'board.group.assigned',
  'skill.created', 'skill.updated', 'skill.deleted',
  'settings.updated'
]);

function buildDomainEvent({ type, scope = 'board', boardId = null, entityId = '', payload = {}, actor = DEFAULT_ACTOR }) {
  if (!DOMAIN_EVENT_TYPES.has(type)) {
    throw new Error(`Unknown domain event type: ${type}`);
  }
  return {
    id: generateUUID(),
    type,
    hlc: emitLocalSync(),
    at: new Date().toISOString(),
    actor,
    scope,
    board_id: scope === 'board' ? boardId : null,
    entity_id: entityId,
    payload
  };
}

export function scheduleDomainEvent(input) {
  const event = buildDomainEvent(input);
  // Project synchronously: the read-model projection listens on EVENT_EMITTED, so
  // emitting here updates the in-memory read model before the caller's
  // renderBoard() runs (instant UI). The reducer/projection remains the sole
  // writer of the read model (ADR-0005); persistence to IDB is deferred and async.
  emit(EVENT_EMITTED, event);
  if (!getDbRef()) return Promise.resolve();
  const pending = persistEvent(event).catch((err) => {
    console.error('[OpenAgile] Event persistence failed', err);
  });
  pendingDomainEvents.add(pending);
  pending.finally(() => pendingDomainEvents.delete(pending));
  return pending.then(() => flushPendingPersists());
}

export async function _flushDomainEventsForTesting() {
  await Promise.all([...pendingDomainEvents]);
}
