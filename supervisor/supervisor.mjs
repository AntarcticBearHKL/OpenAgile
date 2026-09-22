// OpenAgile supervisor.
//
// One supervisor per board owns the lease and all board writes while a short-lived
// worker process performs a single turn. Workers never talk to MCP; the supervisor
// claims, moves to In Progress, heartbeats for the whole time the task is in flight,
// and releases when the worker is done.
//
// The journal is the durable audit: every decision is appended. list_events is not
// used as a record because compaction truncates it.
//
// Project-agnostic: the only project-specific input is config — the board, the agent
// name, and the shell command that runs a worker turn.

import { spawn, spawnSync } from 'node:child_process';

const COLUMN_IDS = {
  backlog: '00000000-0000-4000-8000-000000000030',
  human: '00000000-0000-4000-8000-000000000034',
  inProgress: '00000000-0000-4000-8000-000000000031',
  blocked: '00000000-0000-4000-8000-000000000032',
  finished: '00000000-0000-4000-8000-000000000033'
};

const AUTO_BLOCK_FRAGMENT = 'no agent sync for over 5 minutes';

const DEFAULTS = {
  agentName: 'openagile-supervisor',
  workerTimeoutMs: 30 * 60 * 1000,
  heartbeatIntervalMs: 2 * 60 * 1000,
  heartbeatSummaryEvery: 5,
  maxConcurrentTasks: 1,
  pollIntervalMs: 5000,
  casRetries: 3,
  idempotencyPrefix: 'supervisor',
  requireReport: true,
  reportEvidencePattern: ''
};

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function isConflict(err) {
  return /conflict/i.test(String(err?.message || ''));
}

function noteText(point) {
  if (!point || typeof point !== 'object') return '';
  return String(point.text ?? point.note ?? point.content ?? point.title ?? '').trim();
}

export function createSupervisor({ client, journal, config = {}, logger } = {}) {
  if (!client || typeof client.call !== 'function') throw new Error('createSupervisor requires an MCP client');
  if (!journal || typeof journal.append !== 'function') throw new Error('createSupervisor requires a journal');

  const cfg = { ...DEFAULTS, ...config };
  const log = (level, message, extra) => {
    const sink = logger?.[level] || logger?.log || console[level] || console.log;
    try { sink.call(logger || console, message, ...(extra === undefined ? [] : [extra])); }
    catch { /* a logger must never break the loop */ }
  };
  const idempotencyPrefix = nonEmpty(cfg.idempotencyPrefix, DEFAULTS.idempotencyPrefix);
  const agentName = nonEmpty(cfg.agentName, DEFAULTS.agentName);

  let boardId = '';
  let columnById = new Map();
  let stopping = false;
  let running = null;
  let wakeLoop = null;
  const inflight = new Map();
  // Tasks this process has already finalised (finished or failed). Without this a
  // failed task still briefly looks "claimed by us" while it is being blocked, and
  // the scheduler would treat it as a resume and retry it in a tight loop.
  const settled = new Set();

  // ── small helpers ───────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { wakeLoop = null; resolve(); }, ms);
      wakeLoop = () => { clearTimeout(timer); wakeLoop = null; resolve(); };
    });
  }

  function wake() {
    if (wakeLoop) wakeLoop();
  }

  function columnNameOf(task) {
    const known = columnById.get(task?.column);
    return known?.name || task?.columnName || task?.column || '';
  }

  async function getTask(taskId) {
    const result = await client.call('get_task', { taskId });
    if (!result?.task) return null;
    return { ...result.task, boardId: result.boardId || boardId, columnName: result.columnName || '' };
  }

  async function boardSeq() {
    const snapshot = await client.call('get_board_snapshot', { boardId });
    return Number.isFinite(snapshot?.seq) ? snapshot.seq : 0;
  }

  async function loadColumns() {
    const columns = await client.call('list_columns', { boardId });
    columnById = new Map((Array.isArray(columns) ? columns : []).map((column) => [column.id, column]));
    return columnById;
  }

  // Optimistic concurrency: read the seq, attempt the write, and on a Conflict
  // re-read and retry. Bounded so a hot board cannot spin forever.
  async function writeWithCas(name, buildArgs) {
    let lastError;
    for (let attempt = 0; attempt <= cfg.casRetries; attempt += 1) {
      const expectedSeq = await boardSeq();
      try {
        return await client.call(name, buildArgs(expectedSeq));
      } catch (err) {
        lastError = err;
        if (isConflict(err) && attempt < cfg.casRetries) continue;
        throw err;
      }
    }
    throw lastError;
  }

  // For updates whose payload is derived from a fresh read (description appends),
  // re-read on conflict so a retry never writes stale content.
  async function updateDerived(taskId, buildFields) {
    let lastError;
    for (let attempt = 0; attempt <= cfg.casRetries; attempt += 1) {
      const task = await getTask(taskId);
      if (!task) throw new Error(`Task ${taskId} disappeared before update`);
      const fields = buildFields(task);
      if (!fields) return null;
      const expectedSeq = await boardSeq();
      try {
        return await client.call('update_task', { taskId, ...fields, agent: agentName, expectedSeq });
      } catch (err) {
        lastError = err;
        if (isConflict(err) && attempt < cfg.casRetries) continue;
        throw err;
      }
    }
    throw lastError;
  }

  function moveWithCas(taskId, column) {
    return writeWithCas('move_task', (expectedSeq) => ({ taskId, column, agent: agentName, expectedSeq }));
  }

  // ── digest gate ─────────────────────────────────────────────────────────────

  function pendingNotes(task) {
    const points = Array.isArray(task?.keyPoints) ? task.keyPoints : [];
    return points.filter((point) => !point?.digestedAt);
  }

  function hasPendingNotes(task) {
    return task?.needsDigest === true || pendingNotes(task).length > 0;
  }

  async function digestTask(task) {
    const pending = pendingNotes(task);
    if (pending.length > 0) {
      await updateDerived(task.id, (fresh) => {
        const current = typeof fresh.description === 'string' ? fresh.description : '';
        const lines = [`\n\n## Notes folded into the description`];
        for (const point of pending) {
          const text = noteText(point) || '(empty note)';
          lines.push(`- ${text}`);
        }
        return { description: `${current}${lines.join('\n')}` };
      });
    }
    await client.call('digest_key_points', { taskId: task.id });
    journal.append({ type: 'digested', taskId: task.id, key: task.key || '', points: pending.length });
  }

  // ── board resolution / reconcile ────────────────────────────────────────────

  async function resolveBoard() {
    const boards = await client.call('list_boards', {});
    const list = Array.isArray(boards) ? boards : [];

    if (cfg.boardId) {
      if (!list.some((board) => board.id === cfg.boardId)) {
        throw new Error(`config.boardId ${cfg.boardId} was not found`);
      }
      return cfg.boardId;
    }

    let groupId = nonEmpty(cfg.groupId, '');
    if (!groupId && nonEmpty(cfg.groupName, '')) {
      const groups = await client.call('list_groups', {});
      const match = (groups.groups || []).find((group) => group.name === cfg.groupName);
      if (match) {
        groupId = match.id;
      } else if (cfg.createBoardIfMissing !== false) {
        const created = await client.call('create_group', { name: cfg.groupName });
        groupId = created.id;
        journal.append({ type: 'group-created', groupId, name: cfg.groupName, idempotencyKey: `${idempotencyPrefix}:group:${cfg.groupName}` });
      }
    }

    if (!groupId) {
      const groups = await client.call('list_groups', {});
      const all = groups.groups || [];
      if (all.length === 0) throw new Error('no groups exist; set config.boardId, or create a group and set groupId');
      groupId = all[all.length - 1].id;
    }

    const existing = list.filter((board) => board.groupId === groupId);
    if (existing.length) return existing[existing.length - 1].id;

    if (cfg.createBoardIfMissing === false) {
      throw new Error(`group ${groupId} has no iteration; set createBoardIfMissing true or provide boardId`);
    }
    const created = await client.call('create_board', { groupId });
    journal.append({ type: 'board-created', boardId: created.id, groupId, idempotencyKey: `${idempotencyPrefix}:board:${groupId}` });
    return created.id;
  }

  // From the persisted lease table, find tasks this supervisor held. Re-claim
  // (a stale claim can be taken over), recover an auto-blocked task, and never
  // leave a task stranded In Progress while unclaimed. The scheduler then picks
  // up anything still workable and redispatches it.
  async function reconcile() {
    const leases = journal.getLeases();
    for (const [taskId, lease] of Object.entries(leases)) {
      if (!lease) continue;
      if (lease.agent && lease.agent !== agentName) continue;
      if (lease.boardId && lease.boardId !== boardId) continue;

      let task = null;
      try { task = await getTask(taskId); } catch { task = null; }
      if (!task) {
        journal.append({ type: 'reconcile', taskId, outcome: 'task-missing', action: 'clear-lease' });
        journal.setLease(taskId, null);
        continue;
      }

      const column = columnNameOf(task).toLowerCase();

      if (column === 'finished') {
        journal.append({ type: 'reconcile', taskId, key: task.key || '', outcome: 'finished' });
        journal.setLease(taskId, null);
        continue;
      }

      if (column === 'blocked') {
        const reason = task.blockedReason || '';
        if (reason.includes(AUTO_BLOCK_FRAGMENT)) {
          if (hasPendingNotes(task)) await digestTask(task);
          const target = hasPendingNotes(task) ? COLUMN_IDS.backlog : COLUMN_IDS.inProgress;
          await moveWithCas(taskId, target);
          await client.call('set_blocked_reason', { taskId, reason: '' });
          journal.append({ type: 'reconcile', taskId, key: task.key || '', outcome: 'auto-block-recovered', action: target });
        } else {
          journal.append({ type: 'reconcile', taskId, key: task.key || '', outcome: 'blocked-by-human', action: 'leave', reason });
          journal.setLease(taskId, null);
        }
        continue;
      }

      try {
        const claim = await client.call('claim_task', { taskId, agent: agentName });
        journal.append({
          type: 'reconcile',
          taskId,
          key: task.key || '',
          outcome: 'reclaimed',
          renewed: claim?.renewed === true,
          tookOver: claim?.tookOver === true
        });
      } catch (err) {
        journal.append({ type: 'reconcile', taskId, key: task.key || '', outcome: 'claim-refused', message: err.message });
        journal.setLease(taskId, null);
        continue;
      }

      if (column !== 'in progress') {
        if (hasPendingNotes(task)) await digestTask(task);
        await moveWithCas(taskId, COLUMN_IDS.inProgress);
      }
    }
  }

  // ── scheduler ───────────────────────────────────────────────────────────────

  function candidateRank(task) {
    const column = columnNameOf(task).toLowerCase();
    if (column === 'human in the loop') return 0;
    if (column === 'backlog') return 1;
    return 2; // In Progress means we own it and the worker died: resume it
  }

  function isCandidate(task) {
    if (!task?.id || inflight.has(task.id)) return false;
    const column = columnNameOf(task).toLowerCase();
    if (column !== 'backlog' && column !== 'human in the loop' && column !== 'in progress') return false;

    // A task settled earlier in this process is not retried where it was left —
    // but a task deliberately requeued to Backlog / Human In The Loop is new work.
    if (settled.has(task.id) && column !== 'backlog' && column !== 'human in the loop') return false;

    if (task.claimedBy) {
      if (task.claimedBy !== agentName) return task.claimExpired === true; // only an expired claim may be taken over
      return true; // ours: renewal or resume
    }
    return true; // unclaimed
  }

  async function listCandidates() {
    const [ready, needingDigest, mine] = await Promise.all([
      client.call('list_tasks', { boardId, ready: true }),
      client.call('list_tasks', { boardId, needsDigest: true }),
      client.call('list_tasks', { boardId, claimedBy: agentName })
    ]);

    const byId = new Map();
    for (const list of [ready, needingDigest, mine]) {
      for (const task of Array.isArray(list) ? list : []) {
        // list_tasks rows do not expose keyPoints; the full read happens in startTask.
        if (!byId.has(task.id)) byId.set(task.id, task);
      }
    }

    return [...byId.values()]
      .filter(isCandidate)
      .sort((a, b) => candidateRank(a) - candidateRank(b)
        || ((a.order ?? 0) - (b.order ?? 0))
        || String(a.id).localeCompare(String(b.id)));
  }

  async function tick() {
    if (stopping || inflight.size >= cfg.maxConcurrentTasks) return;
    const candidates = await listCandidates();
    const picked = candidates.find((task) => !inflight.has(task.id));
    if (!picked) return;
    await startTask(picked);
  }

  // ── dispatch ────────────────────────────────────────────────────────────────

  async function startTask(candidate) {
    const task = await getTask(candidate.id);
    if (!task) return;

    // Re-check after the fresh read: the task may have been finalised between the
    // candidate scan and here (see `settled`).
    const freshColumn = columnNameOf(task).toLowerCase();
    if (settled.has(task.id) && freshColumn !== 'backlog' && freshColumn !== 'human in the loop') {
      journal.append({ type: 'skipped', taskId: task.id, key: task.key || '', reason: 'settled-earlier-this-run', column: columnNameOf(task) });
      return;
    }

    journal.append({
      type: 'picked',
      taskId: task.id,
      key: task.key || '',
      boardId,
      column: columnNameOf(task),
      order: Number.isFinite(task.order) ? task.order : null,
      source: 'scheduler'
    });

    // 1. Digest gate: fold human notes into the description before claiming.
    if (hasPendingNotes(task)) await digestTask(task);

    // 2. Claim (renewal if we already hold it).
    const claim = await client.call('claim_task', { taskId: task.id, agent: agentName });
    journal.append({
      type: 'claimed',
      taskId: task.id,
      key: task.key || '',
      agent: agentName,
      renewed: claim?.renewed === true,
      tookOver: claim?.tookOver === true
    });

    // 3. Move into In Progress (already-claimed tasks skip a no-op move).
    if (columnNameOf(task).toLowerCase() !== 'in progress') {
      await moveWithCas(task.id, COLUMN_IDS.inProgress);
      journal.append({ type: 'moved', taskId: task.id, key: task.key || '', to: 'In Progress', reason: 'start' });
    }

    // 4. Record the lease (dispatchedAt/workerPid are filled once spawned).
    const lease = {
      taskId: task.id,
      agent: agentName,
      boardId,
      claimedAt: claim?.claimedAt || new Date().toISOString(),
      dispatchedAt: null,
      workerPid: null
    };
    journal.setLease(task.id, lease);
    journal.append({
      type: 'dispatched',
      taskId: task.id,
      key: task.key || '',
      boardId,
      command: cfg.workerCommand,
      idempotencyKey: `${idempotencyPrefix}:dispatch:${task.id}`
    });
    spawnWorker(task, lease);
  }

  function workerEnv(task) {
    return {
      ...process.env,
      OPENAGILE_TASK_ID: task.id,
      OPENAGILE_TASK_KEY: task.key || '',
      OPENAGILE_BOARD_ID: boardId,
      OPENAGILE_TASK_TITLE: task.title || '',
      OPENAGILE_TASK_DESCRIPTION: task.description || ''
    };
  }

  function spawnWorker(task, lease) {
    const command = nonEmpty(cfg.workerCommand, '');
    if (!command) {
      const reason = 'workerCommand is not configured';
      journal.append({ type: 'error', phase: 'dispatch', taskId: task.id, message: reason });
      onWorkerDone(makeRecord(task, null, lease), null, new Error(reason));
      return;
    }

    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: cfg.workerCwd || process.cwd(),
        env: workerEnv(task),
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      onWorkerDone(makeRecord(task, null, lease), null, err);
      return;
    }

    const record = makeRecord(task, child, lease);
    inflight.set(task.id, record);

    lease.dispatchedAt = new Date().toISOString();
    lease.workerPid = child.pid ?? null;
    journal.setLease(task.id, lease);

    child.stdout?.on('data', (chunk) => { record.stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { record.stderr += chunk.toString(); });

    record.heartbeatTimer = setInterval(() => beat(record), cfg.heartbeatIntervalMs);
    record.timeoutTimer = setTimeout(() => onTimeout(record), cfg.workerTimeoutMs);

    child.on('error', (err) => { onWorkerDone(record, null, err); });
    child.on('close', (code) => { onWorkerDone(record, code, null); });
  }

  function makeRecord(task, child, lease) {
    return {
      taskId: task.id,
      key: task.key || '',
      child,
      lease,
      stdout: '',
      stderr: '',
      startedAt: Date.now(),
      heartbeatCount: 0,
      lastBeatAt: null,
      heartbeatTimer: null,
      timeoutTimer: null,
      finished: false
    };
  }

  // The supervisor — not the worker turn — keeps the claim alive. Journal a line on
  // the first beat and then every N beats; a final summary is written when the task
  // leaves the supervisor's hands. Never one line per beat.
  function beat(record) {
    if (record.finished) return;
    record.heartbeatCount += 1;
    client.call('heartbeat_task', { taskId: record.taskId })
      .then(() => {
        record.lastBeatAt = new Date().toISOString();
        const n = record.heartbeatCount;
        if (n === 1 || n % cfg.heartbeatSummaryEvery === 0) {
          journal.append({ type: 'heartbeat', taskId: record.taskId, key: record.key, count: n, at: record.lastBeatAt });
        }
      })
      .catch((err) => {
        journal.append({ type: 'error', phase: 'heartbeat', taskId: record.taskId, message: err.message });
      });
  }

  function killWorker(child) {
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  function onTimeout(record) {
    if (record.finished) return;
    const message = `worker timed out after ${cfg.workerTimeoutMs} ms`;
    journal.append({ type: 'error', phase: 'timeout', taskId: record.taskId, key: record.key, timeoutMs: cfg.workerTimeoutMs });
    killWorker(record.child);
    onWorkerDone(record, null, new Error(message));
  }

  function appendReport(existing, report, task) {
    const base = typeof existing === 'string' ? existing : '';
    const body = report && report.trim() ? report.trim() : '(worker produced no stdout)';
    const stamp = new Date().toISOString();
    const header = `### Worker report — ${task.key || task.id} (${stamp})`;
    return `${base}${base.trim() ? '\n\n---\n' : ''}${header}\n${body}`;
  }

  // A worker that exits 0 with nothing verifiable in its report is a failure, not a
  // completion: the board must never record "done" for an unverifiable turn.
  function reportGateFailure(report) {
    const text = typeof report === 'string' ? report.trim() : '';
    if (cfg.requireReport !== false && !text) {
      return 'worker exited 0 but produced no report; nothing to verify';
    }
    const pattern = nonEmpty(cfg.reportEvidencePattern, '');
    if (pattern && !new RegExp(pattern, 'i').test(text)) {
      return `worker exited 0 but its report does not match the required evidence pattern /${pattern}/i`;
    }
    return null;
  }

  async function finishTask(record) {
    const report = record.stdout;
    const gate = reportGateFailure(report);
    if (gate) {
      journal.append({ type: 'error', phase: 'evidence-gate', taskId: record.taskId, key: record.key, message: gate });
      await failTask(record, 0, new Error(gate));
      return;
    }
    await updateDerived(record.taskId, (task) => {
      const next = appendReport(task.description, report, task);
      return next === (task.description || '') ? null : { description: next };
    });
    journal.append({
      type: 'report',
      taskId: record.taskId,
      key: record.key,
      exitCode: 0,
      durationMs: Date.now() - record.startedAt,
      chars: report.length,
      report: report.trim()
    });
    await moveWithCas(record.taskId, COLUMN_IDS.finished);
    journal.append({ type: 'moved', taskId: record.taskId, key: record.key, to: 'Finished', reason: 'worker-complete' });
    await release(record.taskId);
  }

  async function failTask(record, code, error) {
    const durationMs = Date.now() - record.startedAt;
    const reason = error && /timed out/.test(error.message)
      ? error.message
      : `Worker failed (exit code ${code === null || code === undefined ? 'none' : code}) after ${Math.round(durationMs / 1000)}s${error ? `: ${error.message}` : ''}`;
    const short = String(reason).slice(0, 300);

    journal.append({
      type: 'error',
      phase: 'worker',
      taskId: record.taskId,
      key: record.key,
      exitCode: code ?? null,
      durationMs,
      message: short,
      stderr: record.stderr.slice(-2000)
    });

    await moveWithCas(record.taskId, COLUMN_IDS.blocked);
    journal.append({ type: 'moved', taskId: record.taskId, key: record.key, to: 'Blocked', reason: 'worker-failed' });
    await client.call('set_blocked_reason', { taskId: record.taskId, reason: short });
    journal.append({ type: 'blocked', taskId: record.taskId, key: record.key, reason: short });
    await release(record.taskId);
  }

  async function release(taskId) {
    try {
      await client.call('release_task', { taskId });
      journal.append({ type: 'released', taskId });
    } catch (err) {
      journal.append({ type: 'error', phase: 'release', taskId, message: err.message });
    }
  }

  async function onWorkerDone(record, code, error) {
    if (!record || record.finished) return;
    record.finished = true;
    // Mark settled synchronously, before any await, so a concurrent tick cannot
    // re-pick the task while it is being finalised.
    settled.add(record.taskId);
    inflight.delete(record.taskId);
    if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
    if (record.timeoutTimer) clearTimeout(record.timeoutTimer);

    journal.append({
      type: 'heartbeat-summary',
      taskId: record.taskId,
      key: record.key,
      count: record.heartbeatCount,
      lastAt: record.lastBeatAt
    });

    const failed = Boolean(error) || (code !== 0 && code !== null && code !== undefined);
    try {
      if (failed) await failTask(record, code, error);
      else await finishTask(record);
    } catch (err) {
      journal.append({ type: 'error', phase: 'finalize', taskId: record.taskId, key: record.key, message: err.message });
      log('error', `finalize failed for ${record.key || record.taskId}: ${err.message}`);
    } finally {
      journal.setLease(record.taskId, null);
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  function publicConfig() {
    return {
      mcpUrl: cfg.mcpUrl,
      agentName,
      boardId: cfg.boardId || null,
      groupId: cfg.groupId || null,
      workerCommand: cfg.workerCommand,
      workerTimeoutMs: cfg.workerTimeoutMs,
      heartbeatIntervalMs: cfg.heartbeatIntervalMs,
      pollIntervalMs: cfg.pollIntervalMs,
      maxConcurrentTasks: cfg.maxConcurrentTasks,
      idempotencyPrefix
    };
  }

  async function setup() {
    boardId = await resolveBoard();
    await loadColumns();
  }

  function start() {
    if (running) return running;
    stopping = false;

    running = (async () => {
      await setup();
      journal.append({ type: 'started', boardId, agent: agentName, pid: process.pid, config: publicConfig() });
      log('info', `supervisor started — agent=${agentName} board=${boardId}`);

      await reconcile();

      while (!stopping) {
        try {
          await tick();
        } catch (err) {
          journal.append({ type: 'error', phase: 'tick', message: err?.message || String(err) });
          log('warn', `tick failed: ${err?.message || err}`);
        }
        if (stopping) break;
        await sleep(cfg.pollIntervalMs);
      }

      journal.append({ type: 'stopped', reason: 'loop-ended' });
      log('info', 'supervisor loop ended');
    })();

    running.catch((err) => {
      journal.append({ type: 'error', phase: 'fatal', message: err?.message || String(err) });
      log('error', `supervisor failed: ${err?.message || err}`);
    });

    return running;
  }

  async function stop() {
    if (!running) {
      stopping = true;
      return;
    }
    if (stopping) {
      await running.catch(() => {});
      return;
    }
    stopping = true;
    wake();

    const finalizers = [];
    for (const record of inflight.values()) {
      if (record.finished) continue;
      killWorker(record.child);
      finalizers.push(onWorkerDone(record, null, new Error('supervisor stopped before the worker finished')));
    }
    if (finalizers.length) {
      await Promise.race([
        Promise.allSettled(finalizers),
        new Promise((resolve) => setTimeout(resolve, 8000))
      ]);
    }

    await running.catch(() => {});
    journal.append({ type: 'stopped', reason: 'stop()' });
    log('info', 'supervisor stopped');
  }

  return { start, stop };
}
