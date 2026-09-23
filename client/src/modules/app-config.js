// Single resolution point for the local service base URL and access token. The
// same build works pointed at the loopback MCP server (the default), from a
// sub-path static host, or at a custom endpoint. Both values resolve from
// window.__OPENAGILE__, then a <meta> tag, then localStorage.
const STORAGE_KEY = 'openagile:apiBase';
const META_SELECTOR = 'meta[name="openagile-api-base"]';
const TOKEN_STORAGE_KEY = 'openagile:apiToken';
const TOKEN_META_SELECTOR = 'meta[name="openagile-api-token"]';
const DEFAULT_BASE = 'http://127.0.0.1:8787';

let configured = null;
let configuredToken = null;

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
  if (typeof localStorage !== 'undefined') {
    try {
      const fromStorage = normalizeBase(localStorage.getItem(STORAGE_KEY));
      if (fromStorage) return fromStorage;
    } catch { /* private mode */ }
  }
  return DEFAULT_BASE;
}

function normalizeToken(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

function resolveToken() {
  if (typeof window !== 'undefined') {
    const fromWindow = normalizeToken(window.__OPENAGILE__?.apiToken);
    if (fromWindow) return fromWindow;
  }
  if (typeof document !== 'undefined') {
    const meta = document.querySelector(TOKEN_META_SELECTOR);
    const fromMeta = normalizeToken(meta?.content);
    if (fromMeta) return fromMeta;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      return normalizeToken(localStorage.getItem(TOKEN_STORAGE_KEY));
    } catch { /* private mode */ }
  }
  return '';
}

export function getApiBase() {
  return configured ?? resolveBase();
}

export function setApiBase(url) {
  configured = normalizeBase(url);
}

export function getApiToken() {
  return configuredToken ?? resolveToken();
}

export function setApiToken(value) {
  configuredToken = normalizeToken(value);
}

export function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

// EventSource cannot set request headers, so the SSE URL carries the token in
// the query string instead.
export function apiUrlWithToken(path) {
  const url = apiUrl(path);
  const token = getApiToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

export function apiFetch(path, init = {}) {
  const token = getApiToken();
  const headers = { ...(init.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(apiUrl(path), { ...init, headers });
}
