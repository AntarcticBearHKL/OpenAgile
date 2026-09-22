import { getActiveBoardId, loadColumns } from './storage.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';

export function toggleColumnCollapsed(columnId) {
  const id = typeof columnId === 'string' ? columnId.trim() : '';
  if (!id) return false;

  const columns = loadColumns();
  const column = columns.find((c) => c.id === id);
  if (!column) return false;

  column.collapsed = column.collapsed !== true;
  scheduleDomainEvent({
    type: 'column.updated',
    boardId: getActiveBoardId(),
    entityId: column.id,
    payload: { fields: { collapsed: column.collapsed } }
  });
  return true;
}
