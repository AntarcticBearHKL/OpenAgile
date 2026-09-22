import { beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/dom';
import { mountToBody } from './setup.js';
import { EVENT_EMITTED, emit } from '../../src/modules/events.js';
import { EVENTS_STORE, openStore, _resetIdbForTesting } from '../../src/modules/idb-store.js';
import { _resetHlcForTesting } from '../../src/modules/event-sourcing/hlc.js';
import {
  getLinkStatus,
  getTransportMode,
  reconcile,
  _resetFolderSyncForTesting
} from '../../src/modules/folder-sync.js';
import {
  FOLDER_SYNC_UNSUPPORTED_MESSAGE,
  initFolderSyncUI,
  _resetFolderSyncUIForTesting
} from '../../src/modules/folder-sync-ui.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeFile {
  constructor() {
    this.bytes = new Uint8Array(0);
  }
  get size() {
    return this.bytes.length;
  }
  async text() {
    return decoder.decode(this.bytes);
  }
  async arrayBuffer() {
    return this.bytes.slice().buffer;
  }
}

class FakeFileHandle {
  constructor(file) {
    this.kind = 'file';
    this.file = file;
  }
  async getFile() {
    return this.file;
  }
  async createWritable(options = {}) {
    let buffer = options.keepExistingData === true ? this.file.bytes : new Uint8Array(0);
    let position = 0;
    const handle = this;
    return {
      async seek(pos) { position = pos; },
      async write(data) {
        const chunk = typeof data === 'string' ? encoder.encode(data) : data;
        const out = new Uint8Array(Math.max(buffer.length, position + chunk.length));
        out.set(buffer, 0);
        out.set(chunk, position);
        buffer = out;
        position += chunk.length;
      },
      async close() { handle.file.bytes = buffer; }
    };
  }
}

class FakeDirHandle {
  constructor(name = '.agileboard') {
    this.kind = 'directory';
    this.name = name;
    this.dirs = new Map();
    this.files = new Map();
  }
  async getDirectoryHandle(name, options = {}) {
    if (!this.dirs.has(name)) {
      if (options.create !== true) throw new Error(`NotFoundError: ${name}`);
      this.dirs.set(name, new FakeDirHandle(name));
    }
    return this.dirs.get(name);
  }
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (options.create !== true) throw new Error(`NotFoundError: ${name}`);
      this.files.set(name, new FakeFileHandle(new FakeFile()));
    }
    return this.files.get(name);
  }
  async *entries() {
    yield* this.files;
    yield* this.dirs;
  }
}

function seedShard(dir, writerId, text) {
  const eventsDir = dir.dirs.get('events') ?? new FakeDirHandle('events');
  dir.dirs.set('events', eventsDir);
  const file = new FakeFile();
  file.bytes = encoder.encode(text);
  eventsDir.files.set(`${writerId}.ndjson`, new FakeFileHandle(file));
}

async function readShardText(dir, writerId) {
  const handle = dir.dirs.get('events')?.files.get(`${writerId}.ndjson`);
  return handle ? handle.file.text() : null;
}

function makeEvent(id, wallTime = 1000) {
  return {
    id,
    type: 'task.created',
    hlc: { wallTime, counter: 0, nodeId: 'node-local' },
    at: '2026-05-26T00:00:00.000Z',
    actor: { type: 'human', id: null },
    scope: 'board',
    board_id: 'board-a',
    entity_id: 'task-a',
    payload: { task: { id: 'task-a', title: 'T', column: 'todo', columnHistory: [] } }
  };
}

const FIXTURE = `
  <div id="settings-modal" class="modal hidden" role="dialog" aria-modal="true">
    <article class="modal-content">
      <form id="settings-form" novalidate>
        <section class="settings-section"><h4>Board settings</h4></section>
        <div class="form-actions">
          <button id="settings-close-btn" type="button" class="btn btn-primary">Close</button>
        </div>
      </form>
    </article>
  </div>
  <div id="dialog-modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-backdrop" data-close-modal></div>
    <article class="modal-content">
      <h3 id="dialog-modal-title"></h3>
      <p id="dialog-modal-message"></p>
      <input id="dialog-modal-input" type="text" hidden>
      <div class="form-actions">
        <button id="dialog-cancel-btn" type="button"></button>
        <button id="dialog-confirm-btn" type="button"></button>
      </div>
    </article>
  </div>`;

const linkBtn = () => document.getElementById('folder-sync-link-btn');
const syncBtn = () => document.getElementById('folder-sync-sync-btn');
const statusEl = () => document.getElementById('folder-sync-status');
const unsupportedEl = () => document.getElementById('folder-sync-unsupported');

async function linkAndSettle() {
  fireEvent.click(linkBtn());
  await waitFor(() => expect(getLinkStatus().linked).toBe(true));
  await reconcile();
  await waitFor(() => expect(linkBtn().textContent).toBe('Unlink folder'));
}

async function linkTo(dir) {
  window.showDirectoryPicker = async () => dir;
  initFolderSyncUI();
  await linkAndSettle();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  _resetFolderSyncUIForTesting();
  _resetFolderSyncForTesting();
  _resetHlcForTesting();
  _resetIdbForTesting();
  delete window.showDirectoryPicker;
  mountToBody(FIXTURE);
});

test('mounts into the settings form before its actions and is idempotent', () => {
  expect(initFolderSyncUI()).toBe(true);
  expect(initFolderSyncUI()).toBe(true);

  const section = document.getElementById('folder-sync-section');
  expect(section.parentElement.id).toBe('settings-form');
  expect(section.nextElementSibling.classList.contains('form-actions')).toBe(true);
  expect(document.querySelectorAll('#folder-sync-section').length).toBe(1);
});

test('without the File System Access API the control is disabled with a calm explanation', () => {
  initFolderSyncUI();

  expect(linkBtn().disabled).toBe(true);
  expect(linkBtn().title).toBe(FOLDER_SYNC_UNSUPPORTED_MESSAGE);
  expect(unsupportedEl().hidden).toBe(false);
  expect(unsupportedEl().textContent).toBe(FOLDER_SYNC_UNSUPPORTED_MESSAGE);
  expect(statusEl().textContent).toContain('Not linked');
  expect(syncBtn().hidden).toBe(true);
});

test('linking shows the folder, switches transport mode and reveals the manual sync action', async () => {
  const dir = new FakeDirHandle('.agileboard');

  await linkTo(dir);

  expect(getTransportMode()).toBe('folder');
  expect(getLinkStatus().folderName).toBe('.agileboard');
  expect(linkBtn().textContent).toBe('Unlink folder');
  expect(syncBtn().hidden).toBe(false);
  expect(statusEl().textContent).toContain('.agileboard');
  expect(unsupportedEl().hidden).toBe(true);
});

test('a cancelled picker changes nothing and shows no error', async () => {
  const picker = vi.fn(async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  window.showDirectoryPicker = picker;
  initFolderSyncUI();

  fireEvent.click(linkBtn());
  await waitFor(() => expect(picker).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(getTransportMode()).toBe('bridge');
  expect(getLinkStatus().linked).toBe(false);
  expect(statusEl().textContent).toContain('Not linked');
  expect(document.getElementById('dialog-modal').classList.contains('hidden')).toBe(true);
});

test('a failed link surfaces through the existing alert dialog', async () => {
  window.showDirectoryPicker = async () => {
    throw new Error('permission denied by policy');
  };
  initFolderSyncUI();

  fireEvent.click(linkBtn());

  await waitFor(() => {
    expect(document.getElementById('dialog-modal').classList.contains('hidden')).toBe(false);
  });
  expect(document.getElementById('dialog-modal-message').textContent).toContain('permission denied by policy');
  expect(getLinkStatus().linked).toBe(false);
  expect(getTransportMode()).toBe('bridge');
});

test('routes each local event into the shard exactly once across repeated mounts', async () => {
  const dir = new FakeDirHandle('.agileboard');
  window.showDirectoryPicker = async () => dir;
  initFolderSyncUI();
  initFolderSyncUI();

  emit(EVENT_EMITTED, makeEvent('evt-before-link'));
  await waitFor(() => expect(getLinkStatus().pendingOutbound).toBe(1));

  await linkAndSettle();
  await waitFor(async () => {
    const text = await readShardText(dir, getLinkStatus().writerId);
    expect(text).toContain('evt-before-link');
  });

  emit(EVENT_EMITTED, makeEvent('evt-after-link', 1001));
  await waitFor(async () => {
    const text = await readShardText(dir, getLinkStatus().writerId);
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });
});

test('unlinking returns to the previous transport mode and keeps the unlinked state', async () => {
  await linkTo(new FakeDirHandle('.agileboard'));

  fireEvent.click(linkBtn());
  await waitFor(() => expect(getTransportMode()).toBe('bridge'));

  expect(getLinkStatus().linked).toBe(false);
  expect(linkBtn().textContent).toBe('Link .agileboard folder');
  expect(syncBtn().hidden).toBe(true);
  expect(statusEl().textContent).toContain('Not linked');
});

test('the manual sync action merges a shard written outside the browser', async () => {
  const dir = new FakeDirHandle('.agileboard');
  await linkTo(dir);

  const remote = makeEvent('remote-1', 2000);
  seedShard(dir, 'mcp', `${JSON.stringify(remote)}\n`);

  fireEvent.click(syncBtn());

  await waitFor(() => expect(getLinkStatus().lastMergedEventId).toBe('remote-1'));
  const db = await openStore();
  expect((await db.get(EVENTS_STORE, 'remote-1')).synced).toBe(true);
  await waitFor(() => expect(statusEl().textContent).toContain('merged remote-1'));
});
