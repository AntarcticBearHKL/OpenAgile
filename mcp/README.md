# OpenAgile MCP harness (Python)

The authoritative, event-sourced backend for OpenAgile. It is a faithful Python
port of the Node harness in `kanvana/harness/src`: the same domain events, the
same pure reducer the browser runs, the same `.agileboard/` on-disk format, the
same 42 MCP tools, and the same browser bridge (`/api/stream`, `/api/events`,
`/api/snapshot`).

One process serves, on `127.0.0.1:8787`:

| Route | Purpose |
|---|---|
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP — the 42 OpenAgile tools |
| `GET /api/health` | Liveness probe |
| `GET /api/harness` | Harness identity + `boards` / `seq` |
| `GET /api/snapshot?boardId=` | Projected read model for one board |
| `GET /api/stream?since=&clientId=` | SSE event stream (browser bridge) |
| `POST /api/events?clientId=` | Browser → server event admission (workflow-gated) |
| `GET|POST /api/groups` | Groups + board→group map |
| `GET|POST /api/skills` | Board skills |
| `GET /skill/openagile.md` | Contextualised agent bootstrap doc |
| `GET /skill/agent.json` | Machine-readable companion |

No frontend and no static files are served — the client is deployed separately
(e.g. Cloudflare Pages) and talks to this local server.

## Run

```bash
cd kanvana/mcp
uv run agile-mcp
```

The server binds `127.0.0.1` only. On first start it generates and prints an
access token unless `OPENAGILE_TOKEN` is set.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OPENAGILE_PORT` | `8787` | TCP port |
| `OPENAGILE_HOST` | `127.0.0.1` | Bind address (loopback only) |
| `OPENAGILE_DATA_DIR` | `<cwd>/.agileboard` (`<repo>/.agileboard` when cwd is `mcp/`) | Event-log directory |
| `OPENAGILE_TOKEN` | generated + printed | Bearer token for every route |
| `OPENAGILE_ORIGINS` | empty | CSV allowlist of browser origins (exact match) |
| `OPENAGILE_AGENT_NAME` | `openagile-harness` | Default `actor.id` for tool events |
| `OPENAGILE_GROUP` | empty | Default group hint for `/skill/openagile.md` |
| `OPENAGILE_LOCK_STALE_MS` | `1800000` | Advisory lock staleness window |

## Security model

- **Loopback only.** The socket binds `127.0.0.1`; nothing is exposed to the LAN.
- **Token.** Every `/api/*`, `/skill/*` and `/mcp` request must present
  `Authorization: Bearer <OPENAGILE_TOKEN>` or `?token=<OPENAGILE_TOKEN>`.
  `EventSource` cannot set headers, so the browser bridge passes `?token=`.
  Comparison uses `hmac.compare_digest`; a mismatch is `401`.
- **CORS.** `OPENAGILE_ORIGINS` is an exact-match allowlist. When an `Origin`
  header is present and not allowlisted the request is refused with `403`.
  Allowlisted origins are echoed in `Access-Control-Allow-Origin` with
  `Vary: Origin`; `OPTIONS` preflight answers `204` and advertises
  `Access-Control-Allow-Private-Network: true` (Chrome's Local Network Access).
- **Event admission.** `POST /api/events` accepts a request when either
  (a) an `Origin` header is present, it is in `OPENAGILE_ORIGINS`, and the token
  matches; or (b) there is no `Origin` (a non-browser local client) and the token
  matches. Workflow refusals (moving a task with undigested notes into In
  Progress, writing `column`/`claimedBy` through `task.updated`, stamping
  `digestedAt`, clearing `needsDigest` while notes are pending) return `422` and
  are never appended.

## Browser notes

The client keeps its existing `local-server.js` bridge and is re-pointed at
`http://127.0.0.1:8787` with the token appended to every URL.

- **Chrome / Edge** show a *Local Network Access* permission prompt the first
  time a page (e.g. `https://<app>.pages.dev`) reaches `127.0.0.1`; accept it.
  The preflight is answered with `Access-Control-Allow-Private-Network: true`.
- **Safari** blocks requests from a public origin to loopback entirely and
  cannot be used with the deployed client + local server combination.
- Add the deployed origin to `OPENAGILE_ORIGINS`, e.g.
  `OPENAGILE_ORIGINS=https://my-app.pages.dev`.

## Connect an MCP client (opencode)

```jsonc
"openagile": {
  "type": "remote",
  "url": "http://127.0.0.1:8787/mcp",
  "oauth": false,
  "headers": { "Authorization": "Bearer <OPENAGILE_TOKEN>" }
}
```

## Deviations from the Node harness

Two deliberate, documented changes; everything else (tool names, titles,
descriptions, schemas, reducer, on-disk format, SSE framing, refusals) is a
faithful port.

1. **`POST /api/events` admission gate.** The Node gate required loopback
   `Host` + `Origin == Host` + `Sec-Fetch-Site: same-origin`, which blocks a
   `https://<app>.pages.dev` page outright. The new rule accepts a request when
   its `Origin` is in `OPENAGILE_ORIGINS`, or when no `Origin` is present, with
   the bearer token validated first. All workflow refusals (422) are unchanged.
2. **SSE fan-out.** The Node server broadcast only events posted through
   `/api/events`, so MCP-tool changes never reached the browser live. Here a
   single store append listener broadcasts **every** appended event; `?clientId=`
   still suppresses the originator's echo. This matches the harness's documented
   intent that agent changes update the UI live.

## Persistence

`OPENAGILE_DATA_DIR` keeps the exact layout the Node harness used, so an existing
`.agileboard` loads unchanged:

```
.agileboard/
  manifest.json          # format/projectId, created once
  lock                   # advisory lock (pid/host/startedAt/token, stale-pid takeover)
  state.json             # seq, read-model snapshot, in-memory log, idempotency, key counters
  events-archive.ndjson  # folded events, appended on compaction (>5000 in-memory events)
  cursors/mcp.json       # per-shard byte cursors
  events/<writer>.ndjson # append-only shards (harness + browsers)
```

## Tests

```bash
cd kanvana/mcp
uv run pytest
```

`tests/test_reducer.py` holds reducer conformance vectors (event list → projected
state) that can be diffed against the JS reducer; `tests/test_smoke.py` boots the
server and checks the health/harness/snapshot routes and the 42-tool MCP surface.
