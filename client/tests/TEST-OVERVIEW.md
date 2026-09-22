# Test Overview

Generated from test source. Do not edit by hand; run `npm run test:overview` from `client/`.

## Fast Scan

- Test files: 46
- Test cases: 437
- Unit files: 29
- DOM integration files: 17
- E2E files: 0

## How To Use This

- For a requested feature change, search this file for the feature, module, UI label, and spec name.
- If matching tests exist, update the closest unit/DOM/E2E case first.
- If no matching tests exist, add coverage in the layer recommended by `docs/spec/testing-strategy.md`.
- Treat the gap lists below as heuristics, not proof that behavior is untested.

## Coverage Gaps By Name

These lists compare source/spec filenames against test file names and test titles.

### Source Modules Without Obvious Named Coverage

- `src/modules/app-config.js`
- `src/modules/armed-delete-button.js`
- `src/modules/board-filters.js`
- `src/modules/board-rename-modal.js`
- `src/modules/board-select.js`
- `src/modules/board-serializer.js`
- `src/modules/column-element.js`
- `src/modules/dataset-import.js`
- `src/modules/idb-store.js`
- `src/modules/import-board.js`
- `src/modules/import-normalize.js`
- `src/modules/local-server.js`
- `src/modules/modal-utils.js`
- `src/modules/projection-task-handlers.js`
- `src/modules/spotlight.js`
- `src/modules/storage-board-mutations.js`
- `src/modules/storage-boards.js`
- `src/modules/storage-cross-board.js`
- `src/modules/storage-defaults.js`
- `src/modules/storage-entities.js`
- `src/modules/storage-migration.js`
- `src/modules/storage-normalize.js`
- `src/modules/storage-projector.js`
- `src/modules/storage-settings.js`
- `src/modules/storage-state.js`
- `src/modules/task-helpers.js`
- `src/modules/task-modal-access.js`
- `src/modules/task-modal-chrome.js`
- `src/modules/task-modal-form.js`
- `src/modules/task-modal-state.js`
- `src/modules/task-modal-status.js`
- `src/modules/task-modal-wiring-agile.js`
- `src/modules/task-modal-wiring-controls.js`
- `src/modules/task-modal-wiring-submit.js`
- `src/modules/theme.js`

### Specs Without Obvious Named Coverage

- `../docs/spec/audit-trail.md`
- `../docs/spec/backend-storage-pb.md`
- `../docs/spec/board-ui.md`
- `../docs/spec/data-models.md`
- `../docs/spec/overview.md`
- `../docs/spec/testing-strategy.md`
- `../docs/spec/testing.md`

## Test Files

## Unit Tests

### Agile

- Path: `tests/unit/agile.test.js`
- Type: Unit
- Test count: 22

- `tests/unit/agile.test.js:19` normalizeTaskType accepts the four agile types
- `tests/unit/agile.test.js:26` normalizeTaskType is case-insensitive and trims
- `tests/unit/agile.test.js:31` normalizeTaskType falls back to task for invalid values
- `tests/unit/agile.test.js:40` normalizeEstimate keeps finite numbers including zero
- `tests/unit/agile.test.js:47` normalizeEstimate returns null for empty or invalid values
- `tests/unit/agile.test.js:57` normalizeKeyPoints keeps text, ids and timestamps and drops any done flag
- `tests/unit/agile.test.js:69` normalizeKeyPoints generates missing ids and timestamps and drops empty text
- `tests/unit/agile.test.js:83` normalizeKeyPoints preserves a digestedAt stamp
- `tests/unit/agile.test.js:91` normalizeKeyPoints returns [] for non-arrays
- `tests/unit/agile.test.js:98` normalizeComments defaults the author to You and preserves timestamps
- `tests/unit/agile.test.js:107` normalizeComments stamps a missing timestamp and drops empty text
- `tests/unit/agile.test.js:116` boardKeyPrefix uses initials for multi-word names
- `tests/unit/agile.test.js:122` boardKeyPrefix uses the first three chars for single-word names
- `tests/unit/agile.test.js:128` boardKeyPrefix strips non-alphanumerics and falls back to BRD
- `tests/unit/agile.test.js:136` nextTaskKey starts at 1 for a fresh board
- `tests/unit/agile.test.js:140` nextTaskKey increments past the highest matching suffix
- `tests/unit/agile.test.js:145` nextTaskKey ignores malformed or foreign keys
- `tests/unit/agile.test.js:152` isBlockedColumnId matches the Blocked column by id
- `tests/unit/agile.test.js:169` taskAgeDays counts whole days since creationDate
- `tests/unit/agile.test.js:174` taskAgeDays returns null without a valid creationDate
- `tests/unit/agile.test.js:179` isTaskStale flags tasks unchanged for more than 14 days
- `tests/unit/agile.test.js:185` isTaskStale falls back to creationDate and ignores missing dates

### Backend Event Schema

- Path: `tests/unit/backend-event-schema.test.js`
- Type: Unit
- Test count: 1

- `tests/unit/backend-event-schema.test.js:7` latest backend migrations defensively keep events.board as text

### Board Groups

- Path: `tests/unit/board-groups.test.js`
- Type: Unit
- Test count: 38

- `tests/unit/board-groups.test.js:41` group store > starts with no groups
- `tests/unit/board-groups.test.js:45` group store > createGroup emits group.created and exposes the group through the projection
- `tests/unit/board-groups.test.js:66` group store > createGroup falls back to New Group when the name is blank
- `tests/unit/board-groups.test.js:75` group store > renameGroup changes the stored name without touching the order
- `tests/unit/board-groups.test.js:86` group store > renameGroup rejects blank names and unknown ids
- `tests/unit/board-groups.test.js:94` group store > listGroups migrates legacy localStorage groups, sorts by order, and falls back to Untitled group
- `tests/unit/board-groups.test.js:106` group store > toggleGroupCollapsed flips and persists the collapsed flag
- `tests/unit/board-groups.test.js:114` group store > toggleGroupCollapsed emits a single-field group.updated event
- `tests/unit/board-groups.test.js:130` group store > setting a collapse flag it already has emits nothing
- `tests/unit/board-groups.test.js:141` group store > setGroupCollapsed is a no-op for unknown groups
- `tests/unit/board-groups.test.js:146` group store > toggleGroupPrefixCollapsed flips and persists the prefix flag
- `tests/unit/board-groups.test.js:155` group store > setGroupPrefixCollapsed is a no-op for unknown groups
- `tests/unit/board-groups.test.js:160` group store > deleteGroup removes the group and unassigns its boards
- `tests/unit/board-groups.test.js:170` group store > deleteGroup emits group.deleted plus one explicit unbind per bound board
- `tests/unit/board-groups.test.js:187` group store > deleteGroup ignores unknown ids
- `tests/unit/board-groups.test.js:191` group store > deleteGroup keeps the names and order of the groups that remain
- `tests/unit/board-groups.test.js:203` group store > ensureBoardsGrouped attaches ungrouped boards to the last group
- `tests/unit/board-groups.test.js:211` group store > ensureBoardsGrouped creates a group when none exists
- `tests/unit/board-groups.test.js:219` group store > iterationLabel numbers from one
- `tests/unit/board-groups.test.js:224` group store > nextIterationName counts the boards already in the target group
- `tests/unit/board-groups.test.js:232` group store > nextIterationName targets the last group when no group is given
- `tests/unit/board-groups.test.js:240` group store > nextIterationName starts at Iteration 1 with no groups
- `tests/unit/board-groups.test.js:245` group store > ensureBoardsGrouped ignores boards that are already grouped
- `tests/unit/board-groups.test.js:254` group store > listGroups ignores malformed records and sorts by order
- `tests/unit/board-groups.test.js:267` group store > listGroups survives invalid JSON
- `tests/unit/board-groups.test.js:272` group store > legacy localStorage groups migrate once and are not re-emitted on later reads
- `tests/unit/board-groups.test.js:288` group store > legacy localStorage groups are the migration source only until the projection has groups
- `tests/unit/board-groups.test.js:302` board → group mapping > assignBoardToGroup emits board.group.assigned and the projection exposes the mapping
- `tests/unit/board-groups.test.js:319` board → group mapping > assigning the mapping it already has emits nothing
- `tests/unit/board-groups.test.js:330` board → group mapping > assignBoardToGroup with a null group removes the mapping (Ungrouped)
- `tests/unit/board-groups.test.js:339` board → group mapping > assignBoardToGroup falls back to Ungrouped for unknown group ids
- `tests/unit/board-groups.test.js:344` board → group mapping > getGroupIdForBoard returns null for unknown boards
- `tests/unit/board-groups.test.js:349` board → group mapping > pruneBoardGroups drops mappings for boards that no longer exist
- `tests/unit/board-groups.test.js:361` group event emission > a burst of writes emits one event per mutation with no debounce
- `tests/unit/board-groups.test.js:380` group event emission > renaming a group to the name it already has emits nothing
- `tests/unit/board-groups.test.js:390` group event emission > the server echo of the local state is not re-emitted
- `tests/unit/board-groups.test.js:401` group event emission > adopting the state that is already stored emits nothing
- `tests/unit/board-groups.test.js:416` group event emission > a state from another client is adopted once through events and stays adopted

### Column Order

- Path: `tests/unit/column-order.test.js`
- Type: Unit
- Test count: 8

- `tests/unit/column-order.test.js:12` columnEntryTime uses the latest history entry that matches the current column
- `tests/unit/column-order.test.js:27` columnEntryTime falls back to creationDate when no history entry matches the column
- `tests/unit/column-order.test.js:38` needsDigest tasks sort to the front of their column
- `tests/unit/column-order.test.js:47` tasks order by the time they entered the column, earliest first
- `tests/unit/column-order.test.js:57` a task returning to a column is ordered by the return, not the first arrival
- `tests/unit/column-order.test.js:74` equal entry times break deterministically by id, whatever the input order
- `tests/unit/column-order.test.js:82` selectColumnRenderPlan derives the order and ignores the stored order field
- `tests/unit/column-order.test.js:95` selectColumnRenderPlan puts an undigested note at the front of the Finished column too

### Columns

- Path: `tests/unit/columns.test.js`
- Type: Unit
- Test count: 6

- `tests/unit/columns.test.js:12` columns are locked to the five fixed columns
- `tests/unit/columns.test.js:17` an existing four-column board gains Human In The Loop without losing its tasks
- `tests/unit/columns.test.js:33` toggleColumnCollapsed toggles from false to true
- `tests/unit/columns.test.js:40` toggleColumnCollapsed toggles from true to false
- `tests/unit/columns.test.js:47` toggleColumnCollapsed returns false for non-existent column
- `tests/unit/columns.test.js:51` toggleColumnCollapsed returns false for empty ID

### Constants

- Path: `tests/unit/constants.test.js`
- Type: Unit
- Test count: 4

- `tests/unit/constants.test.js:14` the board has five fixed columns with Human In The Loop in position two
- `tests/unit/constants.test.js:23` DONE_COLUMN_ID is done
- `tests/unit/constants.test.js:27` DEFAULT_COLUMN_COLOR is a valid hex color
- `tests/unit/constants.test.js:31` open boards modal shortcut defaults to Ctrl+B

### Dataset

- Path: `tests/unit/dataset.test.js`
- Type: Unit
- Test count: 8

- `tests/unit/dataset.test.js:68` exportDataset writes a v2 bundle with counts, snapshots and a sha256 checksum
- `tests/unit/dataset.test.js:94` merge import round-trips the exported event set into an empty store
- `tests/unit/dataset.test.js:114` merge import is idempotent: a second import adds no events and changes no projection
- `tests/unit/dataset.test.js:135` merge import accepts a v1 single-board payload by synthesizing genesis events
- `tests/unit/dataset.test.js:160` clone import remaps ids and creates a new board on every import
- `tests/unit/dataset.test.js:184` merge import refuses a bundle whose checksum does not match and imports nothing
- `tests/unit/dataset.test.js:195` unknown event types are persisted and skipped by the reducer without throwing
- `tests/unit/dataset.test.js:229` importDataset rejects malformed payloads and modes with clear errors

### Backfill

- Path: `tests/unit/event-sourcing/backfill.test.js`
- Type: Unit
- Test count: 5

- `tests/unit/event-sourcing/backfill.test.js:49` event log backfill > emits a created event for every pre-existing entity
- `tests/unit/event-sourcing/backfill.test.js:62` event log backfill > a replaying device reconstructs each board and its tasks
- `tests/unit/event-sourcing/backfill.test.js:86` event log backfill > runs once and is a no-op on the next startup
- `tests/unit/event-sourcing/backfill.test.js:98` event log backfill > skips entities that already have a created event
- `tests/unit/event-sourcing/backfill.test.js:112` event log backfill > records the flag so a later run is skipped

### Board Delete Replay

- Path: `tests/unit/event-sourcing/board-delete-replay.test.js`
- Type: Unit
- Test count: 2

- `tests/unit/event-sourcing/board-delete-replay.test.js:43` a board deleted elsewhere does not come back when its events replay
- `tests/unit/event-sourcing/board-delete-replay.test.js:58` the tombstone survives a reload rather than resurrecting from IDB

### Board Scaffold Convergence

- Path: `tests/unit/event-sourcing/board-scaffold-convergence.test.js`
- Type: Unit
- Test count: 5

- `tests/unit/event-sourcing/board-scaffold-convergence.test.js:38` createBoard emits a column.created per default column and no label events
- `tests/unit/event-sourcing/board-scaffold-convergence.test.js:61` a fresh device reconstructs createBoard columns from the event log alone
- `tests/unit/event-sourcing/board-scaffold-convergence.test.js:80` the default board uses a stable id across independent device initialisations
- `tests/unit/event-sourcing/board-scaffold-convergence.test.js:96` two devices seeding the default board converge to one board with no duplicate columns
- `tests/unit/event-sourcing/board-scaffold-convergence.test.js:120` createBoard does not double-apply its own scaffold events onto the local read-model

### Convergence

- Path: `tests/unit/event-sourcing/convergence.test.js`
- Type: Unit
- Test count: 1

- `tests/unit/event-sourcing/convergence.test.js:18` same event set converges regardless of input order

### Delete Vs Edit

- Path: `tests/unit/event-sourcing/delete-vs-edit.test.js`
- Type: Unit
- Test count: 1

- `tests/unit/event-sourcing/delete-vs-edit.test.js:18` later task edit is dropped after task delete tombstone

### Emitter

- Path: `tests/unit/event-sourcing/emitter.test.js`
- Type: Unit
- Test count: 2

- `tests/unit/event-sourcing/emitter.test.js:15` scheduleDomainEvent persists an unsynced immutable event row
- `tests/unit/event-sourcing/emitter.test.js:38` scheduleDomainEvent rejects a type that is not a known domain event

### Hlc

- Path: `tests/unit/event-sourcing/hlc.test.js`
- Type: Unit
- Test count: 3

- `tests/unit/event-sourcing/hlc.test.js:19` compareHlc orders equal wallTime and counter by nodeId
- `tests/unit/event-sourcing/hlc.test.js:27` compareHlc remains transitive across wallTime counter and nodeId
- `tests/unit/event-sourcing/hlc.test.js:42` observeRemote advances counter from the remote HLC when remote wallTime wins

### Read Model Projector

- Path: `tests/unit/event-sourcing/read-model-projector.test.js`
- Type: Unit
- Test count: 6

- `tests/unit/event-sourcing/read-model-projector.test.js:74` createReadModelProjector > register() subscribes so an emitted board event projects into state and schedules read-model persist
- `tests/unit/event-sourcing/read-model-projector.test.js:86` createReadModelProjector > project() is idempotent by event id (dedup)
- `tests/unit/event-sourcing/read-model-projector.test.js:94` createReadModelProjector > register() is idempotent — a single emit projects once
- `tests/unit/event-sourcing/read-model-projector.test.js:103` createReadModelProjector > reset() unsubscribes the handler and clears dedup state
- `tests/unit/event-sourcing/read-model-projector.test.js:118` createReadModelProjector > a global event folds into the global slices, persists that key and emits DATA_CHANGED
- `tests/unit/event-sourcing/read-model-projector.test.js:141` createReadModelProjector > a board-scoped board.created still writes the board read model

### Reducer

- Path: `tests/unit/event-sourcing/reducer.test.js`
- Type: Unit
- Test count: 18

- `tests/unit/event-sourcing/reducer.test.js:18` applyEvent is idempotent by event id
- `tests/unit/event-sourcing/reducer.test.js:35` task.deleted tombstones prevent later task updates from resurrecting the task
- `tests/unit/event-sourcing/reducer.test.js:51` task.updated merges different field events on the same task
- `tests/unit/event-sourcing/reducer.test.js:74` task.moved updates column order and columnHistory
- `tests/unit/event-sourcing/reducer.test.js:106` unknown event types warn and leave projection unchanged
- `tests/unit/event-sourcing/reducer.test.js:118` legacy label events replay without throwing and leave the projection unchanged
- `tests/unit/event-sourcing/reducer.test.js:149` unknown removed event types leave the model untouched
- `tests/unit/event-sourcing/reducer.test.js:164` column events create update delete and reorder columns
- `tests/unit/event-sourcing/reducer.test.js:180` settings.updated folds board settings
- `tests/unit/event-sourcing/reducer.test.js:190` relationship events update embedded task collections
- `tests/unit/event-sourcing/reducer.test.js:210` createProjectionState seeds global groups boardGroups and skills slices
- `tests/unit/event-sourcing/reducer.test.js:218` group events create update and soft delete groups
- `tests/unit/event-sourcing/reducer.test.js:248` group.created is idempotent by group id
- `tests/unit/event-sourcing/reducer.test.js:269` group.deleted unbinds its boards without removing the boardGroups keys
- `tests/unit/event-sourcing/reducer.test.js:287` board.group.assigned binds and unbinds boards preserving null
- `tests/unit/event-sourcing/reducer.test.js:310` skill events create update and soft delete skills
- `tests/unit/event-sourcing/reducer.test.js:340` global event dedup leaves projection unchanged on replay
- `tests/unit/event-sourcing/reducer.test.js:367` subtask events are no longer applied to tasks

### Snapshot

- Path: `tests/unit/event-sourcing/snapshot.test.js`
- Type: Unit
- Test count: 10

- `tests/unit/event-sourcing/snapshot.test.js:38` loadSnapshot returns null when no snapshot exists
- `tests/unit/event-sourcing/snapshot.test.js:42` saveSnapshot and loadSnapshot round-trip preserves projection state
- `tests/unit/event-sourcing/snapshot.test.js:64` gcEvents removes events at or before snapshotHlc and leaves later ones
- `tests/unit/event-sourcing/snapshot.test.js:79` gcEvents for a board snapshot does not delete unrelated boards\' events
- `tests/unit/event-sourcing/snapshot.test.js:101` checkAndScheduleSnapshot schedules snapshot after 500 events with jitter delay
- `tests/unit/event-sourcing/snapshot.test.js:117` checkAndScheduleSnapshot does not schedule when event count is below threshold
- `tests/unit/event-sourcing/snapshot.test.js:130` checkAndScheduleSnapshot ignores other boards when counting events
- `tests/unit/event-sourcing/snapshot.test.js:143` checkAndScheduleSnapshot schedules when snapshot age exceeds 14 days
- `tests/unit/event-sourcing/snapshot.test.js:160` global snapshot stored under __global__ key does not interfere with board snapshot
- `tests/unit/event-sourcing/snapshot.test.js:178` checkAndScheduleSnapshot does not delete events when a snapshot is taken

### Events

- Path: `tests/unit/events.test.js`
- Type: Unit
- Test count: 5

- `tests/unit/events.test.js:4` on + emit delivers event with detail
- `tests/unit/events.test.js:13` off removes the handler
- `tests/unit/events.test.js:24` multiple handlers all receive the event
- `tests/unit/events.test.js:38` emit with no subscribers does not throw
- `tests/unit/events.test.js:43` DATA_CHANGED constant has expected value

### Folder Sync Ui

- Path: `tests/unit/folder-sync-ui.test.js`
- Type: Unit
- Test count: 6

- `tests/unit/folder-sync-ui.test.js:8` unlinked status is calm and shows the buffered outbound count
- `tests/unit/folder-sync-ui.test.js:16` a link failure on an unlinked folder surfaces as the error state
- `tests/unit/folder-sync-ui.test.js:22` the unsupported outcome is not rendered as an error
- `tests/unit/folder-sync-ui.test.js:29` linked status shows the folder, pending count and last merged event
- `tests/unit/folder-sync-ui.test.js:54` the unsupported hint names the desktop Chromium requirement
- `tests/unit/folder-sync-ui.test.js:58` folder sync reports unsupported when the directory picker is absent

### Folder Sync

- Path: `tests/unit/folder-sync.test.js`
- Type: Unit
- Test count: 14

- `tests/unit/folder-sync.test.js:141` pickFolder returns null and reports unsupported when the API is absent
- `tests/unit/folder-sync.test.js:148` pickFolder returns null when the user cancels the picker
- `tests/unit/folder-sync.test.js:160` illegal writer id is rejected and the regex refuses path traversal
- `tests/unit/folder-sync.test.js:168` first append creates the shard with exactly one line
- `tests/unit/folder-sync.test.js:179` second append grows the shard without rewriting prior lines
- `tests/unit/folder-sync.test.js:192` concurrent appends are serialized in call order
- `tests/unit/folder-sync.test.js:205` torn last line is not consumed and does not advance the cursor
- `tests/unit/folder-sync.test.js:228` duplicate event id is merged once across shards
- `tests/unit/folder-sync.test.js:239` unlinked routeOutbound buffers and flushes on link
- `tests/unit/folder-sync.test.js:254` merge persists remote events as synced and does not re-append them
- `tests/unit/folder-sync.test.js:268` merge emits EVENT_EMITTED once per unseen event and is idempotent
- `tests/unit/folder-sync.test.js:286` global events flow through the transport like any other event
- `tests/unit/folder-sync.test.js:307` transport mode gates outbound appends
- `tests/unit/folder-sync.test.js:329` linkFolder injects the clock and logger hooks

### Importexport

- Path: `tests/unit/importexport.test.js`
- Type: Unit
- Test count: 9

- `tests/unit/importexport.test.js:46` inspectImportPayload accepts valid board export objects
- `tests/unit/importexport.test.js:71` inspectImportPayload remaps legacy model ids to UUIDs while preserving references
- `tests/unit/importexport.test.js:102` inspectImportPayload rejects files above the size limit
- `tests/unit/importexport.test.js:108` inspectImportPayload warns for legacy task-only imports
- `tests/unit/importexport.test.js:122` inspectImportPayload preserves and remaps task relationships
- `tests/unit/importexport.test.js:143` inspectImportPayload ignores the removed task fields from an older export
- `tests/unit/importexport.test.js:176` inspectImportPayload reads legacy acceptanceCriteria into keyPoints
- `tests/unit/importexport.test.js:204` buildImportConfirmationMessage includes summary details
- `tests/unit/importexport.test.js:218` exportBoard writes no labels array

### Normalize

- Path: `tests/unit/normalize.test.js`
- Type: Unit
- Test count: 15

- `tests/unit/normalize.test.js:13` isHexColor accepts valid 6-digit hex colors
- `tests/unit/normalize.test.js:19` isHexColor accepts valid 3-digit hex colors
- `tests/unit/normalize.test.js:24` isHexColor rejects invalid values
- `tests/unit/normalize.test.js:36` normalizeHexColor returns valid color unchanged
- `tests/unit/normalize.test.js:40` normalizeHexColor trims whitespace from valid color
- `tests/unit/normalize.test.js:44` normalizeHexColor returns default fallback for invalid color
- `tests/unit/normalize.test.js:49` normalizeHexColor uses custom fallback
- `tests/unit/normalize.test.js:55` boardDisplayName returns trimmed name
- `tests/unit/normalize.test.js:59` boardDisplayName returns Untitled board for missing/empty name
- `tests/unit/normalize.test.js:69` normalizeActivityLog drops malformed entries and preserves valid entries
- `tests/unit/normalize.test.js:90` normalizeActivityLog drops entries with empty type, non-parseable timestamp, or invalid actor
- `tests/unit/normalize.test.js:109` normalizeActivityLog accepts ISO timestamps with UTC offset and microsecond precision
- `tests/unit/normalize.test.js:126` normalizeStringKeys deduplicates and trims
- `tests/unit/normalize.test.js:130` normalizeStringKeys filters empty strings and non-strings
- `tests/unit/normalize.test.js:134` normalizeStringKeys returns empty array for non-array input

### Security

- Path: `tests/unit/security.test.js`
- Type: Unit
- Test count: 2

- `tests/unit/security.test.js:4` escapeHtml encodes HTML-sensitive characters
- `tests/unit/security.test.js:8` formatBytes formats small and larger sizes

### Storage Idb

- Path: `tests/unit/storage-idb.test.js`
- Type: Unit
- Test count: 24

- `tests/unit/storage-idb.test.js:52` initStorage on empty IDB leaves boards list empty
- `tests/unit/storage-idb.test.js:57` initStorage creates a stable HLC node id on boot
- `tests/unit/storage-idb.test.js:63` initStorage is safe to call twice in the same session
- `tests/unit/storage-idb.test.js:74` saveTasks persists to IDB and survives a session reset
- `tests/unit/storage-idb.test.js:91` emitted task.updated events project into task read model
- `tests/unit/storage-idb.test.js:111` saveColumns persists to IDB and survives a session reset
- `tests/unit/storage-idb.test.js:129` saveSettings persists to IDB and survives a session reset
- `tests/unit/storage-idb.test.js:144` createBoard persists board list and per-board defaults across sessions
- `tests/unit/storage-idb.test.js:159` active board id persists across sessions
- `tests/unit/storage-idb.test.js:174` deleteBoard removes per-board data from IDB
- `tests/unit/storage-idb.test.js:196` v2 migration rehomes board read models and removes legacy kv keys
- `tests/unit/storage-idb.test.js:214` v2 migration deletes legacy board event logs
- `tests/unit/storage-idb.test.js:225` v2 schema creates event sourcing stores and event indexes
- `tests/unit/storage-idb.test.js:237` migrates multi-board localStorage data on first initStorage
- `tests/unit/storage-idb.test.js:263` migrates legacy done id to a UUID done role and rewrites task references
- `tests/unit/storage-idb.test.js:295` migration cleans up localStorage after completing
- `tests/unit/storage-idb.test.js:313` migrates legacy single-board localStorage keys (pre-multi-board format)
- `tests/unit/storage-idb.test.js:333` migrates legacy single-board tasks without columns using UUID default column mappings
- `tests/unit/storage-idb.test.js:355` migration does not run again on a subsequent initStorage call (same IDB)
- `tests/unit/storage-idb.test.js:374` initStorage with corrupt kanbanBoards in IDB yields empty boards list
- `tests/unit/storage-idb.test.js:388` loadTasksForBoard reads tasks for a non-active board without changing active board
- `tests/unit/storage-idb.test.js:405` loadColumnsForBoard reads columns for a non-active board
- `tests/unit/storage-idb.test.js:424` loadSettingsForBoard reads settings for a non-active board
- `tests/unit/storage-idb.test.js:440` loadTasksForBoard returns empty array for unknown board id

### Storage

- Path: `tests/unit/storage.test.js`
- Type: Unit
- Test count: 23

- `tests/unit/storage.test.js:28` ensureBoardsInitialized creates default board on empty storage
- `tests/unit/storage.test.js:37` ensureBoardsInitialized is idempotent
- `tests/unit/storage.test.js:46` listBoards returns empty array before any board is initialised
- `tests/unit/storage.test.js:52` createBoard creates board with correct keys
- `tests/unit/storage.test.js:63` createBoard uses Untitled board for empty name
- `tests/unit/storage.test.js:69` renameBoard updates board name
- `tests/unit/storage.test.js:80` renameBoard returns false for non-existent board
- `tests/unit/storage.test.js:85` renameBoard returns false for empty name
- `tests/unit/storage.test.js:91` updateBoardFields stores iteration fields on the board
- `tests/unit/storage.test.js:108` renameBoard preserves iteration fields
- `tests/unit/storage.test.js:120` updateBoardFields returns false without fields or board
- `tests/unit/storage.test.js:128` deleteBoard removes board and its data
- `tests/unit/storage.test.js:138` deleteBoard removes the last board and does not re-seed a default one
- `tests/unit/storage.test.js:147` deleteBoard switches active board if deleted board was active
- `tests/unit/storage.test.js:158` getActiveBoardName returns board name
- `tests/unit/storage.test.js:166` loadColumns returns default columns on fresh board
- `tests/unit/storage.test.js:175` loadColumns ensures Done column exists
- `tests/unit/storage.test.js:183` saveColumns + loadColumns roundtrip locks to the five fixed columns
- `tests/unit/storage.test.js:193` loadTasks leaves legacy removed fields in stored data untouched
- `tests/unit/storage.test.js:203` loadTasks adds doneDate to tasks in Done column that lack it
- `tests/unit/storage.test.js:213` loadTasks removes doneDate from tasks not in Done column
- `tests/unit/storage.test.js:223` saveTasks + loadTasks roundtrip
- `tests/unit/storage.test.js:234` loadSettings returns defaults on fresh board

### Tasks

- Path: `tests/unit/tasks.test.js`
- Type: Unit
- Test count: 35

- `tests/unit/tasks.test.js:21` addTask creates the task in Human In The Loop with order 1
- `tests/unit/tasks.test.js:31` addTask with only title, description, type and estimate keeps the slim model
- `tests/unit/tasks.test.js:45` addTask bumps existing task orders in the same column
- `tests/unit/tasks.test.js:55` addTask does nothing for empty title
- `tests/unit/tasks.test.js:60` addTask sets creationDate, changeDate, and columnHistory
- `tests/unit/tasks.test.js:72` updateTask updates title and description
- `tests/unit/tasks.test.js:82` updateTask does nothing for empty title
- `tests/unit/tasks.test.js:90` updateTask ignores a column supplied by a front-end caller
- `tests/unit/tasks.test.js:109` updateTask keeps the current column when none is passed
- `tests/unit/tasks.test.js:119` updateTask seeds columnHistory if missing
- `tests/unit/tasks.test.js:132` deleteTask removes task by ID
- `tests/unit/tasks.test.js:142` deleteTask refuses a task in the Finished column
- `tests/unit/tasks.test.js:168` deleteTask permanently removes task from live and deleted task lists by default
- `tests/unit/tasks.test.js:178` purgeDeleted hard-removes task tombstones from storage
- `tests/unit/tasks.test.js:191` purgeDeleted with { tasks: false } keeps task tombstones
- `tests/unit/tasks.test.js:204` addTask generates a board-prefixed key
- `tests/unit/tasks.test.js:213` addTask defaults the agile fields
- `tests/unit/tasks.test.js:228` addTask persists provided agile fields
- `tests/unit/tasks.test.js:247` addTask persists key points as { id, text, at } and flags them for digest
- `tests/unit/tasks.test.js:262` updateTask persists agile fields and rejects a self-parent
- `tests/unit/tasks.test.js:282` updateTask without extraFields leaves agile fields untouched
- `tests/unit/tasks.test.js:295` updateTask leaves assignee and parentId untouched when the payload omits them
- `tests/unit/tasks.test.js:308` updateTask replaces key points and comments wholesale
- `tests/unit/tasks.test.js:328` appending a key point in Backlog sets needsDigest
- `tests/unit/tasks.test.js:347` appending a key point in Human In The Loop sets needsDigest
- `tests/unit/tasks.test.js:360` appending a key point in Blocked sets needsDigest without moving the task
- `tests/unit/tasks.test.js:378` appending a key point to a Finished task returns it to Backlog with isRework
- `tests/unit/tasks.test.js:400` re-saving unchanged key points does not re-flag or move a Finished task
- `tests/unit/tasks.test.js:420` editing an undigested note keeps its id and leaves needsDigest set
- `tests/unit/tasks.test.js:440` appending a note after every note was digested re-opens needsDigest
- `tests/unit/tasks.test.js:461` deleting the last undigested note clears needsDigest
- `tests/unit/tasks.test.js:478` deleting the last undigested note while a digested note remains clears needsDigest
- `tests/unit/tasks.test.js:502` a stored legacy acceptanceCriteria array is read as key points
- `tests/unit/tasks.test.js:517` setTaskBlockedReason stores a trimmed reason and clears on empty
- `tests/unit/tasks.test.js:532` setTaskBlockedReason returns false for a missing task

### Utils

- Path: `tests/unit/utils.test.js`
- Type: Unit
- Test count: 4

- `tests/unit/utils.test.js:4` generateUUID returns a string
- `tests/unit/utils.test.js:8` generateUUID matches UUID v4 format
- `tests/unit/utils.test.js:13` generateUUID produces unique values
- `tests/unit/utils.test.js:19` generateUUID has version digit 4 at correct position

### Validation

- Path: `tests/unit/validation.test.js`
- Type: Unit
- Test count: 5

- `tests/unit/validation.test.js:6` validateTaskTitle returns true for non-empty string
- `tests/unit/validation.test.js:10` validateTaskTitle returns true for whitespace-padded non-empty string
- `tests/unit/validation.test.js:14` validateTaskTitle returns false for empty string
- `tests/unit/validation.test.js:18` validateTaskTitle returns false for whitespace-only string
- `tests/unit/validation.test.js:22` validateTaskTitle returns false for null and undefined

### Wip Limit

- Path: `tests/unit/wip-limit.test.js`
- Type: Unit
- Test count: 11

- `tests/unit/wip-limit.test.js:15` normalizeWipLimit > coerces anything that is not a positive integer to unlimited
- `tests/unit/wip-limit.test.js:26` normalizeWipLimit > accepts numeric strings and floors fractions
- `tests/unit/wip-limit.test.js:32` normalizeWipLimit > caps at MAX_WIP_LIMIT
- `tests/unit/wip-limit.test.js:38` getWipLimit > reads the column limit
- `tests/unit/wip-limit.test.js:43` getWipLimit > Done is exempt in both role and legacy-id form
- `tests/unit/wip-limit.test.js:48` getWipLimit > tolerates a missing column
- `tests/unit/wip-limit.test.js:55` getWipState > under below the limit
- `tests/unit/wip-limit.test.js:60` getWipState > at exactly the limit
- `tests/unit/wip-limit.test.js:64` getWipState > over above the limit
- `tests/unit/wip-limit.test.js:69` getWipState > an unlimited or Done column is never at or over
- `tests/unit/wip-limit.test.js:76` import boundary > normalizeBoardModelIds coerces an untrusted wipLimit

## DOM Integration Tests

### Accordion

- Path: `tests/dom/accordion.test.js`
- Type: DOM Integration
- Test count: 1

- `tests/dom/accordion.test.js:6` createAccordionSection toggles collapsed state and updates the chevron

### Board Create Modal

- Path: `tests/dom/board-create-modal.test.js`
- Type: DOM Integration
- Test count: 5

- `tests/dom/board-create-modal.test.js:175` board create modal > opening as a plain board shows the Create New Board wording
- `tests/dom/board-create-modal.test.js:183` board create modal > a successful submit creates the board with a derived iteration name, activates it, hides the modal and dispatches kanban:boards-changed
- `tests/dom/board-create-modal.test.js:207` board create modal > the create dialog asks for no board name and has no template picker
- `tests/dom/board-create-modal.test.js:228` Human In The Loop manual add > the Human In The Loop add-task control opens the full task modal for that column
- `tests/dom/board-create-modal.test.js:264` Human In The Loop manual add > columns other than Human In The Loop expose no manual add-task control

### Board Groups Sync

- Path: `tests/dom/board-groups-sync.test.js`
- Type: DOM Integration
- Test count: 4

- `tests/dom/board-groups-sync.test.js:95` sidebar group sync > the first render creates one group and binds every board exactly once
- `tests/dom/board-groups-sync.test.js:106` sidebar group sync > a group state pushed by another client is adopted without re-emitting known groups
- `tests/dom/board-groups-sync.test.js:128` sidebar group sync > the server echo of the local state re-emits nothing and does not rebuild the tree
- `tests/dom/board-groups-sync.test.js:141` sidebar group sync > a rename committed in the sidebar emits exactly one group.updated

### Board Order

- Path: `tests/dom/board-order.test.js`
- Type: DOM Integration
- Test count: 6

- `tests/dom/board-order.test.js:53` an undigested note sorts a task to the front of its own column
- `tests/dom/board-order.test.js:72` a column orders by entry time, using the latest matching history entry
- `tests/dom/board-order.test.js:94` the stored order field does not decide the display order
- `tests/dom/board-order.test.js:106` equal entry times fall back to the id, not the input order
- `tests/dom/board-order.test.js:119` the rendered board carries no drag or drop affordance
- `tests/dom/board-order.test.js:131` the human column-move modules and styles are gone

### Board Sidebar

- Path: `tests/dom/board-sidebar.test.js`
- Type: DOM Integration
- Test count: 27

- `tests/dom/board-sidebar.test.js:97` sidebar group tree > renders the user-set group names
- `tests/dom/board-sidebar.test.js:109` sidebar group tree > a board without a group is placed in the last group on render
- `tests/dom/board-sidebar.test.js:125` sidebar group tree > creates a group for existing boards when none exists
- `tests/dom/board-sidebar.test.js:135` sidebar group tree > marks the active iteration
- `tests/dom/board-sidebar.test.js:143` sidebar group tree > clicking an iteration switches the active board and emits DATA_CHANGED
- `tests/dom/board-sidebar.test.js:156` sidebar group tree > numbers a group in display order
- `tests/dom/board-sidebar.test.js:173` sidebar group tree > renumbers after an iteration is created
- `tests/dom/board-sidebar.test.js:188` sidebar group tree > renumbers after an iteration is deleted
- `tests/dom/board-sidebar.test.js:210` sidebar group tree > only the last iteration in a group offers a delete control
- `tests/dom/board-sidebar.test.js:231` sidebar group tree > renumbers both groups when an iteration moves between them
- `tests/dom/board-sidebar.test.js:256` sidebar group tree > an iteration cannot be renamed by hand
- `tests/dom/board-sidebar.test.js:276` sidebar group tree > the chevron collapses a group and persists the state
- `tests/dom/board-sidebar.test.js:289` sidebar group tree > clicking a group name toggles collapse and updates both aria-expanded states
- `tests/dom/board-sidebar.test.js:313` sidebar group tree > Enter and Space on the focused group name toggle collapse immediately
- `tests/dom/board-sidebar.test.js:329` sidebar group tree > double-clicking a group name opens the rename input and Enter commits the name
- `tests/dom/board-sidebar.test.js:348` sidebar group tree > Escape in the group rename input keeps the old name
- `tests/dom/board-sidebar.test.js:361` sidebar group tree > #add-group-btn opens a name input without creating a group
- `tests/dom/board-sidebar.test.js:377` sidebar group tree > committing the typed name creates the group with that name
- `tests/dom/board-sidebar.test.js:394` sidebar group tree > committing an empty name creates nothing and keeps the input open
- `tests/dom/board-sidebar.test.js:408` sidebar group tree > Escape cancels the new-group input and creates nothing
- `tests/dom/board-sidebar.test.js:422` sidebar group tree > a group created from the add control is still renameable afterwards
- `tests/dom/board-sidebar.test.js:439` sidebar group tree > a group's add control creates the next iteration immediately, with no dialog
- `tests/dom/board-sidebar.test.js:459` sidebar group tree > deleting a group takes its iterations with it
- `tests/dom/board-sidebar.test.js:479` sidebar group tree > deleting an iteration needs two clicks
- `tests/dom/board-sidebar.test.js:490` sidebar group tree > the finished prefix gets one collapse control that hides only the prefix
- `tests/dom/board-sidebar.test.js:535` sidebar group tree > a group with an unfinished first iteration shows no prefix control
- `tests/dom/board-sidebar.test.js:548` sidebar group tree > a group whose iterations are all finished shows no prefix control

### Boards Quick Switch

- Path: `tests/dom/boards-quick-switch.test.js`
- Type: DOM Integration
- Test count: 11

- `tests/dom/boards-quick-switch.test.js:88` click brand-text > does not open the boards modal
- `tests/dom/boards-quick-switch.test.js:99` delete board > removes the local board after confirmation
- `tests/dom/boards-quick-switch.test.js:112` Ctrl+B shortcut > opens the boards modal
- `tests/dom/boards-quick-switch.test.js:120` Ctrl+B shortcut > does not open the boards modal with the old Shift+B shortcut
- `tests/dom/boards-quick-switch.test.js:130` Ctrl+B shortcut > does not open the modal when an input is focused
- `tests/dom/boards-quick-switch.test.js:143` keyboard navigation in open boards modal > ArrowDown adds keyboard-focused to the first item on first press
- `tests/dom/boards-quick-switch.test.js:156` keyboard navigation in open boards modal > ArrowDown then ArrowDown moves focus to second item
- `tests/dom/boards-quick-switch.test.js:167` keyboard navigation in open boards modal > ArrowUp does not go below index 0
- `tests/dom/boards-quick-switch.test.js:178` keyboard navigation in open boards modal > does not navigate when modal is closed
- `tests/dom/boards-quick-switch.test.js:193` keyboard navigation in open boards modal > Enter on highlighted board activates it and closes the modal
- `tests/dom/boards-quick-switch.test.js:205` keyboard navigation in open boards modal > Enter does nothing when no item is highlighted

### Feature Modules Emit Events

- Path: `tests/dom/event-sourcing/feature-modules-emit-events.test.js`
- Type: DOM Integration
- Test count: 3

- `tests/dom/event-sourcing/feature-modules-emit-events.test.js:33` updateTask emits one task.updated event with HLC entity id and minimal fields
- `tests/dom/event-sourcing/feature-modules-emit-events.test.js:67` updateTask emits relationship events for non-scalar changes and never a move
- `tests/dom/event-sourcing/feature-modules-emit-events.test.js:96` deleteTask emits task.deleted

### Replay Fidelity

- Path: `tests/dom/event-sourcing/replay-fidelity.test.js`
- Type: DOM Integration
- Test count: 3

- `tests/dom/event-sourcing/replay-fidelity.test.js:70` updateTask relationship change replays the inverse on the target task
- `tests/dom/event-sourcing/replay-fidelity.test.js:86` addTask replays the sibling reorder in the column
- `tests/dom/event-sourcing/replay-fidelity.test.js:107` moving a task into and out of the done column replays its doneDate

### Folder Sync Ui

- Path: `tests/dom/folder-sync-ui.test.js`
- Type: DOM Integration
- Test count: 8

- `tests/dom/folder-sync-ui.test.js:170` mounts into the settings form before its actions and is idempotent
- `tests/dom/folder-sync-ui.test.js:180` without the File System Access API the control is disabled with a calm explanation
- `tests/dom/folder-sync-ui.test.js:191` linking shows the folder, switches transport mode and reveals the manual sync action
- `tests/dom/folder-sync-ui.test.js:204` a cancelled picker changes nothing and shows no error
- `tests/dom/folder-sync-ui.test.js:223` a failed link surfaces through the existing alert dialog
- `tests/dom/folder-sync-ui.test.js:239` routes each local event into the shard exactly once across repeated mounts
- `tests/dom/folder-sync-ui.test.js:261` unlinking returns to the previous transport mode and keeps the unlinked state
- `tests/dom/folder-sync-ui.test.js:273` the manual sync action merges a shard written outside the browser

### Mobile Column Switcher

- Path: `tests/dom/mobile-column-switcher.test.js`
- Type: DOM Integration
- Test count: 13

- `tests/dom/mobile-column-switcher.test.js:84` lists all five columns as tabs, in board order, with their accent and count
- `tests/dom/mobile-column-switcher.test.js:112` keeps every column mounted and marks exactly one active
- `tests/dom/mobile-column-switcher.test.js:122` defaults to the first column that has tasks
- `tests/dom/mobile-column-switcher.test.js:131` falls back to Backlog when no column has tasks
- `tests/dom/mobile-column-switcher.test.js:138` tapping a tab moves the active column and the tab state with it
- `tests/dom/mobile-column-switcher.test.js:156` switching columns keeps the task cards, their controls and their handlers
- `tests/dom/mobile-column-switcher.test.js:174` keeps the selection when DATA_CHANGED rebuilds the board
- `tests/dom/mobile-column-switcher.test.js:186` refreshes the counts after the board changes
- `tests/dom/mobile-column-switcher.test.js:196` arrow keys move between tabs, Home and End jump, and Tab is never swallowed
- `tests/dom/mobile-column-switcher.test.js:225` each tab owns a real tabpanel through aria-controls
- `tests/dom/mobile-column-switcher.test.js:241` sits directly above the board container, inside the board column
- `tests/dom/mobile-column-switcher.test.js:249` on a wide viewport the columns carry no panel semantics but stay mounted
- `tests/dom/mobile-column-switcher.test.js:263` an empty board list renders the empty state with no switcher

### Settings Ui

- Path: `tests/dom/settings-ui.test.js`
- Type: DOM Integration
- Test count: 2

- `tests/dom/settings-ui.test.js:37` settings modal opens with the surviving board settings controls
- `tests/dom/settings-ui.test.js:56` settings changes persist through board settings

### Skills Modal

- Path: `tests/dom/skills-modal.test.js`
- Type: DOM Integration
- Test count: 11

- `tests/dom/skills-modal.test.js:101` skills modal > opens from the header button and closes via the close button
- `tests/dom/skills-modal.test.js:113` skills modal > closes via the backdrop
- `tests/dom/skills-modal.test.js:122` skills modal > renders stored skills, selects the first, and shows its content
- `tests/dom/skills-modal.test.js:140` skills modal > clicking another skill moves the selection and loads its fields
- `tests/dom/skills-modal.test.js:153` skills modal > shows the empty state instead of the editor when no skills exist
- `tests/dom/skills-modal.test.js:161` skills modal > add creates a skill, selects it, and focuses the name field
- `tests/dom/skills-modal.test.js:175` skills modal > save persists all fields and emits DATA_CHANGED
- `tests/dom/skills-modal.test.js:194` skills modal > delete arms on the first click and deletes on the second
- `tests/dom/skills-modal.test.js:214` skills modal > blur cancels an armed delete
- `tests/dom/skills-modal.test.js:229` skills modal > Escape closes the modal
- `tests/dom/skills-modal.test.js:238` skills modal > re-renders when DATA_CHANGED is emitted

### Task Card Delete

- Path: `tests/dom/task-card-delete.test.js`
- Type: DOM Integration
- Test count: 7

- `tests/dom/task-card-delete.test.js:55` the first click arms the delete button instead of deleting
- `tests/dom/task-card-delete.test.js:67` the second click confirms and deletes the task
- `tests/dom/task-card-delete.test.js:78` an armed button disarms itself after the confirm window
- `tests/dom/task-card-delete.test.js:93` renders no delete control for a card in the Finished column
- `tests/dom/task-card-delete.test.js:100` keeps the delete control for a card in another column
- `tests/dom/task-card-delete.test.js:107` keeps the row actions container on both cards so the header does not shift
- `tests/dom/task-card-delete.test.js:116` a Finished card still opens the task dialog and keeps its notes

### Task Card Linkify

- Path: `tests/dom/task-card-linkify.test.js`
- Type: DOM Integration
- Test count: 14

- `tests/dom/task-card-linkify.test.js:12` linkifyText > plain text with no URL is rendered as a text node
- `tests/dom/task-card-linkify.test.js:18` linkifyText > https URL becomes a clickable link
- `tests/dom/task-card-linkify.test.js:26` linkifyText > http URL becomes a clickable link
- `tests/dom/task-card-linkify.test.js:33` linkifyText > link opens in a new tab with noopener noreferrer
- `tests/dom/task-card-linkify.test.js:40` linkifyText > surrounding text is preserved around the link
- `tests/dom/task-card-linkify.test.js:47` linkifyText > multiple URLs in one description each become a link
- `tests/dom/task-card-linkify.test.js:55` linkifyText > empty string returns an empty fragment
- `tests/dom/task-card-linkify.test.js:61` linkifyText > non-http scheme is not linkified
- `tests/dom/task-card-linkify.test.js:78` updateDescriptionLinks (modal preview strip) > hidden when text has no URLs
- `tests/dom/task-card-linkify.test.js:84` updateDescriptionLinks (modal preview strip) > shows a chip for a single URL
- `tests/dom/task-card-linkify.test.js:94` updateDescriptionLinks (modal preview strip) > deduplicates the same URL appearing twice
- `tests/dom/task-card-linkify.test.js:100` updateDescriptionLinks (modal preview strip) > shows one chip per distinct URL
- `tests/dom/task-card-linkify.test.js:106` updateDescriptionLinks (modal preview strip) > hides and clears when called with empty string
- `tests/dom/task-card-linkify.test.js:114` updateDescriptionLinks (modal preview strip) > non-http scheme does not produce a chip

### Task Modal Agile

- Path: `tests/dom/task-modal-agile.test.js`
- Type: DOM Integration
- Test count: 15

- `tests/dom/task-modal-agile.test.js:170` the dialog renders the title, the description and the notes list and nothing else
- `tests/dom/task-modal-agile.test.js:194` the add form saves the title, description and notes through addTask
- `tests/dom/task-modal-agile.test.js:211` the notes input appends one line per Enter press, clears itself and removes a line
- `tests/dom/task-modal-agile.test.js:246` opening the edit dialog prefills the title, description and notes
- `tests/dom/task-modal-agile.test.js:268` editing a task saves the slim payload through updateTask
- `tests/dom/task-modal-agile.test.js:295` a task outside Human In The Loop shows the agent title and description as content and only the notes stay interactive
- `tests/dom/task-modal-agile.test.js:314` a Human In The Loop task keeps the title and the description editable
- `tests/dom/task-modal-agile.test.js:326` an In Progress task is view-only with the notes control visibly unavailable
- `tests/dom/task-modal-agile.test.js:344` the dialog shows who holds the claim and for how long
- `tests/dom/task-modal-agile.test.js:358` the claim line is hidden when nobody holds the task
- `tests/dom/task-modal-agile.test.js:368` an undigested note edits inline: Enter commits the new text and Escape reverts it
- `tests/dom/task-modal-agile.test.js:407` an edit typed without Enter still reaches the save
- `tests/dom/task-modal-agile.test.js:423` a digested note is read-only and carries a marker that says why
- `tests/dom/task-modal-agile.test.js:448` a mixed notes list keeps edit and remove on the undigested note only
- `tests/dom/task-modal-agile.test.js:474` adding a note to a Backlog task saves the unchanged agent title and description

### Task Row

- Path: `tests/dom/task-row.test.js`
- Type: DOM Integration
- Test count: 12

- `tests/dom/task-row.test.js:42` renders a single compact row with the title and no card chrome
- `tests/dom/task-row.test.js:53` renders a one-line description preview when a description is present
- `tests/dom/task-row.test.js:61` omits the description preview when there is no description
- `tests/dom/task-row.test.js:66` renders the key points list in order
- `tests/dom/task-row.test.js:79` omits the key points list when there are none
- `tests/dom/task-row.test.js:84` shows needsDigest and isRework as quiet markers when set
- `tests/dom/task-row.test.js:96` marks undigested notes in Backlog, Blocked and Finished only, with an icon and a label
- `tests/dom/task-row.test.js:113` carries rework as its own marker with an icon and a label
- `tests/dom/task-row.test.js:124` omits the signal marker when neither flag is set
- `tests/dom/task-row.test.js:129` renders nothing else: no type, estimate, key, assignee, timer, notes or status chip
- `tests/dom/task-row.test.js:159` clicking the title opens the task editor
- `tests/dom/task-row.test.js:166` keeps the delete control inside the row actions

### Wip Limit

- Path: `tests/dom/wip-limit.test.js`
- Type: DOM Integration
- Test count: 2

- `tests/dom/wip-limit.test.js:17` syncColumnWip > drives data-wip through under, at and over
- `tests/dom/wip-limit.test.js:30` syncColumnWip > an unlimited column stays under at any count
