# OpenAgile — agent bootstrap skill

protocolVersion: 1
skillVersion: 1.0.0

This is the **static, group-agnostic** bootstrap document served by the OpenAgile web app. It carries no live board data. Once you are connected to the local OpenAgile MCP server, fetch the **contextualised** copy from that same MCP at `GET /skill/openagile.md` — it is this document with your group, its iterations, the real board IDs, the fixed column IDs and live task-key examples baked in. The MCP also serves `GET /skill/agent.json` with `{ protocolVersion, skillVersion, mcpEndpointHint, docs }`. If this document and the MCP copy ever disagree about `protocolVersion`, trust the MCP.

<!-- openagile:live-context -->

## What OpenAgile is

OpenAgile is a local-first Kanban board shared by one human and any number of AI subagents. It runs entirely in the browser — data lives in IndexedDB and no server is required for the core app. An optional local **MCP server** exposes the same board to agents over the Model Context Protocol and can sync it with a `.agileboard/` folder on disk. The board is the single source of truth for what is being worked on: the human steers, agents do the work and report through the board.

## Connect the MCP

- The MCP is a **Streamable HTTP** server. Its default endpoint is `http://127.0.0.1:8787/mcp`. Configure your MCP client with that URL; OpenAgile does not prescribe a client-specific shell command.
- The MCP runs inside the local harness that also serves the web app. When the app is deployed on a static host there is **no MCP on that host** — run the harness locally to use one.
- After connecting, call `list_groups` and then re-fetch `GET <mcp-origin>/skill/openagile.md` (optionally `?group=<name>`) to get the contextualised document.
- Machine-readable companion, same origin as this file: `./agent.json`.

## The five fixed columns

Every board has exactly five columns. Their IDs, order and semantics are fixed, and the fifth column carries `role: "done"` — do not add, rename, delete or reorder them:

| column | what it means |
|---|---|
| **Backlog** | Work an agent has proposed or created and that nobody has claimed yet. The human reads requirements here and adds notes. |
| **Human In The Loop** | The human's hand-entry column — the only column where the human creates a task by hand. Work waiting on a human decision can be parked here. |
| **In Progress** | Claimed and actively worked. The task form is read-only while a task sits here. Entering the column counts as activity and restarts the 5-minute claim window. |
| **Blocked** | Work that could not continue — it needs a human decision or is stuck on a resource conflict. A blocked task is unfinished work, not completed work. |
| **Finished** | Completed work; the source of truth for what this iteration delivered. Terminal and unbounded — WIP limits never apply. |

## Groups and iterations

- A **Group** is the user-named container. It can be renamed (`rename_group`).
- An **Iteration** *is* a board inside a group. Iterations are auto-named `Iteration 1`, `Iteration 2`, … by their position in the group and can never be renamed by hand (`rename_board` always refuses).
- A board can never live outside a group. `create_board` takes an optional `groupId` and otherwise lands in the last group; `assign_board_to_group` can never leave a board ungrouped.
- `delete_board` only deletes the **last** iteration of its group; earlier iterations fold away and are kept. `delete_group` deliberately deletes the group together with all of its iterations.
- Reads: `list_groups` (groups plus the board → group map), `list_boards` (iterations with their `groupId`), `list_roadmap` (per-iteration `unfinishedTasks` and the single `isActive` iteration).

**Never assume your group from the URL you fetched this document from.** Resolve it from the board yourself: call `list_groups`, and, when you run on the same machine as the harness, the local `.agileboard/manifest.json` may carry `group` / `defaultGroup` hint. Only when the MCP serves `?group=<name>` has a group been chosen for you — and then the contextualised document states which group it resolved and where that came from.

## Who writes what: keyPoints vs description

- **`keyPoints` — "notes to the agent" — belong to the human.** Only the human adds, edits or removes them. No MCP tool can write them: `create_task`/`update_task` do not accept them, and `digest_key_points` only stamps them as digested. Agents read them (`get_task`, `list_tasks`) and respond to them.
- **`description` is the agent's.** You write it, maintain it, and use it as your reporting surface. Every instruction the human leaves in a note must end up folded into the description — do not leave the human's words hanging.
- Tasks carry `needsDigest` (an undigested note is waiting) and `isRework` (a finished task came back because a new note arrived). `digest_key_points` clears both.

## The digest gate (before any claim)

Undigested notes are a hard gate enforced by the server, not a suggestion:

1. `get_task` and read every `keyPoints` entry that has no `digestedAt`.
2. Fold their content into `description` with `update_task`.
3. **Then** call `digest_key_points` (optionally with `pointIds` to stamp specific notes). It stamps `digestedAt`, clears `needsDigest`, and clears `isRework`.
4. `digest_key_points` does **not** verify that you folded anything into the description — that part is your responsibility. It is the only tool that can clear the flag.

While undigested notes exist, `claim_task` is refused, `move_task`/`move_tasks` into In Progress is refused, and the browser's event bridge refuses the same moves. The refusal names `digest_key_points`.

## Claims and the 5-minute watchdog

- `claim_task` is a **hard lock** that names your agent. A live claim by another agent is refused and names the holder. Re-claiming your own task is a renewal; a claim whose last activity is older than 5 minutes is expired and may be taken over (`tookOver: true`).
- **Watchdog:** the server sweeps every 30 seconds. A claimed task that sits in In Progress with no activity for more than 5 minutes is moved to **Blocked** with the reason "Auto-blocked: no agent sync for over 5 minutes." The watchdog does **not** clear the claim — expiry is by time and takeover is your decision.
- **Heartbeat:** any update to the task resets the 5-minute window (editing the description, digesting, re-claiming, or moving into In Progress). If real work will run longer than about 5 minutes, call `heartbeat_task` before the window closes. It only rewrites `changeDate`, and only works for a task you have claimed that is in In Progress.
- When you stop — done or not — `release_task`. Do not sit on a claim you are not using.

## The standard work loop

1. Connect the MCP; resolve the group (`list_groups`) and pick the active iteration (`list_roadmap` / `list_boards`).
2. Read the work: `list_tasks` with `ready: true`, or `get_task`; read the board's own skills with `list_skills` / `get_skill`.
3. If the task has undigested notes, digest them first (above).
4. `claim_task` with your agent name, or `claim_next` to atomically take the next ready task.
5. Move it to In Progress. The clock restarts here.
6. Work. Heartbeat before the 5-minute window closes, and keep `description` current — it is what the human and the next agent read.
7. Finish → move to **Finished**. Cannot continue → move to **Blocked** *and* write the reason with `set_blocked_reason`.
8. `release_task` when you stop.
9. Waiting for the human's next note, or for sibling work to land? Use `wait_for_event` with the last `seq` you saw (it accepts `type` / `boardId` filters). Do not poll `list_events`.

## IDs, task keys and boardId

- Always pass `boardId` explicitly to board-scoped tools. Omitting it falls back to the default/first board, which is rarely the iteration you mean.
- Task keys are `<iteration prefix>-<number>`: `Iteration 1` → `I1`, so its tasks are `I1-1`, `I1-2`, …; `Iteration 2` → `I2-1`, `I2-2`, … . The prefix is derived from the iteration's name.
- Use UUID `id`s in tool calls; keys are for humans and for reports.

## Board skills vs this skill

The board itself stores user-authored skills. Agents read them with `list_skills` and `get_skill`; they are event-sourced and sync like groups. This bootstrap document is a different thing — the agent/MCP connection skill. Read the board's skills as part of step 2 of the work loop.

## Sync and deployment reality

- Static deployment: the web app works read-only/offline in any browser; the data lives in IndexedDB, and the app's JSON export/import is the universal fallback for moving data between machines.
- Automatic page ↔ folder sync (`<project>/.agileboard/`: event NDJSON shards, `manifest.json`, `state.json`) requires a **desktop Chromium** browser (File System Access API) with the local MCP running on the **same machine**. Without the MCP the app still works fully; it simply does not auto-sync.
- Do not hand-edit anything inside `.agileboard/`. The harness owns `manifest.json`, `state.json`, `snapshot.json` and the lock; the browser only appends to its own event shard.
