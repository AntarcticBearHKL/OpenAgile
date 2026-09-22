// Single resolution point for the optional local service base URL: the same
// build must work served by the harness (same origin, no config), from a
// sub-path static host, or pointed at a future loopback endpoint.
const STORAGE_KEY = 'openagile:apiBase';
const META_SELECTOR = 'meta[name="openagile-api-base"]';

let configured = null;

function normalizeBase(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function resolveBase() {
  if (typeof window !== 'undefined') {
    const fromWindow = normalizeBase(window.__OPENAGILE__?.apiBase);
    if (fromWindow) return fromWindow;
  }
  if (typeof document !== 'undefined') {
    const meta = document.querySelector(META_SELECTOR);
    const fromMeta = normalizeBase(meta?.content);
    if (fromMeta) return fromMeta;
  }
  if (typeof localStorage === 'undefined') return '';
  try {
    return normalizeBase(localStorage.getItem(STORAGE_KEY));
  } catch {
    return '';
  }
}

export function getApiBase() {
  return configured ?? resolveBase();
}

export function setApiBase(url) {
  configured = normalizeBase(url);
}

export function apiUrl(path) {
  return `${getApiBase()}${path}`;
}
