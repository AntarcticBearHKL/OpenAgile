import { $id } from './dom.js';

export function setupModalCloseHandlers(modalId, closeHandler) {
  const modal = $id(modalId);
  if (!modal) return;

  const backdrop = modal.querySelector('.modal-backdrop');
  backdrop?.addEventListener('click', closeHandler);

  const closeButtons = modal.querySelectorAll(
    '[id$="-close-btn"], [id$="-close-modal-btn"], [id$="-cancel-btn"], [id^="cancel-"]'
  );
  closeButtons.forEach((btn) => {
    btn.addEventListener('click', closeHandler);
  });
}
