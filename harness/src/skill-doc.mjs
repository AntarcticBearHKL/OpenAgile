import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOARD_ID, getBoards, getColumns, getGroups } from './store.mjs';

export const PROTOCOL_VERSION = 1;
export const SKILL_VERSION = '1.0.0';
export const LIVE_CONTEXT_MARKER = '<!-- openagile:live-context -->';
export const DEFAULT_MCP_ENDPOINT = 'http://127.0.0.1:8787/mcp';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = resolve(HERE, '..');
const REPO_DIR = resolve(HARNESS_DIR, '..');

const SKILL_FILES = [
  join(REPO_DIR, 'client', 'src', 'public', 'skill', 'openagile.md'),
  join(REPO_DIR, 'client', 'dist', 'skill', 'openagile.md')
];
const AGENT_FILES = [
  join(REPO_DIR, 'client', 'src', 'public', 'skill', 'agent.json'),
  join(REPO_DIR, 'client', 'dist', 'skill', 'agent.json')
];

function readStaticFile(paths, label) {
  for (const path of paths) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`${label} is missing; expected one of ${paths.join(', ')}`);
}

function harnessDataDir() {
  if (process.env.OPENAGILE_DATA_DIR) return resolve(process.env.OPENAGILE_DATA_DIR);
  const cwd = resolve(process.cwd());
  return join(cwd === HARNESS_DIR ? REPO_DIR : cwd, '.agileboard');
}

function manifestGroupHint() {
  try {
    const manifest = JSON.parse(readFileSync(join(harnessDataDir(), 'manifest.json'), 'utf8'));
    const hint = manifest?.group ?? manifest?.defaultGroup;
    return typeof hint === 'string' ? hint.trim() : '';
  } catch {
    return '';
  }
}

function argvGroupHint() {
  const index = process.argv.indexOf('--group');
  if (index >= 0 && typeof process.argv[index + 1] === 'string') return process.argv[index + 1].trim();
  const prefixed = process.argv.find((arg) => arg.startsWith('--group='));
  return prefixed ? prefixed.slice('--group='.length).trim() : '';
}

function requestedGroup(selector) {
  const query = typeof selector === 'string' ? selector.trim() : '';
  if (query) return { value: query, source: 'group query parameter' };
  const env = (process.env.OPENAGILE_GROUP || '').trim();
  if (env) return { value: env, source: 'OPENAGILE_GROUP' };
  const flag = argvGroupHint();
  if (flag) return { value: flag, source: '--group' };
  const manifest = manifestGroupHint();
  if (manifest) return { value: manifest, source: '.agileboard/manifest.json' };
  return { value: '', source: 'default: the last group on the board' };
}

function findGroup(groups, value) {
  if (!value) return groups[groups.length - 1] || null;
  return groups.find((group) => group.id === value)
    || groups.find((group) => group.name === value)
    || groups.find((group) => String(group.name).toLowerCase() === value.toLowerCase())
    || null;
}

function boardKeyPrefix(name) {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words.map((word) => word[0]).join('') : (words[0] || 'BRD').slice(0, 3);
  return letters.toUpperCase().slice(0, 4) || 'BRD';
}

function liveContext(selector) {
  const groups = getGroups();
  const { value, source } = requestedGroup(selector);
  const group = findGroup(groups, value);

  if (!group) {
    const available = groups.length > 0
      ? groups.map((entry) => `"${entry.name}"`).join(', ')
      : 'none yet — create the first one with create_group';
    const target = value ? `group "${value}"` : 'any group';
    return [
      '## Your live context',
      '',
      `> **NOTICE — no live context available.** The MCP could not resolve ${target} (resolved from ${source}).`,
      `> Available groups: ${available}.`,
      '> This is the generic bootstrap document; it contains no live board or column IDs.',
      '> Resolve the group first: call `list_groups`, then fetch `GET /skill/openagile.md?group=<name>` again.',
      ''
    ].join('\n');
  }

  const boards = getBoards().filter((board) => (board.groupId || '') === group.id);
  const boardRows = boards.length > 0
    ? boards.map((board) => `| ${board.name} | \`${board.id}\` | \`${boardKeyPrefix(board.name)}-1\`, \`${boardKeyPrefix(board.name)}-2\`, … |`).join('\n')
    : '| _no iteration yet_ | — | create one with `create_board` |';
  const columnRows = getColumns(boards[0]?.id || DEFAULT_BOARD_ID)
    .map((column) => `| ${column.name} | \`${column.id}\` |`)
    .join('\n');
  const firstBoard = getBoards()[0];

  return [
    '## Your live context',
    '',
    `Resolved group: **${group.name}** — id \`${group.id}\` (resolved from ${source}).`,
    '',
    'Iterations (boards) in this group:',
    '',
    '| iteration | boardId | task keys |',
    '|---|---|---|',
    boardRows,
    '',
    'Fixed columns — identical ids and order on every board (`move_task` accepts the id or the name):',
    '',
    '| column | id |',
    '|---|---|',
    columnRows,
    '',
    `Always pass \`boardId\` explicitly; an omitted \`boardId\` falls back to ${firstBoard ? `\`${firstBoard.name}\` (\`${firstBoard.id}\`)` : 'the default board'}, which may not be the iteration you mean.`,
    ''
  ].join('\n');
}

export function renderSkillDoc({ group = '' } = {}) {
  const base = readStaticFile(SKILL_FILES, 'skill/openagile.md');
  const context = liveContext(group);
  return base.includes(LIVE_CONTEXT_MARKER)
    ? base.replace(LIVE_CONTEXT_MARKER, context)
    : `${base.trimEnd()}\n\n${context}`;
}

export function renderAgentJson({ origin = '' } = {}) {
  const base = JSON.parse(readStaticFile(AGENT_FILES, 'skill/agent.json'));
  const root = typeof origin === 'string' ? origin.replace(/\/+$/, '') : '';
  return {
    protocolVersion: PROTOCOL_VERSION,
    skillVersion: SKILL_VERSION,
    mcpEndpointHint: root ? `${root}/mcp` : (base.mcpEndpointHint || DEFAULT_MCP_ENDPOINT),
    docs: root
      ? { skill: `${root}/skill/openagile.md`, agent: `${root}/skill/agent.json` }
      : base.docs
  };
}
