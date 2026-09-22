# Board UI

## Main Layout

- The board uses a horizontal column layout with mobile-friendly horizontal scrolling
- Each column contains a header and a task list; the Finished column adds a "Show more (N remaining)" control when its list is virtualized
- The brand area shows the OpenAgile SVG logo and brand text shows the active board name rather than a fixed app title

## Fixed Columns

- The board always has exactly five fixed columns, in this order: Backlog, Human In The Loop, In Progress, Blocked, Finished
- Backlog holds work the agent proposed
- Human In The Loop is the human's entry point, the only column with an add-task control in its header, and the only column whose task dialog is fully editable
- Outside Human In The Loop the agent's title and description show as read-only content in the dialog and only the notes-to-the-agent list stays editable
- In Progress is what an agent is actively working; tasks in it are read-only — the whole form is locked while a subagent works the task and the notes control is visibly unavailable
- Blocked is work an agent could not finish and that needs a human decision, or work stuck on a resource conflict
- Finished is completed work; it carries the done-column `role`
- A task whose notes the agent has not digested yet carries a marker in Backlog, Blocked and Finished: a coloured pill with a lucide icon and a text label, so it reads in both themes and without colour
- The column's id, order, and role are fixed, so keying behaviour off them survives display-name changes

## Controls Bar

- Includes board-level task search beside the brand area
- Search filters the rendered board in memory only
- Search matches task title and description
- A light/dark theme toggle and a Settings button sit as direct icon buttons in the app bar; there is no controls menu
- On mobile, the top bar stays on a single row: the brand remains left, while the controls stay right

## Boards UI

- Board selection persists and restores on page load
- Manage Boards supports create, open, export, import, edit an iteration's dates and goal, and delete actions
- Clicking the brand text or pressing `Ctrl+B` opens the Manage Boards modal; the shortcut is ignored while focus is in an input, textarea, or select
- New iterations start blank
- Only the last iteration in a group can be deleted: earlier iterations fold away and are kept, and the sidebar offers the delete control only on the last one. Deleting a group still deletes the iterations it holds
- On mobile, the board selector has a larger touch target
- Clicking a sidebar group's name or its chevron collapses or expands that group; double-clicking the name renames the group inline
- A group is named by the user and can be renamed from the sidebar or by the agent's `rename_group` tool; an iteration is a board inside a group, numbered in order (Iteration 1, Iteration 2, …) and never named by hand
- A group is the only home for iterations: a board can never live outside a group
- A group's leading run of iterations whose tasks are all in Finished collapses behind a single control

## Modals and Dialogs

- Modal close behavior is centralized in `src/modules/modals.js`
- Modals close via Escape or backdrop click
- Confirmations use `confirmDialog()` or `alertDialog()` instead of browser-native dialogs
- Long modals scroll internally while their action row stays sticky at the bottom
- Modals become full-screen on mobile

## Rendering Behavior

- `renderBoard()` is the single board re-render entry point after data changes
- Dynamic DOM updates should re-run `renderIcons()`
- Finished-column virtualization renders completed tasks in batches when the column is large

## Card Movement

- There is no drag and drop for tasks: cards cannot be moved within or across columns from the UI
- Only the agent changes a task's column, through the MCP tools (`move_task`, `move_tasks`, `claim_next`); the human directs work with the notes-to-the-agent list
- Columns are fixed: they are not draggable, reorderable, or editable from the board

## Scrolling and Responsiveness

- Desktop columns fill the available board height and their task lists scroll internally
- Mobile columns use internal vertical scrolling and snap-scrolling horizontally across the board
- Styled scrollbars use an 8px thumb on supported browsers

## Warnings

- `beforeunload` warns that data lives in the browser and should be exported if needed
- Deleting tasks requires confirmation
