import { listBoards, loadTasksForBoard, loadColumnsForBoard, loadSettingsForBoard } from './storage.js';
import { isHexColor, boardDisplayName } from './normalize.js';
import { DONE_COLUMN_ID } from './constants.js';
import { alertDialog } from './dialog.js';
import { inspectImportPayload } from './import-payload.js';

const EXPORT_SCHEMA_VERSION = 1;

function getCurrentAppVersion() {
  if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim()) {
    return __APP_VERSION__.trim();
  }
  return 'unknown';
}

function buildExportMeta() {
  return {
    appVersion: getCurrentAppVersion(),
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString()
  };
}

function normalizeSettingsForExport(settings) {
  const obj = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const showChangeDate = obj.showChangeDate !== false;
  const locale = typeof obj.locale === 'string' && obj.locale.trim()
    ? obj.locale.trim()
    : (typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : 'en-US');
  return {
    showChangeDate,
    locale
  };
}

function normalizeTaskForExport(task, doneColumnIds = new Set([DONE_COLUMN_ID])) {
  const legacyTitle = typeof task?.text === 'string' ? task.text : '';
  const title = typeof task?.title === 'string' ? task.title : legacyTitle;
  const description = typeof task?.description === 'string' ? task.description : '';
  const changeDate =
    typeof task?.changeDate === 'string'
      ? task.changeDate
      : (typeof task?.changedDate === 'string' ? task.changedDate : undefined);

  const isDone = doneColumnIds.has(task?.column) || task?.column === DONE_COLUMN_ID;
  const doneDate = typeof task?.doneDate === 'string' ? task.doneDate.toString().trim() : '';

  const columnHistory = Array.isArray(task?.columnHistory)
    ? task.columnHistory
        .map((e) => {
          const column = typeof e?.column === 'string' ? e.column.trim() : '';
          const at = typeof e?.at === 'string' ? e.at.trim() : '';
          if (!column || !at) return null;
          return { column, at };
        })
        .filter(Boolean)
    : undefined;

  const exported = {
    id: typeof task?.id === 'string' ? task.id : String(task?.id ?? ''),
    key: typeof task?.key === 'string' ? task.key : undefined,
    title: title.toString().trim(),
    description: description.toString().trim(),
    type: typeof task?.type === 'string' ? task.type : undefined,
    estimate: Number.isFinite(task?.estimate) ? task.estimate : (task?.estimate === null ? null : undefined),
    assignee: typeof task?.assignee === 'string' ? task.assignee : undefined,
    parentId: typeof task?.parentId === 'string' ? task.parentId : undefined,
    keyPoints: Array.isArray(task?.keyPoints) ? task.keyPoints : undefined,
    comments: Array.isArray(task?.comments) ? task.comments : undefined,
    relationships: Array.isArray(task?.relationships) ? task.relationships : undefined,
    column: typeof task?.column === 'string' ? task.column : undefined,
    order: Number.isFinite(task?.order) ? task.order : undefined,
    creationDate: typeof task?.creationDate === 'string' ? task.creationDate : undefined,
    changeDate: typeof changeDate === 'string' ? changeDate.toString().trim() : undefined,
    columnHistory: columnHistory && columnHistory.length ? columnHistory : undefined,
    doneDate: isDone && doneDate ? doneDate : undefined,
    blockedReason: typeof task?.blockedReason === 'string' ? task.blockedReason : undefined,
    blockedAt: typeof task?.blockedAt === 'string' ? task.blockedAt : undefined,
    claimedBy: typeof task?.claimedBy === 'string' ? task.claimedBy : undefined,
    claimedAt: typeof task?.claimedAt === 'string' ? task.claimedAt : undefined,
    deleted: task?.deleted === true ? true : undefined
  };

  for (const field of Object.keys(exported)) {
    if (exported[field] === undefined) delete exported[field];
  }
  return exported;
}

// Export a specific board to JSON by boardId (does not switch active board).
export function exportBoard(boardId) {
  const id = typeof boardId === 'string' ? boardId.trim() : '';
  if (!id) return;

  const board = listBoards().find((b) => b.id === id);
  const boardName = boardDisplayName(board);

  const rawTasks = loadTasksForBoard(id);
  const rawColumns = loadColumnsForBoard(id);
  const rawSettings = loadSettingsForBoard(id);

  const columns = rawColumns.map((c) => ({
    ...c,
    color: isHexColor(c?.color) ? c.color.trim() : '#3b82f6',
    collapsed: c?.collapsed === true
  }));
  const doneColumnIds = new Set(columns.filter((column) => column.role === 'done' || column.id === DONE_COLUMN_ID).map((column) => column.id));
  doneColumnIds.add(DONE_COLUMN_ID);
  const tasks = rawTasks.map((task) => normalizeTaskForExport(task, doneColumnIds));
  const settings = normalizeSettingsForExport(rawSettings);
  const exportMeta = buildExportMeta();
  const exportData = { boardName, columns, tasks, settings, exportMeta };

  const integrity = inspectImportPayload(exportData, null);
  if (integrity.errors.length > 0) {
    void alertDialog({
      title: 'Export Blocked',
      message: integrity.errors.join(' ')
    });
    return;
  }

  const dataStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${boardName.replaceAll(' ', '_').replaceAll('.', '_')}_board_${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
