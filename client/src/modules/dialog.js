import { setupModalCloseHandlers } from './modal-utils.js';
import { $id } from './dom.js';

let currentResolver = null;

function closeDialog(result) {
  const modal = $id('dialog-modal');
  if (modal) modal.classList.add('hidden');

  const resolve = currentResolver;
  currentResolver = null;
  if (typeof resolve === 'function') resolve(result);
}

function isDialogOpen() {
  const modal = $id('dialog-modal');
  return modal && !modal.classList.contains('hidden');
}

function setDialog({ title, message, confirmText, cancelText, showCancel, showInput = false, inputValue = '', inputPlaceholder = '' }) {
  const titleEl = $id('dialog-modal-title');
  const messageEl = $id('dialog-modal-message');
  const confirmBtn = $id('dialog-confirm-btn');
  const cancelBtn = $id('dialog-cancel-btn');
  const inputEl = $id('dialog-modal-input');

  if (titleEl) titleEl.textContent = title || 'Confirm';
  if (messageEl) messageEl.textContent = message || '';
  if (confirmBtn) confirmBtn.textContent = confirmText || 'OK';
  if (cancelBtn) cancelBtn.textContent = cancelText || 'Cancel';

  if (cancelBtn) {
    cancelBtn.style.display = showCancel ? 'inline-flex' : 'none';
  }

  if (inputEl) {
    inputEl.hidden = !showInput;
    inputEl.value = showInput ? inputValue : '';
    inputEl.placeholder = inputPlaceholder || '';
  }
}

function ensureDialogHandlers() {
  const modal = $id('dialog-modal');
  if (!modal || modal.dataset.handlersAttached === 'true') return;
  modal.dataset.handlersAttached = 'true';

  const confirmBtn = $id('dialog-confirm-btn');
  const cancelBtn = $id('dialog-cancel-btn');
  const inputEl = $id('dialog-modal-input');
  const backdrop = modal.querySelector('.modal-backdrop');

  confirmBtn?.addEventListener('click', () => closeDialog(true));
  cancelBtn?.addEventListener('click', () => closeDialog(false));
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      closeDialog(true);
    }
  });
  
  setupModalCloseHandlers('dialog-modal', () => closeDialog(false));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDialogOpen()) {
      closeDialog(false);
    }
  });
}

function showDialog() {
  const modal = $id('dialog-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  // Focus confirm button for accessibility
  const confirmBtn = $id('dialog-confirm-btn');
  confirmBtn?.focus();
}

export function confirmDialog({
  title = 'Confirm',
  message = '',
  confirmText = 'Delete',
  cancelText = 'Cancel'
} = {}) {
  ensureDialogHandlers();
  setDialog({ title, message, confirmText, cancelText, showCancel: true });
  showDialog();

  return new Promise((resolve) => {
    currentResolver = resolve;
  });
}

export function alertDialog({ title = 'Notice', message = '', okText = 'OK' } = {}) {
  ensureDialogHandlers();
  setDialog({ title, message, confirmText: okText, cancelText: '', showCancel: false });
  showDialog();

  return new Promise((resolve) => {
    currentResolver = () => resolve(true);
  });
}

export function promptDialog({
  title = 'Enter a value',
  message = '',
  placeholder = '',
  initialValue = '',
  confirmText = 'Save',
  cancelText = 'Cancel'
} = {}) {
  ensureDialogHandlers();
  setDialog({
    title,
    message,
    confirmText,
    cancelText,
    showCancel: true,
    showInput: true,
    inputValue: initialValue,
    inputPlaceholder: placeholder
  });
  showDialog();

  const input = $id('dialog-modal-input');
  input?.focus();
  input?.select();

  return new Promise((resolve) => {
    currentResolver = (confirmed) => resolve(confirmed ? (input?.value ?? '') : null);
  });
}
