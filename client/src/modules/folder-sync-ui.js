// Folder sync UI + wiring (plan unit I part 2). The control is injected into the
// settings modal at runtime; the outbound listener below is registered at module
// load, like local-server.js, so no local event is missed while the async
// storage/settings boot is in flight.
//
// Transport exclusion: exactly one outbound transport should run at a time.
// folder-sync.js owns the folder side — linking selects 'folder', unlinking
// returns to the 'bridge' default, and events merge back with synced=true, so
// they are never appended to this tab's shard twice. The reciprocal pause of
// local-server has no public hook and is out of scope to edit; until a guard
// exists there, the server bridge may POST an event that was also written to
// the shard. The MCP merges by event id, so no duplicate lands in the store;
// this is the documented, deliberate gap.

import { EVENT_EMITTED, on } from './events.js';
import { $id, h } from './dom.js';
import { alertDialog } from './dialog.js';
import {
  flushPendingOutbound,
  getLinkStatus,
  getTransportMode,
  linkFolder,
  pickFolder,
  reconcile,
  routeOutbound,
  setTransportMode,
  unlinkFolder
} from './folder-sync.js';

export const FOLDER_SYNC_SECTION_ID = 'folder-sync-section';
export const FOLDER_SYNC_UNSUPPORTED_MESSAGE = '自动同步需要桌面版 Chrome/Edge';

const LINK_BUTTON_ID = 'folder-sync-link-btn';
const SYNC_BUTTON_ID = 'folder-sync-sync-btn';
const STATUS_ID = 'folder-sync-status';
const DOT_ID = 'folder-sync-dot';
const UNSUPPORTED_ID = 'folder-sync-unsupported';

const LINK_LABEL = 'Link .agileboard folder';
const UNLINK_LABEL = 'Unlink folder';

let _mounted = false;
let _els = null;
let _modeBeforeLink = null;

export function isFolderSyncSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

export function formatFolderSyncStatus(status = {}) {
  const pendingSuffix = status.pendingOutbound > 0 ? ` · ${status.pendingOutbound} pending` : '';
  if (!status.linked) {
    if (status.lastError && status.lastError !== 'unsupported') {
      return { state: 'error', text: `Not linked · ${status.lastError}` };
    }
    return {
      state: status.pendingOutbound > 0 ? 'pending' : 'unlinked',
      text: `Not linked${pendingSuffix}`
    };
  }

  const details = [];
  if (status.pendingOutbound > 0) details.push(`${status.pendingOutbound} pending`);
  if (status.lastMergedEventId) details.push(`merged ${String(status.lastMergedEventId).slice(0, 8)}`);
  if (status.lastError) details.push(status.lastError);

  const state = status.lastError ? 'error' : status.pendingOutbound > 0 ? 'pending' : 'linked';
  const folder = status.folderName || '…';
  return { state, text: `Folder: ${folder}${details.length > 0 ? ` · ${details.join(' · ')}` : ''}` };
}

function buildControl() {
  const dot = h('span', { id: DOT_ID, class: 'folder-sync-dot', 'aria-hidden': 'true' });
  const statusText = h('span', { class: 'folder-sync-status-text' }, 'Not linked');
  const status = h(
    'p',
    { id: STATUS_ID, class: 'folder-sync-status folder-sync-status--unlinked', role: 'status', 'aria-live': 'polite' },
    dot,
    statusText
  );
  const unsupported = h(
    'p',
    { id: UNSUPPORTED_ID, class: 'folder-sync-unsupported', hidden: true },
    FOLDER_SYNC_UNSUPPORTED_MESSAGE
  );
  const linkBtn = h('button', { id: LINK_BUTTON_ID, class: 'btn btn-secondary', type: 'button' }, LINK_LABEL);
  const syncBtn = h('button', { id: SYNC_BUTTON_ID, class: 'btn btn-secondary', type: 'button', hidden: true }, '立即同步');

  const section = h(
    'section',
    { id: FOLDER_SYNC_SECTION_ID, class: 'settings-section folder-sync', 'aria-labelledby': 'folder-sync-title' },
    h(
      'div',
      { class: 'settings-section-header' },
      h('h4', { id: 'folder-sync-title' }, 'Folder sync'),
      h(
        'p',
        { class: 'form-help' },
        'Writes this browser\u2019s events into a local .agileboard/ folder for the MCP on this machine to merge. ' +
          'Automatic sync needs desktop Chrome or Edge; everywhere else the board stays fully usable offline and ' +
          'JSON export/import is the fallback.'
      )
    ),
    unsupported,
    h('div', { class: 'folder-sync-actions' }, linkBtn, syncBtn),
    status
  );

  return { section, linkBtn, syncBtn, status, statusText, dot, unsupported };
}

function refresh() {
  if (!_els) return;
  const linkStatus = getLinkStatus();
  const { state, text } = formatFolderSyncStatus(linkStatus);
  const supported = isFolderSyncSupported();

  _els.statusText.textContent = text;
  _els.status.className = `folder-sync-status folder-sync-status--${state}`;

  const showUnsupported = !supported && !linkStatus.linked;
  _els.unsupported.hidden = !showUnsupported;
  _els.linkBtn.disabled = showUnsupported;
  _els.linkBtn.textContent = linkStatus.linked ? UNLINK_LABEL : LINK_LABEL;
  _els.linkBtn.title = showUnsupported ? FOLDER_SYNC_UNSUPPORTED_MESSAGE : '';
  _els.syncBtn.hidden = !linkStatus.linked;
}

async function handleLinkClick() {
  const directory = await pickFolder();
  if (!directory) {
    refresh();
    const { lastError } = getLinkStatus();
    if (lastError && lastError !== 'unsupported') {
      alertDialog({ title: 'Folder link failed', message: lastError });
    }
    return;
  }
  const previousMode = getTransportMode();
  try {
    await linkFolder({ directory });
    _modeBeforeLink = previousMode === 'folder' ? 'bridge' : previousMode;
    setTransportMode('folder');
    await reconcile();
    refresh();
  } catch (err) {
    refresh();
    alertDialog({ title: 'Folder link failed', message: err?.message || String(err) });
  }
}

function handleUnlinkClick() {
  unlinkFolder();
  if (_modeBeforeLink && _modeBeforeLink !== 'bridge') setTransportMode(_modeBeforeLink);
  _modeBeforeLink = null;
  refresh();
}

async function handleLinkButtonClick() {
  if (getLinkStatus().linked) {
    handleUnlinkClick();
    return;
  }
  await handleLinkClick();
}

async function handleSyncNowClick() {
  if (!_els) return;
  _els.syncBtn.disabled = true;
  try {
    await reconcile();
    await flushPendingOutbound();
  } finally {
    _els.syncBtn.disabled = false;
    refresh();
  }
}

export function initFolderSyncUI() {
  if (_mounted || typeof document === 'undefined') return _mounted;
  const form = $id('settings-form');
  if (!form) return false;

  _els = buildControl();
  form.insertBefore(_els.section, form.querySelector('.form-actions') ?? null);
  _els.linkBtn.addEventListener('click', handleLinkButtonClick);
  _els.syncBtn.addEventListener('click', handleSyncNowClick);
  _mounted = true;
  refresh();
  return true;
}

export function _resetFolderSyncUIForTesting() {
  _mounted = false;
  _els = null;
  _modeBeforeLink = null;
  if (typeof document !== 'undefined') $id(FOLDER_SYNC_SECTION_ID)?.remove();
}

on(EVENT_EMITTED, (e) => {
  const event = e.detail;
  if (!event?.id) return;
  routeOutbound(event).then(() => {
    if (getLinkStatus().linked) refresh();
  }).catch(() => {});
});
