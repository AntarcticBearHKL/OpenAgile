# Deploying OpenAgile as a static site

`client/dist` is a plain static bundle: HTML, JS, CSS, fonts, and the agent skill
files. It needs no backend, no Node process, and no server-side rendering. Any
static host (GitHub Pages, Netlify, nginx, S3, …) can serve it.

## Build

From `client/`:

```bash
npm run build
```

The output lands in `client/dist/`. Upload the **contents** of that directory
(`index.html`, `assets/`, `skill/`) as the site
root. Do not upload the `client/` or `dist/` wrapper folder itself.

## Root or sub-path hosting

The default build uses relative asset paths (`./assets/...`), so the same output
works at a domain root (`https://example.com/`) and at any sub-path
(`https://example.com/openagile/`) with no rebuild.

If you prefer a fixed absolute base, build it in:

```bash
npm run build -- --base=/openagile/
```

Then serve the output at exactly that path. The built HTML references
`/openagile/assets/...`, and the skill is at `/openagile/skill/openagile.md`.
Rebuild with a plain `npm run build` to return to relative paths.

## The agent skill URL

The bundle ships two static files:

- `skill/openagile.md` — the group-agnostic bootstrap skill
- `skill/agent.json` — the machine-readable companion (`protocolVersion` 1)

They end up at `<site>/skill/...` on a root deploy and
`<site>/<base>/skill/...` on a sub-path deploy, next to each other. An agent can
fetch them without the MCP, and the MCP serves the same document contextualised
with live ids at `GET <mcp-origin>/skill/openagile.md`.

## What works with no backend

Everything the board reads and writes is local to the browser (IndexedDB): the
board works offline, and data survives reloads. JSON export/import is the
universal fallback for moving data between browsers or machines. The `/api/*`
calls the app makes are probes for the optional local service — when it is
absent they fail and the app continues as a normal offline board.

## Honest limitation: automatic folder sync

Automatic page ↔ `.agileboard/` folder sync (the File System Access API) requires
a **desktop Chromium browser** (Chrome/Edge) with the local MCP server running on
the **same machine**. Firefox and Safari get the board and JSON export/import, but
not automatic sync. A public static host never provides the MCP: run the local
Python server (`cd mcp && uv run agile-mcp`) alongside the browser to use one.

## Pointing the app at the local server

The deployed client defaults to the local server at `http://127.0.0.1:8787` and
sends the access token as `Authorization: Bearer` (the SSE stream cannot set
headers, so it uses `?token=`). Override the base URL and token through any of
these, highest priority first:

1. `window.__OPENAGILE__ = { apiBase: 'http://127.0.0.1:8787', apiToken: '<token>' }`
2. `<meta name="openagile-api-base" content="http://127.0.0.1:8787">` and
   `<meta name="openagile-api-token" content="<token>">`
3. `localStorage.setItem('openagile:apiBase', 'http://127.0.0.1:8787')` and
   `localStorage.setItem('openagile:apiToken', '<token>')`

Only `http:`/`https:` base values are accepted; anything else falls back to the
default loopback origin. The token is `OPENAGILE_TOKEN` on the server — it is
printed on first start when unset.

## Browser caveats for loopback

The deployed page and the local server are different origins, so the browser
enforces extra rules:

- **Chrome / Edge** show a *Local Network Access* permission prompt the first
  time a public page reaches `127.0.0.1`; accept it. The server answers the
  preflight with `Access-Control-Allow-Private-Network: true`.
- **Safari** blocks requests from a public origin to loopback entirely and cannot
  be used with the deployed client + local server combination.
- Add the deployed origin to the server's `OPENAGILE_ORIGINS` allowlist, e.g.
  `OPENAGILE_ORIGINS=https://my-app.pages.dev`.

## CSP

The client's HTML entry point (`client/src/index.html`) allows the loopback
origin in `connect-src`, so the browser does not block the probe or the SSE
stream:

```
connect-src 'self' http://127.0.0.1:8787 https://analytics.gomogi.com
```

If you point the client at a different origin, add that origin to `connect-src`
as well.
