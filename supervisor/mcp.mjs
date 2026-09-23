// Streamable HTTP MCP client for the OpenAgile MCP server.
//
// The protocol is deliberately small and a little unusual:
//   • initialize -> read the `mcp-session-id` response header -> notifications/initialized
//   • every later POST carries the session header
//   • a response is either plain JSON or an SSE stream (`data: {...}` lines)
//   • tool failures are NOT JSON-RPC errors: they arrive as result.isError === true
//     with the message in result.content[0].text
//
// No third-party dependencies: Node's built-in fetch is the transport.

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_VERSION = '1.0.0';

// The server answers a request whose session it no longer knows with either
// { code:-32000, message:'Bad Request: Mcp-Session-Id required' } (no header) or
// { code:-32001, message:'Session not found' } (stale header). Both mean the same
// thing to a caller: re-initialize and retry once.
function isDeadSessionError(code, message) {
  const text = String(message || '');
  if (/Mcp-Session-Id/i.test(text)) return true;
  if (/Session not found/i.test(text)) return true;
  return (code === -32000 || code === -32001) && /session/i.test(text);
}

function deadSessionError(message, code) {
  const err = new Error(message || 'MCP session is not usable');
  err.code = code;
  err.deadSession = true;
  return err;
}

// Read one Streamable HTTP response body. Returns the last JSON-RPC message it
// carried, or null for an empty body (e.g. a notification's 202 Accepted).
async function parseStreamableResponse(res) {
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();

  if (contentType.includes('text/event-stream')) {
    const messages = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .join('\n');
      if (!data) continue;
      try { messages.push(JSON.parse(data)); } catch { /* keep-alive / priming comment */ }
    }
    return messages.length ? messages[messages.length - 1] : null;
  }

  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

export function createMcpClient({ url, clientName = 'openagile-supervisor', token = '' } = {}) {
  if (!url || typeof url !== 'string') throw new Error('createMcpClient requires a url');

  const auth = typeof token === 'string' && token.trim() ? { authorization: `Bearer ${token.trim()}` } : {};

  let sessionId = null;
  let nextId = 1;

  function headers() {
    const base = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...auth
    };
    if (sessionId) base['mcp-session-id'] = sessionId;
    return base;
  }

  async function post(body) {
    return fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  }

  async function initialize() {
    sessionId = null;
    const res = await post({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: CLIENT_VERSION }
      }
    });

    const sid = res.headers.get('mcp-session-id');
    const message = await parseStreamableResponse(res);

    if (message && message.error) {
      const err = new Error(`MCP initialize failed: ${message.error.message || 'unknown error'}`);
      err.code = message.error.code;
      throw err;
    }
    if (!sid) throw new Error('MCP initialize returned no mcp-session-id response header');
    sessionId = sid;

    // The initialized notification has no id and no useful body.
    const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await ack.text().catch(() => {});
    return message ? message.result : null;
  }

  async function rpc(method, params) {
    const res = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    let message;
    try {
      message = await parseStreamableResponse(res);
    } catch (err) {
      throw new Error(`MCP ${method} returned an unreadable response: ${err.message}`);
    }
    if (!message) throw new Error(`MCP ${method} returned an empty response`);

    if (message.error) {
      const code = message.error.code;
      const text = message.error.message || `MCP ${method} failed`;
      if (isDeadSessionError(code, text)) throw deadSessionError(text, code);
      const err = new Error(text);
      err.code = code;
      throw err;
    }
    return message.result;
  }

  // Unwrap a tools/call result: tool-level failures are flagged with isError and
  // carry their message in content[0].text. Successful results embed a JSON string.
  function unwrapToolResult(name, result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')?.text;

    if (result?.isError) {
      throw new Error(typeof text === 'string' && text ? text : `MCP tool ${name} failed`);
    }
    if (typeof text !== 'string') return result;
    try { return JSON.parse(text); } catch { return text; }
  }

  async function withSession(name, run) {
    let recovered = false;
    for (;;) {
      if (!sessionId) await initialize();
      try {
        return await run();
      } catch (err) {
        if (err?.deadSession && !recovered) {
          recovered = true;
          await initialize();
          continue;
        }
        throw err;
      }
    }
  }

  // Resolves the parsed JSON result; throws (carrying the tool's message) on any
  // JSON-RPC error or result.isError. Re-initializes once on a dead session.
  async function call(name, args = {}) {
    return withSession(name, async () => {
      const result = await rpc('tools/call', { name, arguments: args ?? {} });
      return unwrapToolResult(name, result);
    });
  }

  async function listTools() {
    return withSession('tools/list', async () => {
      const result = await rpc('tools/list', {});
      return Array.isArray(result?.tools) ? result.tools : [];
    });
  }

  async function close() {
    const sid = sessionId;
    sessionId = null;
    if (!sid) return;
    try {
      await fetch(url, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': sid } });
    } catch {
      // best effort: the server drops the transport when the socket closes anyway
    }
  }

  return { call, listTools, close };
}
