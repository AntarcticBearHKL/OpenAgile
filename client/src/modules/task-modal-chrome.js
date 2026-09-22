// Modal chrome: fullscreen toggle + description link-chip preview.

import { renderIcons } from './icons.js';
import { URL_RE } from './utils.js';
import { $id, h } from './dom.js';

export function setTaskModalFullscreen(isFullscreen) {
  const modal = $id('task-modal');
  if (!modal) return;
  modal.classList.toggle('fullscreen', !!isFullscreen);

  const btn = $id('task-fullpage-btn');
  btn?.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');

  if (btn) {
    const icon = btn.querySelector('[data-lucide]');
    if (icon) {
      icon.setAttribute('data-lucide', isFullscreen ? 'minimize-2' : 'maximize-2');
    }
    btn.title = isFullscreen ? 'Exit full page' : 'Open in full page';
  }

  renderIcons();
}
export function updateDescriptionLinks(text) {
  const container = $id('task-description-links');
  if (!container) return;
  container.innerHTML = '';
  const matches = [...(text || '').matchAll(URL_RE)].map(m => m[0]);
  if (matches.length === 0) { container.hidden = true; return; }
  const unique = [...new Set(matches)];
  unique.forEach(url => {
    const a = h('a', {
      href: url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: 'description-link-chip'
    }, url);
    if (a.protocol !== 'https:' && a.protocol !== 'http:') return;
    container.appendChild(a);
  });
  container.hidden = container.childElementCount === 0;
}
