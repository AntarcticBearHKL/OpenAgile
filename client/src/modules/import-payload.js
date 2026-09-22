import { normalizeBoardModelIds } from './board-serializer.js';
import { normalizeImportedTasks, normalizeImportedColumns, normalizeImportedSettings } from './import-normalize.js';
import { formatBytes } from './security.js';
import { DONE_COLUMN_ID } from './constants.js';

export const IMPORT_LIMITS = {
  maxFileSizeBytes: 2 * 1024 * 1024,
  warningFileSizeBytes: 512 * 1024,
  maxTasks: 5000,
  warningTasks: 1000,
  maxColumns: 100,
  warningColumns: 25
};

function legacyDefaultColumnsForImport() {
  return [
    { id: 'todo', name: 'To Do', color: '#3583ff', order: 1, collapsed: false },
    { id: 'inprogress', name: 'In Progress', color: '#f59e0b', order: 2, collapsed: false },
    { id: DONE_COLUMN_ID, name: 'Finished', color: '#505050', order: 3, collapsed: false, role: 'done' }
  ];
}

function boardNameFromFile(file) {
  const name = typeof file?.name === 'string' ? file.name.trim() : '';
  if (!name) return '';
  return name.replace(/\.[^.]+$/, '').trim();
}

function getImportSections(data) {
  if (Array.isArray(data)) {
    return {
      tasks: data,
      columns: null,
      settings: null,
      boardName: null,
      exportMeta: null,
      format: 'legacy-tasks'
    };
  }

  if (data && typeof data === 'object' && data.tasks && data.columns) {
    return {
      tasks: data.tasks,
      columns: data.columns,
      settings: Object.prototype.hasOwnProperty.call(data, 'settings') ? data.settings : null,
      boardName: typeof data.boardName === 'string' ? data.boardName.trim() : null,
      exportMeta: data.exportMeta && typeof data.exportMeta === 'object' ? data.exportMeta : null,
      format: 'board-export'
    };
  }

  return null;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function validateImportFileMetadata(file) {
  const errors = [];
  const warnings = [];
  const fileSize = Number.isFinite(file?.size) ? file.size : 0;

  if (fileSize > IMPORT_LIMITS.maxFileSizeBytes) {
    errors.push(`Import file is too large (${formatBytes(fileSize)}). Maximum supported size is ${formatBytes(IMPORT_LIMITS.maxFileSizeBytes)}.`);
  } else if (fileSize > IMPORT_LIMITS.warningFileSizeBytes) {
    warnings.push(`Large import file detected (${formatBytes(fileSize)}). Importing may be slow on some browsers.`);
  }

  return { errors, warnings, fileSize };
}

export function inspectImportPayload(data, file = null) {
  const metadata = validateImportFileMetadata(file);
  const errors = [...metadata.errors];
  const warnings = [...metadata.warnings];
  const fileSize = metadata.fileSize;

  const sections = getImportSections(data);
  if (!sections) {
    errors.push('Invalid JSON file format. Expected either a task array or a board export object containing tasks and columns.');
    return { errors, warnings, fileSize };
  }

  const { tasks, columns, settings, boardName, exportMeta, format } = sections;
  const normalizedColumns = columns ? normalizeImportedColumns(columns) : (format === 'legacy-tasks' ? normalizeImportedColumns(legacyDefaultColumnsForImport()) : null);
  const doneColumnIds = new Set((normalizedColumns || []).filter((column) => column.role === 'done' || column.id === DONE_COLUMN_ID).map((column) => column.id));
  doneColumnIds.add(DONE_COLUMN_ID);
  const normalizedTasks = normalizeImportedTasks(tasks, doneColumnIds);
  const normalizedSettings = settings ? normalizeImportedSettings(settings) : null;

  if (!normalizedTasks || (columns && !normalizedColumns) || (settings && !normalizedSettings)) {
    errors.push('Invalid data structure. One or more imported sections do not match the expected schema.');
    return { errors, warnings, fileSize, format };
  }

  if (format === 'legacy-tasks') {
    warnings.push('Legacy task-only import detected. Default columns and settings will be used for the new board.');
  }

  if (normalizedTasks.length > IMPORT_LIMITS.maxTasks) {
    errors.push(`Import contains too many tasks (${normalizedTasks.length}). Maximum supported task count is ${IMPORT_LIMITS.maxTasks}.`);
  } else if (normalizedTasks.length > IMPORT_LIMITS.warningTasks) {
    warnings.push(`Import contains ${normalizedTasks.length} tasks. Rendering and storage operations may feel slow.`);
  }

  const columnCount = normalizedColumns?.length ?? 0;
  if (columnCount > IMPORT_LIMITS.maxColumns) {
    errors.push(`Import contains too many columns (${columnCount}). Maximum supported column count is ${IMPORT_LIMITS.maxColumns}.`);
  } else if (columnCount > IMPORT_LIMITS.warningColumns) {
    warnings.push(`Import contains ${columnCount} columns. Board navigation may become difficult on smaller screens.`);
  }

  if (normalizedColumns) {
    const columnIds = new Set(normalizedColumns.map((column) => column.id));
    const missingColumns = [...new Set(normalizedTasks.filter((task) => !columnIds.has(task.column)).map((task) => task.column))];
    if (missingColumns.length > 0) {
      const availableColumns = normalizedColumns.map((column) => column.id).join(', ') || '(none)';
      errors.push(
        `Import references unknown columns: ${missingColumns.join(', ')}. ` +
        `Fix the JSON manually before importing: either add matching entries to columns[].id, ` +
        `or change task.column values to existing column ids. Existing column ids: ${availableColumns}.`
      );
    }
  }

  const normalizedBoard = normalizeBoardModelIds({
    columns: normalizedColumns || undefined,
    tasks: normalizedTasks,
    settings: normalizedSettings || undefined
  });

  const finalColumns = normalizedColumns ? normalizedBoard.columns : null;
  const finalSettings = normalizedSettings ? normalizedBoard.settings : null;

  const importedName = boardName || boardNameFromFile(file) || 'Imported board';

  return {
    errors,
    warnings,
    fileSize,
    format,
    exportMeta,
    importedName,
    normalizedTasks: normalizedBoard.tasks,
    normalizedColumns: finalColumns,
    normalizedSettings: finalSettings,
    summary: {
      tasks: normalizedTasks.length,
      columns: columnCount,
      includesSettings: Boolean(normalizedSettings)
    }
  };
}

export function buildImportConfirmationMessage(preview) {
  const summaryParts = [
    pluralize(preview?.summary?.tasks ?? 0, 'task'),
    pluralize(preview?.summary?.columns ?? 0, 'column')
  ];

  if (preview?.summary?.includesSettings) {
    summaryParts.push('settings included');
  }

  if (typeof preview?.exportMeta?.appVersion === 'string' && preview.exportMeta.appVersion.trim()) {
    summaryParts.push(`exported with app v${preview.exportMeta.appVersion.trim()}`);
  }

  const parts = [
    `This import will create a new board named "${preview?.importedName || 'Imported board'}" and switch to it.`,
    `File size: ${formatBytes(preview?.fileSize ?? 0)}.`,
    `Contents: ${summaryParts.join(', ')}.`
  ];

  if (Array.isArray(preview?.warnings) && preview.warnings.length > 0) {
    parts.push(`Warnings: ${preview.warnings.join(' ')}`);
  }

  return parts.join(' ');
}
