# Import and Export

## Export Behavior

- Export combines the selected board's `boardName`, tasks, columns, and settings into one JSON file
- Exported tasks carry the current task model: title, description, assignee, notes to the agent (`keyPoints`), column, order, dates, blocked fields, claim fields, and `needsDigest`/`isRework`
- Import/export actions are accessed from Manage Boards; the main toolbar does not provide separate import/export buttons
- Board-management export can export a chosen board directly
- Export writes metadata in `exportMeta` including `appVersion`, `schemaVersion`, and `exportedAt`
- Export filenames use `{boardName}-YYYY-MM-DD.json`
- Export runs the same strict structural validation used by import preview; when invalid references are found, export is blocked and the user gets actionable guidance
- Exported current data uses UUID model IDs for boards, tasks, and columns
- The Finished column is exported with `role: "done"`

## Import Behavior

- Import creates a new board from JSON rather than overwriting an existing board
- Imported settings are restored when present
- A `boardName` in the file is kept as export metadata; the created iteration is numbered by its position
- Import warns that a new board will be created and the UI will switch to it
- Import performs a preflight review before saving any data: file size is checked first, the JSON shape is validated, and the user must confirm a summary of counts and warnings before the new board is created
- Imports above the supported size limit are rejected, and unusually large but still supported imports show a caution message before confirmation
- Imports reject schema mismatches such as malformed sections or task references to unknown imported columns
- Unknown task column references are rejected with explicit manual-fix instructions (add the missing column ids in `columns[]` or remap `task.column` to an existing id)
- An older export that still carries the removed task fields (`priority`, `dueDate`, task `labels`, `subTasks`, `attachments`, `customFields`, `annotations`, `comments`, `relationships`, `type`, `estimate`, `parentId`) imports cleanly: those fields are dropped rather than rejected
- An older export that still carries `acceptanceCriteria` imports cleanly: the entries are read into `keyPoints` with `text` kept and the old `done` flags dropped
- Legacy imported IDs, including `done`, `todo`, and prefixed board IDs, are remapped to UUIDs before persistence
- Import rewrites task column references and column history entries when IDs are remapped

## Compatibility Rules

- Import must preserve backward compatibility with older shapes where feasible
- If the persisted schema changes, update import normalization and export serialization in the same change
- Import/export must round-trip current board data, columns, and settings
