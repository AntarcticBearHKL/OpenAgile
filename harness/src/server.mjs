// OpenAgile harness — ONE port serving:
//   • the built frontend (client/dist)
//   • MCP over Streamable HTTP at /mcp
//   • a browser bridge: GET /api/stream (SSE), POST /api/events, GET /api/snapshot
//
// Both the human UI and the AI agent mutate the SAME server-side event log
// (store.mjs), which projects through the client's pure reducer.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { DEFAULT_BOARD_ID, getBoards, getEventsSince, getGroupsState, getSeq, getSkillsState, getSnapshot, getStats, initStore, flushStore, setBoardGroupMap, setGroups, setSkills, sweepStaleClaims } from './store.mjs';
import { renderAgentJson, renderSkillDoc } from './skill-doc.mjs';
import { registerTools } from './mcp-tools.mjs';
import { appendBridgeEvents, bridgeRequestDenial } from './bridge.mjs';

process.on('uncaughtException', (err) => console.error('[harness] uncaught', err));
process.on('unhandledRejection', (err) => console.error('[harness] unhandled rejection', err));

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(HERE, '..', '..', 'client', 'dist');
const HOST = process.env.OPENAGILE_HOST || '127.0.0.1';
const PORT = Number(process.env.OPENAGILE_PORT || process.env.PORT || 8787);
const VERSION = '1.0.0';
const CLAIM_WATCHDOG_INTERVAL_MS = 30_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJsonBody(req, limit = 4_000_000) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { rejectBody(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolveBody(undefined); return; }
      try { resolveBody(JSON.parse(raw)); } catch (err) { rejectBody(err); }
    });
    req.on('error', rejectBody);
  });
}

// ── SSE bridge ────────────────────────────────────────────────────────────────

const sseClients = new Set();

function writeSse(res, event) {
  try { res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
}

function setupSse(req, res, url) {
  const since = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0) || 0;
  const clientId = url.searchParams.get('clientId') || '';
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  const client = { res, clientId };
  sseClients.add(client);
  for (const event of getEventsSince(since)) writeSse(res, event);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20_000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
}

function broadcast(events, originClientId) {
  if (events.length === 0) return;
  for (const client of sseClients) {
    if (originClientId && client.clientId === originClientId) continue;
    for (const event of events) writeSse(client.res, event);
  }
}

function broadcastGroups() {
  const payload = JSON.stringify(getGroupsState());
  for (const client of sseClients) {
    try { client.res.write(`event: groups\ndata: ${payload}\n\n`); } catch { /* client gone */ }
  }
}

function broadcastSkills() {
  const payload = JSON.stringify(getSkillsState());
  for (const client of sseClients) {
    try { client.res.write(`event: skills\ndata: ${payload}\n\n`); } catch { /* client gone */ }
  }
}

// ── MCP over Streamable HTTP ──────────────────────────────────────────────────

const transports = new Map();

async function handleMcp(req, res) {
  const method = req.method;

  if (method === 'POST') {
    let parsedBody;
    try {
      parsedBody = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId).handleRequest(req, res, parsedBody);
      return;
    }

    if (!sessionId && isInitializeRequest(parsedBody)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports.set(sid, transport); },
        enableJsonResponse: true
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      const server = new McpServer({ name: 'openagile-harness', version: VERSION });
      registerTools(server, { broadcastGroups });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    sendJson(res, sessionId ? 404 : 400, {
      jsonrpc: '2.0',
      error: { code: -32000, message: sessionId ? 'Session not found' : 'Bad Request: Mcp-Session-Id required' },
      id: null
    });
    return;
  }

  if (method === 'GET' || method === 'DELETE') {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports.has(sessionId)) {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing session' }, id: null });
      return;
    }
    await transports.get(sessionId).handleRequest(req, res);
    return;
  }

  res.writeHead(405, { allow: 'GET, POST, DELETE' });
  res.end();
}

// ── Static files ──────────────────────────────────────────────────────────────

async function serveStatic(res, pathname) {
  if (!existsSync(DIST_DIR)) {
    sendJson(res, 503, { error: 'client/dist not built. Run: cd client && npm run build' });
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = resolve(DIST_DIR, `.${rel}`);
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    // Extensionless route → SPA entry; otherwise 404.
    if (!extname(rel)) {
      try {
        const data = await readFile(join(DIST_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      } catch { /* fall through */ }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ── Main request router ───────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const path = url.pathname;

  try {
    if (path === '/mcp') { await handleMcp(req, res); return; }

    if (path === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { code: 200, message: 'API is healthy.', data: {} });
      return;
    }

    if (path === '/api/harness' && req.method === 'GET') {
      sendJson(res, 200, { harness: true, name: 'openagile-harness', version: VERSION, defaultBoardId: DEFAULT_BOARD_ID, ...getStats() });
      return;
    }

    if (path === '/api/groups' && req.method === 'GET') {
      sendJson(res, 200, getGroupsState());
      return;
    }

    if (path === '/api/groups' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (!Array.isArray(body?.groups)) {
        sendJson(res, 400, { error: 'groups must be an array' });
        return;
      }
      if (body.boardGroups !== undefined && (typeof body.boardGroups !== 'object' || body.boardGroups === null || Array.isArray(body.boardGroups))) {
        sendJson(res, 400, { error: 'boardGroups must be an object' });
        return;
      }
      setGroups(body.groups);
      setBoardGroupMap(body.boardGroups);
      broadcastGroups();
      sendJson(res, 200, getGroupsState());
      return;
    }

    if (path === '/api/skills' && req.method === 'GET') {
      sendJson(res, 200, getSkillsState());
      return;
    }

    if (path === '/api/skills' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      if (!Array.isArray(body?.skills)) {
        sendJson(res, 400, { error: 'skills must be an array' });
        return;
      }
      setSkills(body.skills);
      broadcastSkills();
      sendJson(res, 200, getSkillsState());
      return;
    }

    if (path === '/skill/openagile.md' && req.method === 'GET') {
      const payload = Buffer.from(renderSkillDoc({ group: url.searchParams.get('group') || '' }), 'utf8');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-cache' });
      res.end(payload);
      return;
    }

    if (path === '/skill/agent.json' && req.method === 'GET') {
      sendJson(res, 200, renderAgentJson({ origin: `http://${req.headers.host || `${HOST}:${PORT}`}` }));
      return;
    }

    if (path === '/api/stream' && req.method === 'GET') { setupSse(req, res, url); return; }

    if (path === '/api/snapshot' && req.method === 'GET') {
      const requested = url.searchParams.get('boardId') || getBoards()[0]?.id || DEFAULT_BOARD_ID;
      sendJson(res, 200, getSnapshot(requested));
      return;
    }

    if (path === '/api/events' && req.method === 'POST') {
      const denial = bridgeRequestDenial(req);
      if (denial) { sendJson(res, 403, { ok: false, error: denial }); return; }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Invalid JSON body' });
        return;
      }
      try {
        const appended = appendBridgeEvents(body);
        broadcast(appended, url.searchParams.get('clientId') || '');
        sendJson(res, 200, { ok: true, appended: appended.length, seq: getSeq() });
      } catch (err) {
        sendJson(res, 422, { ok: false, error: err?.message || 'Event refused' });
      }
      return;
    }

    if (path.startsWith('/api/')) { sendJson(res, 404, { error: 'Not found' }); return; }

    await serveStatic(res, path);
  } catch (err) {
    console.error('[harness] request failed', path, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ── Claim watchdog ────────────────────────────────────────────────────────────

let claimWatchdogTimer = null;

export function startClaimWatchdog() {
  if (claimWatchdogTimer) return;
  claimWatchdogTimer = setInterval(() => {
    try { sweepStaleClaims(); } catch (err) { console.error('[harness] claim watchdog failed', err); }
  }, CLAIM_WATCHDOG_INTERVAL_MS);
  claimWatchdogTimer.unref(); // never hold the process open
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const boot = initStore();
startClaimWatchdog();
const httpServer = createServer((req, res) => { handleRequest(req, res); });

httpServer.listen(PORT, HOST, () => {
  console.log(`[harness] listening on http://${HOST}:${PORT}`);
  console.log(`[harness]   frontend : http://${HOST}:${PORT}/`);
  console.log(`[harness]   MCP      : http://${HOST}:${PORT}/mcp`);
  console.log(`[harness]   SSE      : http://${HOST}:${PORT}/api/stream`);
  console.log(`[harness]   distill  : ${existsSync(DIST_DIR) ? DIST_DIR : 'MISSING (run client build)'}`);
  console.log(`[harness]   board    : ${boot.boardId} (events: ${boot.events}, seq: ${boot.seq})`);
});

function shutdown(signal) {
  console.log(`[harness] ${signal} — flushing store and exiting`);
  clearInterval(claimWatchdogTimer);
  claimWatchdogTimer = null;
  try { flushStore(); } catch { /* ignore */ }
  for (const client of sseClients) { try { client.res.end(); } catch { /* ignore */ } }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
