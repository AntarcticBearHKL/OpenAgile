import { FIXED_COLUMNS } from './constants.js';

// ── Default data ───────────────────────────────────────────────────────────────

export function defaultColumns() {
  return FIXED_COLUMNS.map((column) => ({ ...column }));
}

export function defaultBoardData(includeTasks = true) {
  const columns = defaultColumns();
  return {
    columns,
    tasks: [],
    settings: defaultSettings()
  };
}

// Default board scaffold with stable ids. Demo tasks keep random ids and are
// intentionally local-only (not event-sourced): they are first-run flavour and
// random ids would duplicate on merge across devices.
export function stableDefaultBoardData() {
  const columns = defaultColumns();
  return {
    columns,
    tasks: [],
    settings: defaultSettings()
  };
}

export function defaultSettings() {
  const locale = (typeof navigator !== 'undefined' && typeof navigator.language === 'string')
    ? navigator.language
    : 'en-US';

  return {
    showChangeDate: false,
    locale
  };
}
