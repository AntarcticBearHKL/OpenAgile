# Sub-tasks (Retired)

> **Status: RETIRED — the current task model has no sub-tasks.**
> The `subTasks` field on a task, the modal fieldset, the card donut indicator, and the
> import/export handling were removed when the task model was slimmed. Human input is now
> carried by the **notes to the agent** (`keyPoints`) — the human appends them and the agent folds them
> into the description — see [tasks.md](tasks.md). Older exports that still carry `subTasks`
> import cleanly with the field dropped.
>
> This document is kept only so existing links keep resolving; it does not describe current
> behaviour.

## What replaced it

- The notes to the agent (`keyPoints`) are the human's one-at-a-time notes on a task; the agent reads them, folds them into the description, and marks them digested.
- Breaking a task into steps is expressed in the description (written by the agent) or as notes to the agent (`keyPoints`, written by the human), never as sub-tasks.
