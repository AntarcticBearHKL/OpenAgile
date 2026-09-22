import {
  isHexColor,
  defaultColumnColor,
} from './normalize.js';
import { DONE_COLUMN_ROLE, FIXED_COLUMNS, isDoneColumn } from './constants.js';
import { defaultSettings } from './storage-defaults.js';

export function normalizeColumn(c) {
  const color = isHexColor(c?.color) ? c.color.trim() : defaultColumnColor(c?.id);
  const collapsed = c?.collapsed === true;
  return { ...c, color, collapsed, ...(isDoneColumn(c) ? { role: DONE_COLUMN_ROLE } : {}) };
}

export function ensureFixedColumns(columns) {
  const stored = new Map(
    (Array.isArray(columns) ? columns : [])
      .filter((column) => column && typeof column.id === 'string')
      .map((column) => [column.id, column])
  );

  return FIXED_COLUMNS.map((template) => {
    const previous = stored.get(template.id) || {};
    return {
      ...template,
      color: isHexColor(previous.color) ? previous.color : template.color,
      collapsed: previous.collapsed === true,
      wipLimit: Number.isFinite(previous.wipLimit) ? previous.wipLimit : 0
    };
  });
}

export function normalizeSettings(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const locale = typeof obj.locale === 'string' && obj.locale.trim() ? obj.locale.trim() : defaultSettings().locale;
  const showChangeDate = obj.showChangeDate !== false;

  return {
    showChangeDate,
    locale
  };
}
