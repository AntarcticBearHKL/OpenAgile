import { getActiveBoardId, loadSettings, saveSettings } from './storage.js';
import { setupModalCloseHandlers } from './modal-utils.js';
import { $id, h } from './dom.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';
import { normalizeStringKeys } from './normalize.js';

function buildLocaleOptions(currentLocale) {
  const browserLocale = (typeof navigator !== 'undefined' && typeof navigator.language === 'string')
    ? navigator.language
    : 'en-US';

  return normalizeStringKeys([
    currentLocale,
    browserLocale,
    'en-US',
    'en-GB',
    'de-DE',
    'fr-FR',
    'es-ES',
    'it-IT',
    'pt-BR',
    'ja-JP',
    'zh-CN'
  ]);
}

function showSettingsModal() {
  $id('settings-modal')?.classList.remove('hidden');
}

function hideSettingsModal() {
  $id('settings-modal')?.classList.add('hidden');
}

function applyAndRerender(next) {
  saveSettings(next);
  scheduleDomainEvent({
    type: 'settings.updated',
    boardId: getActiveBoardId(),
    entityId: getActiveBoardId() || '',
    payload: { fields: next }
  });
}

export function initializeSettingsUI() {
  const openBtn = $id('settings-btn');
  const closeBtn = $id('settings-close-btn');

  const showChangeDateEl = $id('settings-show-change-date');
  const localeEl = $id('settings-locale');
  if (!openBtn || !closeBtn || !showChangeDateEl || !localeEl) return;

  function syncFormFromSettings() {
    const settings = loadSettings();
    showChangeDateEl.checked = settings.showChangeDate !== false;

    const options = buildLocaleOptions(settings.locale);
    localeEl.innerHTML = '';
    options.forEach((loc) => localeEl.appendChild(h('option', { value: loc }, loc)));

    // Ensure selection is set even if user stored something unusual.
    localeEl.value = settings.locale;
  }

  openBtn.addEventListener('click', () => {
    syncFormFromSettings();
    showSettingsModal();
  });

  closeBtn.addEventListener('click', hideSettingsModal);
  setupModalCloseHandlers('settings-modal', hideSettingsModal);

  document.addEventListener('keydown', (e) => {
    const modal = $id('settings-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') hideSettingsModal();
  });

  showChangeDateEl.addEventListener('change', () => {
    const current = loadSettings();
    applyAndRerender({ ...current, showChangeDate: Boolean(showChangeDateEl.checked) });
  });

  localeEl.addEventListener('change', () => {
    const current = loadSettings();
    applyAndRerender({ ...current, locale: localeEl.value });
  });
}
