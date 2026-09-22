// Initialize icons early for initial HTML elements
import './modules/icons.js';

import { renderBoard } from './modules/render.js';
import { initializeSpotlight } from './modules/spotlight.js';
import { initializeModalHandlers } from './modules/modals.js';
import { showEditModal } from './modules/modals.js';
import { importTasks } from './modules/import-board.js';
import { initializeThemeToggle } from './modules/theme.js';
import { initializeBoardsUI } from './modules/boards.js';
import { initializeBoardSidebar } from './modules/board-sidebar.js';
import { initializeSkillsUI } from './modules/skills-modal.js';
import { initializeSettingsUI } from './modules/settings.js';
import { initStorage, ensureBoardsInitialized, setActiveBoardId } from './modules/storage.js';
import { initLocalServer } from './modules/local-server.js';
import { initFolderSyncUI } from './modules/folder-sync-ui.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Load all board data from IDB into memory before any rendering.
  await initStorage();

  await initLocalServer();

  // Deep-link support: open a task modal by ID.
  const urlParams = new URLSearchParams(window.location.search);
  const openTaskId = (urlParams.get('openTaskId') || '').trim();
  const openTaskBoardId = (urlParams.get('openTaskBoardId') || '').trim();

  if (openTaskBoardId) {
    ensureBoardsInitialized();
    setActiveBoardId(openTaskBoardId);
  }

  const versionEl = document.getElementById('app-version');
  if (versionEl && typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
    versionEl.textContent = `v${__APP_VERSION__}`;
    versionEl.title = `Version ${__APP_VERSION__}`;
  }

  initializeThemeToggle();

  // Settings (per-board)
  initializeSettingsUI();

  // Folder transport: settings-modal control + .agileboard outbound routing
  initFolderSyncUI();

  initializeSpotlight();

  // Boards (create/select + restore last active)
  initializeBoardsUI();
  initializeBoardSidebar();
  initializeSkillsUI();

  // Initialize modal handlers
  initializeModalHandlers();

  document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      importTasks(file);
    }
    e.target.value = '';
  });

  // Initial render
  renderBoard();

  if (openTaskId) {
    // Open after first render so the board is visible behind the modal.
    showEditModal(openTaskId);

    // Clean up the URL so refresh doesn't re-open.
    const nextUrl = `${window.location.pathname}${window.location.hash || ''}`;
    window.history.replaceState({}, '', nextUrl);
  }
});
