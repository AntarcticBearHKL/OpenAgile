import { renderIcons } from './icons.js';

const CONFIRM_WINDOW_MS = 3000;

// Click once to arm, click again to confirm; a blur or the timeout restores the button.
export function createArmedDeleteController({ button, armedContent, armedTitle, armedAria, onRestore, onConfirm }) {
  let timer = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const reset = () => {
    clearTimer();
    button.classList.remove('is-armed');
    onRestore();
  };

  const handleClick = () => {
    if (button.classList.contains('is-armed')) {
      clearTimer();
      onConfirm();
      return;
    }
    button.classList.add('is-armed');
    button.textContent = armedContent;
    button.title = armedTitle;
    button.setAttribute('aria-label', armedAria);
    timer = setTimeout(reset, CONFIRM_WINDOW_MS);
  };

  button.addEventListener('blur', reset);

  return { handleClick, reset };
}

export function createArmedDeleteButton(className, label, onConfirm) {
  const content = '<span data-lucide="x" aria-hidden="true"></span>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = content;

  const controller = createArmedDeleteController({
    button: btn,
    armedContent: '!',
    armedTitle: 'Click again to confirm',
    armedAria: 'Click again to confirm delete',
    onRestore: () => {
      btn.innerHTML = content;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      renderIcons();
    },
    onConfirm
  });

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    controller.handleClick();
  });

  return btn;
}
