# OpenAgile

**English** | [中文](README.zh-CN.md)

A local-first kanban board for supervising AI agents. The agent proposes, claims, moves and finishes the work; you read the board, add notes and make the calls.

## What this is

OpenAgile is a kanban board whose job is to let one person supervise AI agents. The board runs entirely in the browser and keeps its data in IndexedDB. No server is required for it.

Agents do not need a browser. They talk to the optional harness in `harness/`, a small Node process that serves the built client, speaks MCP, and keeps the same event log the browser projects. When both are connected, an agent moving a card shows up on the board, and a board edit reaches the agent.

This is built for a person running one or a few agents who wants to see, at a glance, what each one picked up, what is stuck, and what needs a decision.

## The five columns

Every board has the same five columns, in the same order.

| Column | Meaning |
|---|---|
| **Backlog** | Work the agent proposed and has not started. This is the agent's queue. |
| **Human In The Loop** | The only column where a person can add a task by hand. |
| **In Progress** | An agent is working the task. The task form is read-only for the human here. |
| **Blocked** | Work that needs a human decision, or that is stuck on a resource conflict. |
| **Finished** | Completed work. |

The column ids, their order and the Finished role are fixed. Display names are just labels, and the column tools refuse to create, delete or reorder columns.

## Who owns what: the description and the notes

A task has two writing surfaces, and they belong to different people.

- The **description** belongs to the agent. It is where the agent writes its plan and its result.
- The **notes** belong to the person. Adding a note is how a human gives the agent input. No agent tool can add, edit or delete a note.

The two are tied together by a small loop:

1. You append a note, while the task is not In Progress. That sets `needsDigest` on the task.
2. The agent folds the notes into the description and calls `digest_key_points`. This stamps each note as digested and clears `needsDigest`.
3. Only once that is done may the agent start the task.

`digest_key_points` is the only way to clear the flag. Nothing else stamps a note or clears it.

### What is refused, and when

Two things are blocked while a task still has notes the agent has not digested:

- `claim_task` is refused.
- `move_task` into **In Progress** is refused. Moving to any other column is allowed.

The same rule holds on the browser's event bridge (`POST /api/events`), so the web page cannot do what the agent is forbidden to do. The bridge returns `422` and refuses, among other things:

- a `task.moved` whose target is In Progress while the task has pending notes;
- a `task.updated` or `task.created` that would stamp `digestedAt`, or clear `needsDigest` while a note is still pending;
- a `task.updated` that writes `column` (a move is a `task.moved`);
- a `task.updated` that writes `claimedBy` or `claimedAt` (a claim is `claim_task`).

A refused request appends nothing. If one event in a batch is refused, the whole batch is refused.

A digested note is read-only. An undigested note can still be edited or removed. Removing the last undigested note clears `needsDigest`, because there is nothing left to digest. Adding a note to a task in **Finished** sends it back to **Backlog** as rework.

## How cards move

Only the agent moves cards, through `move_task`. The board gives the human no way to change a task's column: there is no drag, no column picker, and the dialog only shows the column as context. The rule behind that is simple. The agent acts; the human decides.

## Claim timing and the five-minute auto-block

`claim_task` records who claimed the task and when, and sets the assignee if it was empty.

The harness sweeps every 30 seconds. A task in **In Progress** that carries a claim marker and has not changed for more than five minutes is moved to **Blocked**. The watchdog records the reason `Auto-blocked: no agent sync for over 5 minutes.` and sets `blockedAt`, which freezes the elapsed time. The move is emitted exactly like an agent move, as a `task.moved` plus a `task.updated` with the blocked fields, and it is written to `columnHistory`.

The sweep only looks at tasks in **In Progress** that carry a claim. Unclaimed, recently updated and already-blocked tasks are left alone. Once a card leaves **In Progress**, the window no longer applies. If the agent moves the card to **Finished** or **Blocked** itself, the watchdog never sees it.

## Groups and iterations

- A **group** is a user-named container that holds iterations. Rename it by hand in the sidebar, or through the `rename_group` MCP tool.
- An **iteration** is a board inside a group. It is numbered from its position in the group: "Iteration 1", "Iteration 2", and so on. An iteration cannot be named by hand, and `rename_board` always refuses.
- A board can never live outside a group. Creating a board without a group attaches it to the last group, and assigning an empty group id does the same.
- Deleting a group deletes the iterations it holds.
- A group's leading run of iterations whose tasks are all in **Finished** can be folded away behind one control.
- An iteration can carry a start date, an end date and a goal, which the MCP `list_roadmap` tool reports.

## Install and run

You need Node.js and npm.

### The client

```bash
cd client
npm install
npm run dev      # Vite dev server at http://localhost:5173
npm run build    # production build into client/dist
npm run preview  # serve the production build
```

### The harness

The harness is the process agents talk to. It also serves the built client.

```bash
cd harness
npm install
node src/server.mjs
```

Install dependencies once; the harness only needs its own `npm install`. Build the client first (`npm run build` in `client/`), or the harness has no static files to serve and reports that `client/dist` is missing.

The harness reads a few environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `OPENAGILE_HOST` | `127.0.0.1` | Bind address. |
| `OPENAGILE_PORT` (or `PORT`) | `8787` | Listen port. |
| `OPENAGILE_DATA_DIR` | `harness/data` | Where the event log is persisted. |
| `OPENAGILE_AGENT_NAME` | `openagile-harness` | Actor id the tools report. |

Once it is running, it serves the board at `http://127.0.0.1:8787/` and MCP at `http://127.0.0.1:8787/mcp`.

On Windows, `harness/start-bg.ps1` and `harness/stop-bg.ps1` start and stop the harness detached. Do not start a long-lived server from a tool call; the call waits for the process and stalls.

## Tests

The client has two Vitest layers, unit and DOM:

```bash
cd client
npm test          # unit then DOM
npm run test:unit
npm run test:dom
```

The harness has its own test file. Run it from the repository root:

```bash
node harness/test.mjs
```

At the time of writing: `npm run build` is clean, unit is 305 passing, DOM is 178 passing, and the harness is 33 passing.

## Connect an agent over MCP

The harness exposes MCP over Streamable HTTP at `http://127.0.0.1:8787/mcp`. It is an HTTP endpoint, not a stdio command, so point an MCP client at that URL.

A minimal client using the official SDK:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp')));

const { tools } = await client.listTools();
console.log(tools.map((tool) => tool.name));
```

The tools the harness registers include:

- Boards and iterations: `list_boards`, `create_board`, `delete_board`, `get_board`, `list_roadmap`, `set_board_dates`.
- Groups: `list_groups`, `create_group`, `rename_group`, `delete_group`, `assign_board_to_group`.
- Tasks: `create_task`, `update_task`, `move_task`, `delete_task`, `list_tasks`, `get_task`, `set_blocked_reason`.
- Notes and claims: `digest_key_points`, `claim_task`, `release_task`.
- Reading state: `list_columns`, `get_board_snapshot`, `get_settings`, `update_settings`, `list_events`.
- Skills: `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill`.

A few tools always refuse, on purpose: `create_column`, `delete_column` and `reorder_columns`, because the columns are fixed, and `rename_board`, because iterations are numbered.

This is a representative list. The server advertises the full set.

## Project layout

```
client/       Browser app (vanilla JS ES modules, built with Vite)
  src/        Entry point (index.html) and modules/
  tests/      unit/ and dom/ Vitest suites
  dist/       Production build output (generated)
harness/      Node harness: static server, MCP tools, event bridge
  src/        server.mjs, mcp-tools.mjs, store.mjs, bridge.mjs, hlc.mjs
  test.mjs    Harness tests
  data/       Persisted event log (generated)
docs/         Specifications, ADRs, user docs and plans
scripts/      Release and spec tooling
```

## Rules this product enforces

These hold on every path, MCP and browser alike.

- Five fixed columns. The ids, their order and the Finished role do not change, and the column tools refuse to create, delete or reorder columns.
- Only the agent moves cards. The front end has no way to change a task's column.
- The agent owns the description; the human owns the notes. No agent tool can add, edit or delete a note.
- The agent may not start a task with undigested notes. `claim_task` and a move into **In Progress** are refused until the notes are digested, on both the MCP path and the browser's event bridge.
- `digest_key_points` is the only way to stamp a note or clear `needsDigest`.
- A task is only a title, a description, the notes, and the lifecycle timestamps. There is no priority, due date, task label, sub-task, attachment, custom field, type, estimate, comment, relationship or annotation.
- Every iteration belongs to a group and is numbered from its position. It cannot be named by hand.
- A note added to a **Finished** task returns it to **Backlog** as rework.
- There is no reports page and no points, velocity or burndown metric.
- The board canvas is plain paper: no dot grid, and text selection is off except inside form controls.

## Documentation

- [CONTEXT.md](CONTEXT.md): the domain model.
- [AGENTS.md](AGENTS.md): the agent and developer guide.
- [docs/spec/columns.md](docs/spec/columns.md), [docs/spec/tasks.md](docs/spec/tasks.md), [docs/spec/data-models.md](docs/spec/data-models.md): feature and data specifications.

## License

Released under the MIT License. See [LICENSE.md](LICENSE.md).
