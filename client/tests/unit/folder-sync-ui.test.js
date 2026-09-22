import { expect, test } from 'vitest';
import {
  FOLDER_SYNC_UNSUPPORTED_MESSAGE,
  formatFolderSyncStatus,
  isFolderSyncSupported
} from '../../src/modules/folder-sync-ui.js';

test('unlinked status is calm and shows the buffered outbound count', () => {
  expect(formatFolderSyncStatus()).toEqual({ state: 'unlinked', text: 'Not linked' });
  expect(formatFolderSyncStatus({ linked: false, pendingOutbound: 3 })).toEqual({
    state: 'pending',
    text: 'Not linked · 3 pending'
  });
});

test('a link failure on an unlinked folder surfaces as the error state', () => {
  const { state, text } = formatFolderSyncStatus({ linked: false, lastError: 'quota exceeded' });
  expect(state).toBe('error');
  expect(text).toContain('quota exceeded');
});

test('the unsupported outcome is not rendered as an error', () => {
  expect(formatFolderSyncStatus({ linked: false, lastError: 'unsupported' })).toEqual({
    state: 'unlinked',
    text: 'Not linked'
  });
});

test('linked status shows the folder, pending count and last merged event', () => {
  expect(formatFolderSyncStatus({ linked: true, folderName: '.agileboard', pendingOutbound: 0 })).toEqual({
    state: 'linked',
    text: 'Folder: .agileboard'
  });

  const pending = formatFolderSyncStatus({
    linked: true,
    folderName: '.agileboard',
    pendingOutbound: 2,
    lastMergedEventId: 'abcdef12-3456-4789-9abc-def012345678'
  });
  expect(pending.state).toBe('pending');
  expect(pending.text).toBe('Folder: .agileboard · 2 pending · merged abcdef12');

  const failed = formatFolderSyncStatus({
    linked: true,
    folderName: '.agileboard',
    pendingOutbound: 0,
    lastError: 'NotAllowedError'
  });
  expect(failed.state).toBe('error');
  expect(failed.text).toContain('NotAllowedError');
});

test('the unsupported hint names the desktop Chromium requirement', () => {
  expect(FOLDER_SYNC_UNSUPPORTED_MESSAGE).toBe('自动同步需要桌面版 Chrome/Edge');
});

test('folder sync reports unsupported when the directory picker is absent', () => {
  delete globalThis.window.showDirectoryPicker;
  expect(isFolderSyncSupported()).toBe(false);
});
