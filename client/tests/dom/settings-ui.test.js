import { beforeEach, expect, test } from 'vitest';
import { fireEvent, screen } from '@testing-library/dom';
import { mountToBody } from './setup.js';
import { createBoard, loadSettings, saveTasks } from '../../src/modules/storage.js';
import { initializeSettingsUI } from '../../src/modules/settings.js';

function mountSettings() {
  mountToBody(`
    <button id="settings-btn" type="button">Settings</button>
    <div id="settings-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <div class="modal-backdrop" data-close-modal></div>
      <article class="modal-content">
        <h3 id="settings-modal-title">Settings</h3>
        <button id="settings-close-modal-btn" type="button">Close</button>
        <form id="settings-form" novalidate>
          <section class="settings-section" aria-labelledby="settings-app-title">
            <h4 id="settings-app-title">App settings</h4>
          </section>
          <section class="settings-section" aria-labelledby="settings-board-title">
            <h4 id="settings-board-title">Board settings</h4>
            <label><input id="settings-show-change-date" type="checkbox">Show updated date/time</label>
            <select id="settings-locale" aria-label="Select locale"></select>
          </section>
          <button type="button" id="settings-close-btn">Close</button>
        </form>
      </article>
    </div>
  `);
  initializeSettingsUI();
}

beforeEach(() => {
  createBoard('Settings UI');
  saveTasks([]);
});

test('settings modal opens with the surviving board settings controls', () => {
  mountSettings();

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

  expect(screen.getByRole('heading', { name: 'App settings' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Board settings' })).toBeTruthy();
  expect(screen.getByLabelText('Show updated date/time').checked).toBe(false);
  expect(screen.getByLabelText('Select locale')).toBeTruthy();
  expect(document.getElementById('settings-show-priority')).toBeNull();
  expect(document.getElementById('settings-show-due-date')).toBeNull();
  expect(document.getElementById('settings-show-age')).toBeNull();
  expect(document.getElementById('settings-default-priority')).toBeNull();
  expect(document.getElementById('settings-countdown-urgent-threshold')).toBeNull();
  expect(document.getElementById('settings-countdown-warning-threshold')).toBeNull();
  expect(screen.queryByLabelText('Soft-delete tasks')).toBeNull();
  expect(document.getElementById('settings-purge-btn')).toBeNull();
});

test('settings changes persist through board settings', () => {
  mountSettings();

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(screen.getByLabelText('Show updated date/time'));

  expect(loadSettings().showChangeDate).toBe(true);
});
