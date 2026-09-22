import { isHexColor } from './normalize.js';
import { normalizeKeyPoints } from './agile.js';
import { DONE_COLUMN_ID } from './constants.js';

export function normalizeImportedTasks(tasks, doneColumnIds = new Set([DONE_COLUMN_ID])) {
  if (!Array.isArray(tasks)) return null;

  const normalized = tasks.map((t) => {
    const id = typeof t?.id === 'string' ? t.id : String(t?.id ?? '');
    const legacyText = typeof t?.text === 'string' ? t.text : String(t?.text ?? '');
    const title = typeof t?.title === 'string' ? t.title : legacyText;
    const description = typeof t?.description === 'string' ? t.description : String(t?.description ?? '');
    const column = typeof t?.column === 'string' ? t.column : String(t?.column ?? '');

    const order = Number.isFinite(t?.order) ? t.order : undefined;
    const creationDate = typeof t?.creationDate === 'string' ? t.creationDate : undefined;
    const changeDate =
      typeof t?.changeDate === 'string'
        ? t.changeDate
        : (typeof t?.changedDate === 'string' ? t.changedDate : undefined);

    const doneDateRaw = typeof t?.doneDate === 'string' ? t.doneDate.trim() : '';
    const isDone = doneColumnIds.has(column.trim()) || column.trim() === DONE_COLUMN_ID;
    const doneDate = isDone
      ? (doneDateRaw || (typeof changeDate === 'string' ? changeDate.trim() : '') || (creationDate || ''))
      : '';

    const columnHistory = Array.isArray(t?.columnHistory)
      ? t.columnHistory
          .map((e) => {
            const column = typeof e?.column === 'string' ? e.column.trim() : String(e?.column ?? '').trim();
            const at = typeof e?.at === 'string' ? e.at.trim() : String(e?.at ?? '').trim();
            if (!column || !at) return null;
            return { column, at };
          })
          .filter(Boolean)
      : undefined;

    return {
      id: id.trim(),
      title: title.trim(),
      description: description.trim(),
      column: column.trim(),
      keyPoints: normalizeKeyPoints(Array.isArray(t?.keyPoints) ? t.keyPoints : t?.acceptanceCriteria),
      ...(order !== undefined ? { order } : {}),
      ...(creationDate ? { creationDate } : {}),
      ...(typeof changeDate === 'string' && changeDate.trim() ? { changeDate: changeDate.trim() } : {}),
      ...(doneDate ? { doneDate } : {}),
      relationships: Array.isArray(t?.relationships) ? t.relationships : [],
      ...(columnHistory && columnHistory.length ? { columnHistory } : {})
    };
  });

  const isValid = normalized.every((t) => t.id && t.title && t.column);
  return isValid ? normalized : null;
}

export function normalizeImportedColumns(columns) {
  if (!Array.isArray(columns)) return null;

  const normalized = columns.map((c) => {
    const id = typeof c?.id === 'string' ? c.id : String(c?.id ?? '');
    const name = typeof c?.name === 'string' ? c.name : String(c?.name ?? '');
    const order = Number.isFinite(c?.order) ? c.order : undefined;
    const color = isHexColor(c?.color) ? c.color.trim() : '#3b82f6';
    const collapsed = c?.collapsed === true;
    return {
      id: id.trim(),
      name: name.trim(),
      color,
      collapsed,
      ...(id.trim() === DONE_COLUMN_ID || c?.role === 'done' ? { role: 'done' } : {}),
      ...(order !== undefined ? { order } : {})
    };
  });

  // Ensure the permanent Done column always exists.
  if (!normalized.some((c) => c.id === DONE_COLUMN_ID || c.role === 'done')) {
    const maxOrder = normalized.reduce((max, c) => Math.max(max, Number.isFinite(c?.order) ? c.order : 0), 0);
    normalized.push({ id: DONE_COLUMN_ID, name: 'Finished', color: '#6d6d6d', order: maxOrder + 1, collapsed: false, role: 'done' });
  }

  const isValid = normalized.every((c) => c.id && c.name);
  return isValid ? normalized : null;
}

export function normalizeImportedSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;

  const showChangeDate = settings.showChangeDate !== false;
  const locale = typeof settings.locale === 'string' && settings.locale.trim() ? settings.locale.trim() : undefined;
  return {
    showChangeDate,
    ...(locale ? { locale } : {})
  };
}
