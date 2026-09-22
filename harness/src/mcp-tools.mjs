// MCP tools for the OpenAgile harness. Each tool mutates the shared board by
// appending domain events through store.emit(); the browser's event-sourcing
// pipeline projects the same events, so the UI updates live.

import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import {
  DEFAULT_BOARD_ID,
  MAX_WAIT_MS,
  createBoard,
  deleteBoard,
  digestKeyPoints,
  emit,
  findTask,
  getBoard,
  getBoardGroupMap,
  getBoards,
  getColumns,
  getGroups,
  getRecentEvents,
  getSeq,
  getSettings,
  getSkills,
  getSnapshot,
  getTasks,
  isClaimExpired,
  isLastBoardInGroup,
  isReadyTask,
  lookupIdempotency,
  nextReadyTask,
  pendingNotesMessage,
  recordIdempotency,
  reserveTaskKeyNumber,
  resolveGroup,
  setBoardGroupMap,
  setGroups,
  setSkills,
  waitForEvent
} from './store.mjs';

const AGENT_ID = process.env.OPENAGILE_AGENT_NAME || 'openagile-harness';
const AGENT = { type: 'agent', id: AGENT_ID };

const resolveActor = (agent) => (agent && agent.trim()) || AGENT_ID;
const agentActor = (actorId) => ({ type: 'agent', id: actorId });

const ok = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});

const isDoneColumn = (column) => column?.role === 'done' || column?.id === 'done';

function resolveBoard(boardId) {
  if (boardId) {
    if (!getBoard(boardId)) throw new Error(`Board not found: ${boardId}`);
    return boardId;
  }
  if (getBoard(DEFAULT_BOARD_ID)) return DEFAULT_BOARD_ID;
  const first = getBoards()[0];
  if (!first) throw new Error('No boards exist');
  return first.id;
}

function resolveColumn(boardId, ref) {
  const columns = getColumns(boardId);
  if (columns.length === 0) throw new Error(`Board ${boardId} has no columns`);
  if (ref === undefined || ref === null || ref === '') {
    return columns.find((c) => !isDoneColumn(c)) || columns[0];
  }
  const byId = columns.find((c) => c.id === ref);
  if (byId) return byId;
  const lower = String(ref).toLowerCase();
  const byName = columns.find((c) => String(c.name).toLowerCase() === lower);
  if (byName) return byName;
  throw new Error(`Column not found: ${ref}`);
}

const BACKLOG_COLUMN_ID = '00000000-0000-4000-8000-000000000030';
const IN_PROGRESS_COLUMN_ID = '00000000-0000-4000-8000-000000000031';

function resolveBacklogColumn(boardId) {
  const columns = getColumns(boardId);
  if (columns.length === 0) throw new Error(`Board ${boardId} has no columns`);
  return columns.find((c) => c.id === BACKLOG_COLUMN_ID)
    || columns.find((c) => String(c.name).toLowerCase() === 'backlog')
    || columns.find((c) => !isDoneColumn(c))
    || columns[0];
}

function findTaskOrThrow(taskId) {
  const found = findTask(taskId);
  if (!found) throw new Error(`Task not found: ${taskId}`);
  return found;
}

function assertNotesDigested(task) {
  const message = pendingNotesMessage(task);
  if (message) throw new Error(message);
}

function assertClaimAllows(task, actorId) {
  const holder = typeof task.claimedBy === 'string' ? task.claimedBy.trim() : '';
  if (holder && holder !== actorId && !isClaimExpired(task)) {
    throw new Error(`Task ${task.key || task.id} is held by ${holder} and that claim is still live; wait for it to expire or have ${holder} release it.`);
  }
}

function assertExpectedSeq(expectedSeq) {
  if (expectedSeq === undefined) return;
  const current = getSeq();
  if (expectedSeq !== current) {
    throw new Error(`Conflict: board changed since seq ${expectedSeq} (current ${current}); re-read and retry.`);
  }
}

function withoutRemovedFields(task) {
  const { comments, relationships, ...rest } = task;
  return rest;
}

function claimReadFields(task) {
  return {
    claimedBy: task.claimedBy || '',
    claimedAt: task.claimedAt || '',
    changeDate: task.changeDate || '',
    blockedReason: task.blockedReason || '',
    claimExpired: isClaimExpired(task)
  };
}

function maxOrder(columnId, tasks) {
  return tasks
    .filter((t) => t.column === columnId)
    .reduce((max, t) => Math.max(max, Number.isFinite(t.order) ? t.order : 0), 0);
}

function boardKeyPrefix(board) {
  const name = (board?.name || '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words.map((word) => word[0]).join('') : (words[0] || 'BRD').slice(0, 3);
  return letters.toUpperCase().slice(0, 4) || 'BRD';
}

function nextTaskKey(boardId, tasks = []) {
  const prefix = boardKeyPrefix(getBoard(boardId));
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  let liveMax = 0;
  for (const task of tasks) {
    const match = re.exec(task?.key || '');
    if (match) liveMax = Math.max(liveMax, Number(match[1]));
  }
  return `${prefix}-${reserveTaskKeyNumber(boardId, liveMax)}`;
}

function prepareNewTask({ boardId, title, description = '', assignee = '' }, tasks, context = '') {
  if (!title || !String(title).trim()) throw new Error(context ? `${context}: title is required` : 'title is required');
  const backlogColumn = resolveBacklogColumn(boardId);
  const now = new Date().toISOString();
  const id = randomUUID();
  const task = {
    id,
    key: nextTaskKey(boardId, tasks),
    title: String(title).trim(),
    description,
    assignee,
    column: backlogColumn.id,
    order: maxOrder(backlogColumn.id, tasks) + 1,
    creationDate: now,
    changeDate: now,
    columnHistory: [{ column: backlogColumn.id, at: now }],
    blockedReason: '',
    blockedAt: null
  };
  return { task, column: backlogColumn };
}

function buildMoveOrder(boardId, taskId, targetColumnId, position) {
  const tasks = getTasks(boardId).slice();
  const byColumn = new Map();
  for (const entry of tasks) {
    const columnId = entry.id === taskId ? targetColumnId : entry.column;
    if (!byColumn.has(columnId)) byColumn.set(columnId, []);
    byColumn.get(columnId).push(entry);
  }
  const order = [];
  for (const [columnId, list] of byColumn) {
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (columnId === targetColumnId && Number.isInteger(position)) {
      const current = list.findIndex((t) => t.id === taskId);
      if (current >= 0) {
        const [entry] = list.splice(current, 1);
        list.splice(Math.max(0, Math.min(position, list.length)), 0, entry);
      }
    }
    list.forEach((entry, index) => order.push({ id: entry.id, column: columnId, order: index + 1 }));
  }
  return order;
}

export function registerTools(server, { broadcastGroups = () => {} } = {}) {
  // ── Boards / reads ──────────────────────────────────────────────────────────

  server.registerTool('list_boards', {
    title: 'List boards',
    description: 'List all iterations (boards) with id, derived name and groupId. Every iteration belongs to a group.'
  }, async () => ok(getBoards()));

  server.registerTool('create_board', {
    title: 'Create board',
    description: 'Create an iteration (board) inside a group. An iteration is named Iteration N from its position in the group and is not named by hand.',
    inputSchema: {
      groupId: z.string().optional().describe('Group that will hold the iteration; defaults to the last group')
    }
  }, async ({ groupId = '' }) => ok(createBoard({ groupId })));

  server.registerTool('rename_board', {
    title: 'Rename board',
    description: 'Iterations are named Iteration 1, Iteration 2, ... from their position in a group and cannot be renamed by hand; this tool always refuses.',
    inputSchema: { boardId: z.string() }
  }, async () => {
    throw new Error('Iterations are numbered by their position in a group and cannot be renamed.');
  });

  server.registerTool('delete_board', {
    title: 'Delete board',
    description: 'Delete an iteration (board) that is the last one in its group. Earlier iterations fold away and are kept, so only the last iteration of a group can be deleted. To remove a whole group together with its iterations, use delete_group — that is the deliberate exception.',
    inputSchema: { boardId: z.string() }
  }, async ({ boardId }) => {
    const board = getBoard(boardId);
    if (!board) throw new Error(`Board not found: ${boardId}`);
    if (!isLastBoardInGroup(boardId)) {
      throw new Error(`${board.name} is not the last iteration in its group; earlier iterations fold away and are kept. Delete the last iteration, or delete the group to remove all of its iterations.`);
    }
    return ok(deleteBoard(boardId));
  });

  server.registerTool('list_groups', {
    title: 'List groups',
    description: 'List the user-named groups and the mapping from each iteration to its group.',
    inputSchema: {}
  }, async () => ok({ groups: getGroups(), boardGroups: getBoardGroupMap() }));

  server.registerTool('create_group', {
    title: 'Create group',
    description: 'Create a group: a user-named container that holds iterations. A group can be renamed.',
    inputSchema: { name: z.string().describe('Group name, as given by the user') }
  }, async ({ name }) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('name is required');
    const groups = getGroups();
    const order = groups.reduce((max, group) => Math.max(max, Number.isFinite(group.order) ? group.order : 0), 0) + 1;
    const group = { id: randomUUID(), name: trimmed, order, collapsed: false };
    setGroups([...groups, group]);
    return ok(group);
  });

  server.registerTool('rename_group', {
    title: 'Rename group',
    description: 'Rename a group: a group is the user-named container that holds iterations. The numbered iterations inside it (Iteration 1, Iteration 2, ...) cannot be renamed.',
    inputSchema: {
      groupId: z.string(),
      name: z.string().describe('New group name, as given by the user')
    }
  }, async ({ groupId, name }) => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new Error('name is required');
    const groups = getGroups();
    if (!groups.some((group) => group.id === groupId)) throw new Error(`Group not found: ${groupId}`);
    const next = groups.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group));
    setGroups(next);
    broadcastGroups();
    return ok(next.find((group) => group.id === groupId));
  });

  server.registerTool('delete_group', {
    title: 'Delete group',
    description: 'Delete a group and the iterations it holds. A board can never live outside a group, so its iterations are deleted with it — this is the deliberate exception to the rule that only a group\'s last iteration can be deleted.',
    inputSchema: { groupId: z.string() }
  }, async ({ groupId }) => {
    const groups = getGroups();
    if (!groups.some((group) => group.id === groupId)) throw new Error(`Group not found: ${groupId}`);
    const deletedBoards = getBoards()
      .filter((board) => board.groupId === groupId)
      .map((board) => board.id);
    for (const boardId of deletedBoards) deleteBoard(boardId);
    setGroups(groups.filter((group) => group.id !== groupId));
    const map = getBoardGroupMap();
    const next = {};
    for (const [boardId, mappedGroupId] of Object.entries(map)) {
      if (mappedGroupId !== groupId) next[boardId] = mappedGroupId;
    }
    setBoardGroupMap(next);
    return ok({ deleted: groupId, deletedBoards });
  });

  server.registerTool('assign_board_to_group', {
    title: 'Assign board to group',
    description: 'Move an iteration into a group. Every iteration belongs to a group and cannot be left outside one: an empty groupId attaches it to the last group.',
    inputSchema: { boardId: z.string(), groupId: z.string().optional() }
  }, async ({ boardId, groupId = '' }) => {
    if (!getBoard(boardId)) throw new Error(`Board not found: ${boardId}`);
    const group = resolveGroup(groupId);
    const map = getBoardGroupMap();
    map[boardId] = group.id;
    setBoardGroupMap(map);
    return ok({ boardId, groupId: group.id });
  });

  server.registerTool('get_board', {
    title: 'Get board',
    description: 'Get an iteration with its columns and tasks.',
    inputSchema: { boardId: z.string().optional() }
  }, async ({ boardId }) => {
    const bid = resolveBoard(boardId);
    const board = getBoard(bid);
    const columns = getColumns(bid).map((c) => ({ id: c.id, name: c.name, color: c.color, order: c.order, role: c.role || '', wipLimit: c.wipLimit || 0 }));
    const tasks = getTasks(bid)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((t) => ({ id: t.id, key: t.key || '', title: t.title, column: t.column, type: t.type || 'task' }));
    return ok({ board, columns, tasks, settings: getSettings(bid) });
  });

  server.registerTool('list_columns', {
    title: 'List columns',
    description: 'List the five fixed columns of an iteration (id, name, order).',
    inputSchema: { boardId: z.string().optional() }
  }, async ({ boardId }) => ok(getColumns(resolveBoard(boardId)).map((c) => ({ id: c.id, name: c.name, color: c.color, order: c.order, role: c.role || '', wipLimit: c.wipLimit || 0 }))));

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'List tasks in an iteration, optionally filtered by column (id or name), a text search over title/description, claimedBy (exact match; an empty string selects unclaimed tasks), needsDigest (boolean) or ready (boolean; the state claim_next dispatches — Backlog or Human In The Loop, notes digested, and unclaimed or expired-claimed). Every task reports who holds the claim and when it was last active: claimedBy, claimedAt, changeDate, blockedReason and claimExpired.',
    inputSchema: {
      boardId: z.string().optional(),
      column: z.string().optional(),
      search: z.string().optional(),
      claimedBy: z.string().optional(),
      needsDigest: z.boolean().optional(),
      ready: z.boolean().optional()
    }
  }, async ({ boardId, column, search, claimedBy, needsDigest, ready }) => {
    const bid = resolveBoard(boardId);
    const columnId = column ? resolveColumn(bid, column).id : null;
    const needle = search ? String(search).toLowerCase() : null;
    const columnsById = new Map(getColumns(bid).map((c) => [c.id, c.name]));
    const tasks = getTasks(bid)
      .filter((t) => (columnId ? t.column === columnId : true))
      .filter((t) => (needle ? `${t.title || ''} ${t.description || ''}`.toLowerCase().includes(needle) : true))
      .filter((t) => (claimedBy !== undefined ? (t.claimedBy || '') === claimedBy : true))
      .filter((t) => (needsDigest !== undefined ? (t.needsDigest === true) === needsDigest : true))
      .filter((t) => (ready !== undefined ? isReadyTask(t) === ready : true))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((t) => ({
        id: t.id, key: t.key || '', title: t.title, description: t.description || '',
        column: t.column, columnName: columnsById.get(t.column) || '',
        type: t.type || 'task',
        assignee: t.assignee || '',
        keyPoints: t.keyPoints || [], needsDigest: t.needsDigest === true, isRework: t.isRework === true,
        ...claimReadFields(t)
      }));
    return ok(tasks);
  });

  server.registerTool('get_task', {
    title: 'Get task',
    description: 'Get a single task by id: its title, description, the notes to the agent (keyPoints) and its claim state — who holds it (claimedBy), since when (claimedAt), when it was last active (changeDate), its blocked reason and whether the claim is expired (claimExpired).',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => {
    const { task, boardId } = findTaskOrThrow(taskId);
    const column = getColumns(boardId).find((c) => c.id === task.column);
    return ok({ boardId, columnName: column?.name || '', task: { ...withoutRemovedFields(task), claimExpired: isClaimExpired(task) } });
  });

  // ── Task mutations ──────────────────────────────────────────────────────────

  server.registerTool('create_task', {
    title: 'Create task',
    description: 'Create a task in Backlog with a title and a description. Pass idempotencyKey to make the call safe to retry: a key that already resolved returns the existing task instead of creating a second one. Notes to the agent (keyPoints) belong to the human: no tool can add, edit or remove them, and the agent only reads and digests them.',
    inputSchema: {
      title: z.string().describe('Task title'),
      description: z.string().optional(),
      assignee: z.string().optional(),
      boardId: z.string().optional(),
      idempotencyKey: z.string().optional().describe('Optional retry key; a key that already resolved returns the existing task')
    }
  }, async ({ title, description = '', assignee = '', boardId, idempotencyKey }) => {
    const bid = resolveBoard(boardId);
    const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    if (key) {
      const hit = lookupIdempotency(key);
      const existing = hit ? findTask(hit.taskId) : null;
      if (existing) {
        const column = getColumns(existing.boardId).find((c) => c.id === existing.task.column);
        return ok({
          id: existing.task.id,
          key: existing.task.key || '',
          boardId: existing.boardId,
          column: existing.task.column,
          columnName: column?.name || '',
          idempotent: true
        });
      }
    }
    const { task, column } = prepareNewTask({ boardId: bid, title, description, assignee }, getTasks(bid));
    emit('task.created', { boardId: bid, entityId: task.id, payload: { task }, actor: AGENT });
    if (key) recordIdempotency(key, task.id, bid);
    return ok({ id: task.id, key: task.key, boardId: bid, column: column.id, columnName: column.name, task });
  });

  server.registerTool('create_tasks', {
    title: 'Create tasks',
    description: 'Create a batch of tasks in one call: pass a board and a list of items, each with a title and an optional description. Every item lands in Backlog. Pass a per-item idempotencyKey to make retries safe: items whose key already resolved are skipped and reported as existing (idempotent: true), and skipped counts them. The whole batch is validated before anything is written — an empty title or a board that does not exist refuses the entire batch with an error naming the offending item, so a partial batch is never applied. Emits one task.created event per created task, not one batch event: the reducer and the SSE stream project event by event, so each task lands exactly as a single create_task would. Returns one result per item with the created id and key.',
    inputSchema: {
      boardId: z.string().optional().describe('Board that receives the tasks; defaults to the default board'),
      tasks: z.array(z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        assignee: z.string().optional(),
        idempotencyKey: z.string().optional().describe('Optional retry key; an item whose key already resolved is skipped and reported as existing')
      })).describe('Tasks to create, in order; every item needs a non-empty title, description and assignee are optional')
    }
  }, async ({ boardId, tasks }) => {
    const bid = resolveBoard(boardId);
    const list = Array.isArray(tasks) ? tasks : [];
    if (list.length === 0) throw new Error('tasks must be a non-empty array');
    const planned = [];
    const planning = getTasks(bid).slice();
    const seen = new Map();
    const results = [];
    list.forEach((item, index) => {
      const where = `tasks[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where}: an item must be an object with a title`);
      const key = typeof item.idempotencyKey === 'string' ? item.idempotencyKey.trim() : '';
      if (key) {
        const prior = seen.get(key);
        const hit = prior || lookupIdempotency(key);
        const existing = hit ? (hit.task ? hit : findTask(hit.taskId)) : null;
        if (existing) {
          const column = getColumns(existing.boardId).find((c) => c.id === existing.task.column);
          results[index] = {
            id: existing.task.id,
            key: existing.task.key || '',
            boardId: existing.boardId,
            column: existing.task.column,
            columnName: column?.name || '',
            idempotent: true
          };
          return;
        }
      }
      const { task, column } = prepareNewTask({
        boardId: bid,
        title: item.title,
        description: item.description ?? '',
        assignee: item.assignee ?? ''
      }, planning, where);
      if (key) seen.set(key, { task, boardId: bid });
      planned.push({ task, column, idempotencyKey: key });
      planning.push(task);
      results[index] = { id: task.id, key: task.key, boardId: bid, column: column.id, columnName: column.name };
    });
    for (const { task, idempotencyKey } of planned) {
      emit('task.created', { boardId: bid, entityId: task.id, payload: { task }, actor: AGENT });
      if (idempotencyKey) recordIdempotency(idempotencyKey, task.id, bid);
    }
    return ok({
      created: planned.length,
      skipped: results.filter((entry) => entry.idempotent === true).length,
      boardId: bid,
      results
    });
  });

  server.registerTool('update_task', {
    title: 'Update task',
    description: 'Update a task\'s title, description, assignee or blocked reason. Refused while another agent holds a live claim on the task, naming the holder. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it. The notes to the agent (keyPoints) cannot be added, edited or removed here, and this tool cannot clear needsDigest: only digest_key_points does that.',
    inputSchema: {
      taskId: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      assignee: z.string().optional(),
      blockedReason: z.string().optional(),
      agent: z.string().optional().describe('Calling agent identity; defaults to the harness agent name'),
      expectedSeq: z.number().int().optional().describe('Fail if the board has changed since this seq')
    }
  }, async ({ taskId, title, description, assignee, blockedReason, agent, expectedSeq }) => {
    assertExpectedSeq(expectedSeq);
    const actorId = resolveActor(agent);
    const { task, boardId } = findTaskOrThrow(taskId);
    assertClaimAllows(task, actorId);
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (description !== undefined) fields.description = description;
    if (assignee !== undefined) fields.assignee = assignee;
    if (blockedReason !== undefined) {
      fields.blockedReason = blockedReason;
      fields.blockedAt = blockedReason ? new Date().toISOString() : null;
    }
    if (Object.keys(fields).length === 0) throw new Error('No fields to update');
    fields.changeDate = new Date().toISOString();
    emit('task.updated', { boardId, entityId: taskId, payload: { fields }, actor: agentActor(actorId) });
    return ok({ taskId, fields });
  });

  server.registerTool('move_task', {
    title: 'Move task',
    description: 'Move a task to a column (id or name). Emits the full per-column ordering so the board converges. Refused while another agent holds a live claim on the task, naming the holder. Moving an unclaimed task into In Progress claims it for the caller, so it never lands there unowned. Moving a task into In Progress is refused while it has undigested notes from the human; run digest_key_points first. Entering In Progress counts as activity and restarts the task\'s five-minute sync window. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it.',
    inputSchema: {
      taskId: z.string(),
      column: z.string(),
      position: z.number().int().optional().describe('0-based position within the target column; default appends'),
      agent: z.string().optional().describe('Calling agent identity; defaults to the harness agent name'),
      expectedSeq: z.number().int().optional().describe('Fail if the board has changed since this seq')
    }
  }, async ({ taskId, column, position, agent, expectedSeq }) => {
    assertExpectedSeq(expectedSeq);
    const actorId = resolveActor(agent);
    const { task, boardId } = findTaskOrThrow(taskId);
    assertClaimAllows(task, actorId);
    const targetColumn = resolveColumn(boardId, column);
    if (targetColumn.id === IN_PROGRESS_COLUMN_ID) assertNotesDigested(task);
    const order = buildMoveOrder(boardId, taskId, targetColumn.id, position);
    emit('task.moved', { boardId, entityId: taskId, payload: { order }, actor: agentActor(actorId) });
    if (targetColumn.id === IN_PROGRESS_COLUMN_ID && !task.claimedBy) {
      const now = new Date().toISOString();
      emit('task.updated', {
        boardId,
        entityId: taskId,
        payload: { fields: { claimedBy: actorId, claimedAt: now, assignee: task.assignee || actorId, changeDate: now } },
        actor: agentActor(actorId)
      });
    }
    return ok({ taskId, column: targetColumn.id, columnName: targetColumn.name, order });
  });

  server.registerTool('move_tasks', {
    title: 'Move tasks',
    description: 'Move a batch of tasks to one target column (id or name) in a single call. The whole batch is validated before anything is moved — a task that does not exist, a column that is not one of the five, a task held by another agent under a live claim, or a move into In Progress while any item still has undigested notes refuses the entire batch with an error naming the offending item, so a partial batch is never applied. Reuses the exact checks move_task enforces, including the digest gate. Moving an unclaimed task into In Progress claims it for the caller, so it never lands there unowned. Emits one task.moved event per task, each carrying the full per-column ordering, not one batch event: the reducer and the SSE stream project event by event, so the board converges exactly as single moves would. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it. Returns one result per item.',
    inputSchema: {
      taskIds: z.array(z.string()).describe('Task ids to move, in the order they should land in the target column'),
      column: z.string().describe('Target column id or one of the five fixed names'),
      agent: z.string().optional().describe('Calling agent identity; defaults to the harness agent name'),
      expectedSeq: z.number().int().optional().describe('Fail if the board has changed since this seq')
    }
  }, async ({ taskIds, column, agent, expectedSeq }) => {
    assertExpectedSeq(expectedSeq);
    const actorId = resolveActor(agent);
    const list = Array.isArray(taskIds) ? taskIds : [];
    if (list.length === 0) throw new Error('taskIds must be a non-empty array');
    const moves = list.map((rawId, index) => {
      const taskId = typeof rawId === 'string' ? rawId.trim() : '';
      if (!taskId) throw new Error(`taskIds[${index}]: taskId is required`);
      const { task, boardId } = findTaskOrThrow(taskId);
      assertClaimAllows(task, actorId);
      const targetColumn = resolveColumn(boardId, column);
      if (targetColumn.id === IN_PROGRESS_COLUMN_ID) assertNotesDigested(task);
      return { task, boardId, targetColumn };
    });
    const results = [];
    for (const { task, boardId, targetColumn } of moves) {
      const order = buildMoveOrder(boardId, task.id, targetColumn.id);
      emit('task.moved', { boardId, entityId: task.id, payload: { order }, actor: agentActor(actorId) });
      if (targetColumn.id === IN_PROGRESS_COLUMN_ID && !task.claimedBy) {
        const now = new Date().toISOString();
        emit('task.updated', {
          boardId,
          entityId: task.id,
          payload: { fields: { claimedBy: actorId, claimedAt: now, assignee: task.assignee || actorId, changeDate: now } },
          actor: agentActor(actorId)
        });
      }
      results.push({ taskId: task.id, key: task.key || '', boardId, column: targetColumn.id, columnName: targetColumn.name });
    }
    return ok({ moved: results.length, column: moves[0].targetColumn.id, columnName: moves[0].targetColumn.name, results });
  });

  server.registerTool('delete_task', {
    title: 'Delete task',
    description: 'Delete a task by id. A task in the Finished column cannot be deleted — the board keeps completed work, so tidying up can never erase it. Refused while another agent holds a live claim on the task, naming the holder. Pass expectedSeq to fail instead of silently overwriting when the board changed since you read it.',
    inputSchema: {
      taskId: z.string(),
      agent: z.string().optional().describe('Calling agent identity; defaults to the harness agent name'),
      expectedSeq: z.number().int().optional().describe('Fail if the board has changed since this seq')
    }
  }, async ({ taskId, agent, expectedSeq }) => {
    assertExpectedSeq(expectedSeq);
    const actorId = resolveActor(agent);
    const { task, boardId } = findTaskOrThrow(taskId);
    assertClaimAllows(task, actorId);
    const column = getColumns(boardId).find((c) => c.id === task.column);
    if (isDoneColumn(column)) throw new Error(`Task ${task.key || task.id}: a task in the Finished column cannot be deleted; completed work is kept.`);
    emit('task.deleted', { boardId, entityId: taskId, payload: {}, actor: agentActor(actorId) });
    return ok({ deleted: taskId });
  });

  // ── Columns ─────────────────────────────────────────────────────────────────

  server.registerTool('create_column', {
    title: 'Create column',
    description: 'Columns are fixed: Backlog, Human In The Loop, In Progress, Blocked, Finished. Adding a column is rejected.',
    inputSchema: {
      name: z.string(),
      color: z.string().optional(),
      wipLimit: z.number().int().optional(),
      role: z.enum(['done']).optional(),
      boardId: z.string().optional()
    }
  }, async () => {
    throw new Error('Columns are fixed: Backlog, Human In The Loop, In Progress, Blocked, Finished.');
  });

  server.registerTool('update_column', {
    title: 'Update column',
    description: 'Set a column colour or WIP limit. Column names are fixed and cannot be changed.',
    inputSchema: {
      columnId: z.string(),
      color: z.string().optional(),
      wipLimit: z.number().int().optional(),
      boardId: z.string().optional()
    }
  }, async ({ columnId, color, wipLimit, boardId }) => {
    const bid = resolveBoard(boardId);
    const column = getColumns(bid).find((c) => c.id === columnId);
    if (!column) throw new Error(`Column not found: ${columnId}`);
    const fields = {};
    if (color !== undefined) fields.color = color;
    if (wipLimit !== undefined) fields.wipLimit = wipLimit;
    if (Object.keys(fields).length === 0) throw new Error('No fields to update');
    emit('column.updated', { boardId: bid, entityId: columnId, payload: { fields }, actor: AGENT });
    return ok({ columnId, fields });
  });

  server.registerTool('delete_column', {
    title: 'Delete column',
    description: 'Columns are fixed and cannot be deleted; this tool is rejected.',
    inputSchema: { columnId: z.string(), boardId: z.string().optional() }
  }, async () => {
    throw new Error('Columns are fixed and cannot be deleted.');
  });

  server.registerTool('reorder_columns', {
    title: 'Reorder columns',
    description: 'Columns are fixed and cannot be reordered; this tool is rejected.',
    inputSchema: {
      order: z.array(z.object({ id: z.string(), order: z.number() })),
      boardId: z.string().optional()
    }
  }, async () => {
    throw new Error('Columns are fixed and cannot be reordered.');
  });

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  server.registerTool('set_blocked_reason', {
    title: 'Set blocked reason',
    description: 'Record why a task is blocked, or clear it by passing an empty reason.',
    inputSchema: { taskId: z.string(), reason: z.string().optional() }
  }, async ({ taskId, reason = '' }) => {
    const { boardId } = findTaskOrThrow(taskId);
    const now = new Date().toISOString();
    emit('task.updated', {
      boardId,
      entityId: taskId,
      payload: { fields: { blockedReason: reason, blockedAt: reason ? now : null, changeDate: now } },
      actor: AGENT
    });
    return ok({ taskId, blockedReason: reason });
  });

  server.registerTool('set_board_dates', {
    title: 'Set iteration dates',
    description: 'Set the start/end dates and the goal of an iteration. The dates and the goal show on the roadmap.',
    inputSchema: {
      boardId: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      goal: z.string().optional()
    }
  }, async ({ boardId, startDate, endDate, goal }) => {
    const bid = resolveBoard(boardId);
    const fields = {};
    if (startDate !== undefined) fields.startDate = startDate;
    if (endDate !== undefined) fields.endDate = endDate;
    if (goal !== undefined) fields.goal = goal;
    if (Object.keys(fields).length === 0) throw new Error('No fields to update');
    emit('board.updated', { boardId: bid, entityId: bid, payload: { fields }, actor: AGENT });
    return ok({ boardId: bid, fields });
  });

  server.registerTool('list_roadmap', {
    title: 'List roadmap',
    description: 'List iterations with dates, goal and task counts. Each iteration reports unfinishedTasks (tasks not in the Finished column) and isActive: the active iteration is the first one not fully finished, in group order, then by the iteration\'s position in its group. An iteration with no tasks is not fully finished.',
    inputSchema: {}
  }, async () => {
    const groups = getGroups();
    const boards = getBoards();
    const position = new Map(boards.map((board, index) => [board.id, index]));
    const groupRank = new Map(groups.map((group, index) => [group.id, index]));
    const ordered = boards.slice().sort((a, b) => {
      const rankA = groupRank.has(a.groupId) ? groupRank.get(a.groupId) : groups.length;
      const rankB = groupRank.has(b.groupId) ? groupRank.get(b.groupId) : groups.length;
      return rankA - rankB || position.get(a.id) - position.get(b.id);
    });
    const rows = new Map();
    let activeId = '';
    for (const board of ordered) {
      const row = getBoard(board.id) || {};
      const columns = getColumns(board.id);
      const doneColumnId = (columns.find((column) => column.role === 'done') || {}).id || '';
      const tasks = getTasks(board.id);
      const doneTasks = tasks.filter((task) => task.column === doneColumnId);
      const unfinishedTasks = tasks.length - doneTasks.length;
      if (!activeId && !(tasks.length > 0 && unfinishedTasks === 0)) activeId = board.id;
      rows.set(board.id, {
        id: board.id,
        name: board.name,
        groupId: board.groupId || '',
        startDate: row.startDate || '',
        endDate: row.endDate || '',
        goal: row.goal || '',
        tasks: tasks.length,
        doneTasks: doneTasks.length,
        unfinishedTasks,
        isActive: false
      });
    }
    return ok(ordered.map((board) => ({ ...rows.get(board.id), isActive: board.id === activeId })));
  });

  server.registerTool('digest_key_points', {
    title: 'Digest key points',
    description: 'Fold the human\'s notes (keyPoints) into the description: stamps digestedAt on the notes and clears the needsDigest flag. This is the only way to clear it; claim_task and moving into In Progress are refused until it runs. undigest_key_points reverses this by removing the digestedAt stamps and setting needsDigest again. Pass pointIds to stamp specific notes, or omit them to stamp every undigested note. Notes are never added, edited or removed here. Digesting also clears the task\'s isRework marker: taking the rework on is the action the marker asks for.',
    inputSchema: { taskId: z.string(), pointIds: z.array(z.string()).optional() }
  }, async ({ taskId, pointIds }) => ok(digestKeyPoints(taskId, pointIds)));

  server.registerTool('undigest_key_points', {
    title: 'Undigest key points',
    description: 'Reverse digest_key_points: removes the digestedAt stamp from the human\'s notes and sets needsDigest back to true, so claim_task and moving into In Progress are refused again until the notes are digested. Pass pointIds to restore specific notes, or omit them to restore every digested note. Notes are never added, edited or removed here.',
    inputSchema: {
      taskId: z.string(),
      pointIds: z.array(z.string()).optional(),
      agent: z.string().optional().describe('Calling agent identity; defaults to the harness agent name')
    }
  }, async ({ taskId, pointIds, agent }) => {
    const actorId = resolveActor(agent);
    const { task, boardId } = findTaskOrThrow(taskId);
    const selected = Array.isArray(pointIds) && pointIds.length > 0 ? new Set(pointIds) : null;
    const undigested = [];
    const keyPoints = (Array.isArray(task.keyPoints) ? task.keyPoints : []).map((point) => {
      if (!point || typeof point !== 'object' || !point.digestedAt) return point;
      if (selected && !selected.has(point.id)) return point;
      undigested.push(point.id);
      const { digestedAt, ...rest } = point;
      return rest;
    });
    const now = new Date().toISOString();
    emit('task.updated', {
      boardId,
      entityId: taskId,
      payload: { fields: { keyPoints, needsDigest: true, changeDate: now } },
      actor: agentActor(actorId)
    });
    return ok({ taskId, undigested });
  });

  server.registerTool('claim_task', {
    title: 'Claim task',
    description: 'Claim a task for the current subagent: a hard lock. Refused while the task still has undigested notes from the human (run digest_key_points first) and refused when another agent holds a live claim, naming the holder. Re-claiming your own task is a renewal: the claim timestamp and changeDate are refreshed, and the result says renewed. A claim whose last activity is older than the five-minute window is expired; claiming over an expired claim succeeds as a takeover and the result says tookOver.',
    inputSchema: { taskId: z.string(), agent: z.string().optional() }
  }, async ({ taskId, agent = AGENT_ID }) => {
    const { task, boardId } = findTaskOrThrow(taskId);
    assertNotesDigested(task);
    const now = new Date().toISOString();
    const holder = typeof task.claimedBy === 'string' ? task.claimedBy.trim() : '';
    if (holder && holder !== agent && !isClaimExpired(task)) {
      throw new Error(`Task ${task.key || task.id} is already claimed by ${holder} and that claim is still live; wait for it to expire or have ${holder} release it.`);
    }
    const fields = { claimedBy: agent, claimedAt: now, changeDate: now };
    if (!task.assignee) fields.assignee = agent;
    emit('task.updated', { boardId, entityId: taskId, payload: { fields }, actor: AGENT });
    if (holder && holder !== agent) {
      return ok({ taskId, key: task.key || '', claimedBy: agent, claimedAt: now, tookOver: true, previousHolder: holder, message: `Took over the expired claim from ${holder}.` });
    }
    if (holder === agent) {
      return ok({ taskId, key: task.key || '', claimedBy: agent, claimedAt: now, renewed: true, message: 'Renewed the existing claim.' });
    }
    return ok({ taskId, key: task.key || '', claimedBy: agent, claimedAt: now, message: 'Claimed.' });
  });

  server.registerTool('claim_next', {
    title: 'Claim next task',
    description: 'Atomically claim the next ready task for the calling agent, so a coordinator can dispatch without racing. Ready means: in Backlog or Human In The Loop, no undigested notes, and either unclaimed or holding an expired claim. Deterministic ordering rule: Backlog before Human In The Loop, then ascending task order, then task id. Returns claimed: false when nothing is ready; a takeover of an expired claim returns tookOver: true.',
    inputSchema: { boardId: z.string().optional(), agent: z.string().optional() }
  }, async ({ boardId, agent = AGENT_ID }) => {
    const bid = resolveBoard(boardId);
    const now = new Date();
    const task = nextReadyTask(bid, now.getTime());
    if (!task) return ok({ claimed: false, boardId: bid, reason: 'No ready task in Backlog or Human In The Loop.' });
    const holder = typeof task.claimedBy === 'string' ? task.claimedBy.trim() : '';
    const at = now.toISOString();
    const fields = { claimedBy: agent, claimedAt: at, changeDate: at };
    if (!task.assignee) fields.assignee = agent;
    emit('task.updated', { boardId: bid, entityId: task.id, payload: { fields }, actor: AGENT });
    return ok({
      claimed: true,
      taskId: task.id,
      key: task.key || '',
      boardId: bid,
      column: task.column,
      claimedBy: agent,
      claimedAt: at,
      ...(holder && holder !== agent ? { tookOver: true, previousHolder: holder } : {})
    });
  });

  server.registerTool('release_task', {
    title: 'Release task',
    description: 'Release a claimed task: clears claimedBy and keeps claimedAt so the claim duration stays derivable.',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => {
    const { boardId } = findTaskOrThrow(taskId);
    const now = new Date().toISOString();
    emit('task.updated', {
      boardId,
      entityId: taskId,
      payload: { fields: { claimedBy: '', changeDate: now } },
      actor: AGENT
    });
    return ok({ taskId, claimedBy: '' });
  });

  server.registerTool('heartbeat_task', {
    title: 'Heartbeat task',
    description: 'Keep a claim alive without changing anything else: writes only changeDate, so it counts as a sync and restarts the five-minute window. It never touches the description, the notes, the digests, the column or the claim. Allowed only for a task that is in In Progress and carries a claim, because that is the only state the stale-claim watchdog measures; every other state is refused.',
    inputSchema: { taskId: z.string() }
  }, async ({ taskId }) => {
    const { task, boardId } = findTaskOrThrow(taskId);
    if (task.column !== IN_PROGRESS_COLUMN_ID) {
      throw new Error(`Task ${task.key || task.id} is not in In Progress; the five-minute claim window is not running for it, so a heartbeat would change nothing.`);
    }
    if (!task.claimedBy && !task.claimedAt) {
      throw new Error(`Task ${task.key || task.id} has no claim; run claim_task first, or there is no claim to keep alive.`);
    }
    const now = new Date().toISOString();
    emit('task.updated', { boardId, entityId: taskId, payload: { fields: { changeDate: now } }, actor: AGENT });
    return ok({ taskId, changeDate: now });
  });

  server.registerTool('list_skills', {
    title: 'List skills',
    description: 'List the collaboration skills / usage guides the human wants the agent to follow on this board.',
    inputSchema: {}
  }, async () => ok(getSkills().map((skill) => ({ id: skill.id, name: skill.name, description: skill.description }))));

  server.registerTool('get_skill', {
    title: 'Get skill',
    description: 'Return the full text of one skill, by id or by name.',
    inputSchema: { skill: z.string() }
  }, async ({ skill }) => {
    const skills = getSkills();
    const needle = String(skill).toLowerCase();
    const found = skills.find((entry) => entry.id === skill)
      || skills.find((entry) => entry.name.toLowerCase() === needle);
    if (!found) throw new Error(`Skill not found: ${skill}`);
    return ok(found);
  });

  server.registerTool('create_skill', {
    title: 'Create skill',
    description: 'Create a collaboration skill: a usage guide the agent should follow.',
    inputSchema: { name: z.string(), description: z.string().optional(), content: z.string().optional() }
  }, async ({ name, description = '', content = '' }) => {
    const skills = getSkills();
    const skill = { id: randomUUID(), name: String(name), description, content, order: skills.length + 1 };
    setSkills([...skills, skill]);
    return ok(skill);
  });

  server.registerTool('update_skill', {
    title: 'Update skill',
    description: 'Update a skill name, description or content.',
    inputSchema: { skillId: z.string(), name: z.string().optional(), description: z.string().optional(), content: z.string().optional() }
  }, async ({ skillId, name, description, content }) => {
    const skills = getSkills();
    if (!skills.some((skill) => skill.id === skillId)) throw new Error(`Skill not found: ${skillId}`);
    const next = skills.map((skill) => (skill.id === skillId
      ? {
          ...skill,
          name: name ?? skill.name,
          description: description ?? skill.description,
          content: content ?? skill.content
        }
      : skill));
    setSkills(next);
    return ok(next.find((skill) => skill.id === skillId));
  });

  server.registerTool('delete_skill', {
    title: 'Delete skill',
    description: 'Delete a skill by id.',
    inputSchema: { skillId: z.string() }
  }, async ({ skillId }) => {
    const skills = getSkills();
    if (!skills.some((skill) => skill.id === skillId)) throw new Error(`Skill not found: ${skillId}`);
    setSkills(skills.filter((skill) => skill.id !== skillId));
    return ok({ deleted: skillId });
  });

  server.registerTool('get_board_snapshot', {
    title: 'Get raw board snapshot',
    description: 'Return the projected read model for a board (boards, tasks, columns, settings) and current event seq. Tasks omit the removed comments and relationships fields.',
    inputSchema: { boardId: z.string().optional() }
  }, async ({ boardId }) => {
    const snapshot = getSnapshot(resolveBoard(boardId));
    const tasks = (snapshot.state?.tasks || []).map(withoutRemovedFields);
    return ok({ ...snapshot, state: { ...(snapshot.state || {}), tasks } });
  });

  server.registerTool('get_settings', {
    title: 'Get board settings',
    description: 'Return the settings object for a board.',
    inputSchema: { boardId: z.string().optional() }
  }, async ({ boardId }) => ok(getSettings(resolveBoard(boardId))));

  server.registerTool('update_settings', {
    title: 'Update board settings',
    description: 'Merge fields into a board settings object (e.g. showChangeDate, locale).',
    inputSchema: {
      boardId: z.string().optional(),
      fields: z.record(z.string(), z.any())
    }
  }, async ({ boardId, fields }) => {
    const bid = resolveBoard(boardId);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields must be an object');
    emit('settings.updated', { boardId: bid, entityId: bid, payload: { fields }, actor: AGENT });
    return ok({ boardId: bid, fields });
  });

  server.registerTool('list_events', {
    title: 'List recent events',
    description: 'Return the most recent domain events (the audit trail), oldest first.',
    inputSchema: { limit: z.number().int().optional() }
  }, async ({ limit }) => ok(getRecentEvents(limit)));

  server.registerTool('wait_for_event', {
    title: 'Wait for the next event',
    description: 'Wait until a domain event is appended after the sequence number you have already seen, then return it. Resolves on the next append rather than polling — no list_events loop. Optional type and boardId filters narrow the wait, for example to a worker\'s own board. When no matching event arrives within timeoutMs the wait ends cleanly with timedOut: true and the current seq; timeoutMs is capped at 30000 ms (default 15000). The append listener is removed when the wait ends, so repeated calls leak nothing.',
    inputSchema: {
      since: z.number().int().describe('The seq you have already seen; the wait resolves on an event with a greater seq'),
      timeoutMs: z.number().int().optional().describe('Upper bound in milliseconds, capped at 30000; defaults to 15000'),
      type: z.string().optional().describe('Only resolve for this event type, e.g. task.updated'),
      boardId: z.string().optional().describe('Only resolve for events on this board')
    }
  }, async ({ since, timeoutMs, type = '', boardId = '' }) => {
    const bounded = Math.max(1, Math.min(MAX_WAIT_MS, Number.isFinite(timeoutMs) ? timeoutMs : 15000));
    const event = await waitForEvent({ since, timeoutMs: bounded, type, boardId });
    if (!event) return ok({ timedOut: true, seq: getSeq(), since });
    return ok({
      timedOut: false,
      seq: event.seq,
      since,
      event: {
        seq: event.seq,
        type: event.type,
        boardId: event.board_id,
        entityId: event.entity_id,
        at: event.at,
        actor: event.actor,
        payload: event.payload
      }
    });
  });
}
