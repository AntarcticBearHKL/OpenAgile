# Sync Specification

Covers folder sync: linking a local `.agileboard/` folder through the File System Access API so the
browser and the local MCP can exchange domain events with no server between them. The event-log
decision behind it is [ADR-0004](../adr/0004-event-sourced-sync.md).

---

## Folder Sync

Folder sync is the user-facing sync mechanism. The control lives in Settings ("Folder sync"); it is
always visible, and on a browser without the File System Access API it stays disabled and explains
that automatic sync needs desktop Chrome or Edge.

Requirements: a **desktop Chromium** browser (Chrome/Edge) with the local MCP running on the
**same machine**. Firefox and Safari get the board and JSON export/import, but not folder sync.

### Linking

- "Link folder" opens the directory picker (`showDirectoryPicker`, `readwrite`); cancelling changes nothing.
- On link, the browser creates `events/` and `cursors/` inside the chosen folder, flushes any
  buffered outbound events, and runs a first merge.
- "Unlink" returns the client to the default transport and clears the link state.
- Exactly one outbound transport runs at a time: linking selects the folder; unlinking returns to
  the local-server bridge.

### `.agileboard/` layout

The browser owns exactly two files and never touches the rest of the layout:

| Path | Owner | Content |
|---|---|---|
| `events/<writerId>.ndjson` | each writer | append-only, one compact JSON domain event per line |
| `cursors/<writerId>.json` | each reader | `{ [writerId]: byteOffset }` per consumed shard |

The MCP server owns `manifest.json`, `state.json`, `snapshot.json`, the advisory `lock` and
`cursors/mcp.json`, and reads the browser shards with the same byte-cursor rules.

`writerId` is `browser-<sessionUUID>`: one shard per tab, generated at link time and never
persisted, so two tabs can never share a file.

### Outbound

Local domain events are appended to this tab's shard, one JSON line each. Appends never rewrite the
shard (`keepExistingData` plus a seek to the end) and are serialized per shard (Web Locks across
tabs; a promise chain where Web Locks is unavailable). While the folder is not the active transport,
events buffer (cap 500) and flush on link.

### Merge

On link and on each manual sync, the client reads every shard in `events/` from its saved byte
offset:

- Only complete, parseable lines are consumed. An empty line, an unterminated final line, or a line
  that fails to parse stops the read without advancing the cursor past it; re-reading is harmless
  because merging dedupes by event id.
- Each unseen event is persisted with `synced: true`, observed by the HLC, and emitted on the event
  bus, so it flows through the same reducer projection as a local event.
- The cursor is saved after each shard read.

### Status

The Settings control shows one status line: the folder name, the pending outbound count, the last
merged event id, and the last error, if any. A link or append failure surfaces as the error state,
never as a silent drop.
