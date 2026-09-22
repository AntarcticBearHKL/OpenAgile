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
a **desktop Chromium browser** (Chrome/Edge) with the local MCP running on the
**same machine**. Firefox and Safari get the board and JSON export/import, but
not automatic sync. A public static host never provides the MCP: run the harness
locally alongside the browser to use one.

## Pointing the app at a local service

By default every `/api/*` call goes to the same origin the page was served from.
To point the app at a local service instead, provide the base URL through any of
these, highest priority first:

1. `window.__OPENAGILE__ = { apiBase: 'http://127.0.0.1:8787' }`
2. `<meta name="openagile-api-base" content="http://127.0.0.1:8787">`
3. `localStorage.setItem('openagile:apiBase', 'http://127.0.0.1:8787')`

Only `http:`/`https:` values are accepted; anything else falls back to same
origin.

## CSP if loopback is enabled later

The loopback transport (a browser calling `http://127.0.0.1:8787` directly) is
deferred. The current CSP `connect-src` in the HTML entry point is:

```
connect-src 'self' https://analytics.gomogi.com
```

If loopback is enabled, add the loopback origin to `connect-src` in
`client/src/index.html`
— for example `http://127.0.0.1:8787` — otherwise the browser blocks the probe
and the SSE stream. No `http:` or loopback entry belongs there until then.
