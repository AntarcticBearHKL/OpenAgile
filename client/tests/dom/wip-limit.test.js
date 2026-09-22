import { describe, expect, test } from 'vitest';
import { syncColumnWip } from '../../src/modules/wip-limit.js';
import { mountToBody } from './setup.js';

const todo = { id: 'c1', name: 'Todo', wipLimit: 5 };
const unlimited = { id: 'c2', name: 'Backlog', wipLimit: 0 };

function buildColumn() {
  const el = document.createElement('article');
  el.className = 'task-column';
  el.dataset.column = 'c1';
  mountToBody(el);
  return el;
}

describe('syncColumnWip', () => {
  test('drives data-wip through under, at and over', () => {
    const el = buildColumn();

    syncColumnWip(el, 4, todo);
    expect(el.dataset.wip).toBe('under');

    syncColumnWip(el, 5, todo);
    expect(el.dataset.wip).toBe('at');

    syncColumnWip(el, 6, todo);
    expect(el.dataset.wip).toBe('over');
  });

  test('an unlimited column stays under at any count', () => {
    const el = buildColumn();
    syncColumnWip(el, 200, unlimited);
    expect(el.dataset.wip).toBe('under');
  });
});
