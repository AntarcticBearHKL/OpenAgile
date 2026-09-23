import { apiFetch } from './app-config.js';
import { generateUUID, readLocalJson as readJson } from './utils.js';
import { scheduleDomainEvent } from './event-sourcing/emitter.js';
import { readModelProjector } from './storage-projector.js';
import { globalState } from './storage-state.js';

export const SKILLS_KEY = 'openagile:skills';

const SKILLS_MIGRATED_KEY = 'openagile:skillsMigrated';

function markMigrated() {
  try { localStorage.setItem(SKILLS_MIGRATED_KEY, '1'); } catch { /* ignore */ }
}

function normalizeSkill(raw, index) {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Untitled skill',
    description: typeof raw.description === 'string' ? raw.description : '',
    content: typeof raw.content === 'string' ? raw.content : '',
    order: Number.isFinite(raw.order) ? raw.order : index + 1
  };
}

function migrateSkillsFromLocalStorage() {
  if (Array.isArray(globalState.skills) && globalState.skills.length > 0) return;
  const raw = readJson(SKILLS_KEY, []);
  if (!Array.isArray(raw) || raw.length === 0) return;

  const skills = raw.map((skill, index) => normalizeSkill(skill, index)).filter(Boolean);
  if (skills.length === 0) return;

  markMigrated();
  for (const skill of skills) {
    scheduleDomainEvent({ type: 'skill.created', scope: 'global', entityId: skill.id, payload: { skill } });
  }
}

function ensureSkillsReady() {
  readModelProjector.register();
  migrateSkillsFromLocalStorage();
}

export function listSkills() {
  ensureSkillsReady();
  const raw = Array.isArray(globalState.skills) ? globalState.skills : [];
  return raw
    .filter((skill) => skill && skill.deleted !== true)
    .map((skill, index) => normalizeSkill(skill, index))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
}

export function getSkill(skillId) {
  const id = typeof skillId === 'string' ? skillId : '';
  if (!id) return null;
  return listSkills().find((skill) => skill.id === id) || null;
}

export function pushSkillsToServer() {
  ensureSkillsReady();
}

export function createSkill({ name = 'New skill', description = '', content = '' } = {}) {
  ensureSkillsReady();
  const skills = listSkills();
  const trimmed = typeof name === 'string' && name.trim() ? name.trim() : 'New skill';
  const skill = {
    id: generateUUID(),
    name: trimmed,
    description: typeof description === 'string' ? description : '',
    content: typeof content === 'string' ? content : '',
    order: skills.length + 1
  };
  scheduleDomainEvent({ type: 'skill.created', scope: 'global', entityId: skill.id, payload: { skill } });
  return skill;
}

export function updateSkill(skillId, fields = {}) {
  const id = typeof skillId === 'string' ? skillId : '';
  if (!id) return false;

  ensureSkillsReady();
  const skill = listSkills().find((entry) => entry.id === id);
  if (!skill) return false;

  const next = {
    name: typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : skill.name,
    description: typeof fields.description === 'string' ? fields.description : skill.description,
    content: typeof fields.content === 'string' ? fields.content : skill.content
  };

  const changed = {};
  if (next.name !== skill.name) changed.name = next.name;
  if (next.description !== skill.description) changed.description = next.description;
  if (next.content !== skill.content) changed.content = next.content;
  if (Object.keys(changed).length > 0) {
    scheduleDomainEvent({ type: 'skill.updated', scope: 'global', entityId: id, payload: { fields: changed } });
  }
  return true;
}

export function deleteSkill(skillId) {
  const id = typeof skillId === 'string' ? skillId : '';
  if (!id) return false;

  ensureSkillsReady();
  if (!listSkills().some((skill) => skill.id === id)) return false;

  scheduleDomainEvent({ type: 'skill.deleted', scope: 'global', entityId: id, payload: {} });
  return true;
}

export function adoptSkillsState(state) {
  if (!state || typeof state !== 'object') return;
  if (!Array.isArray(state.skills)) return;

  ensureSkillsReady();
  const current = new Map(listSkills().map((skill) => [skill.id, skill]));

  for (const [index, raw] of state.skills.entries()) {
    const skill = normalizeSkill(raw, index);
    if (!skill) continue;

    const existing = current.get(skill.id);
    if (!existing) {
      scheduleDomainEvent({ type: 'skill.created', scope: 'global', entityId: skill.id, payload: { skill } });
      continue;
    }

    const fields = {};
    if (existing.name !== skill.name) fields.name = skill.name;
    if (existing.description !== skill.description) fields.description = skill.description;
    if (existing.content !== skill.content) fields.content = skill.content;
    if (existing.order !== skill.order) fields.order = skill.order;
    if (Object.keys(fields).length > 0) {
      scheduleDomainEvent({ type: 'skill.updated', scope: 'global', entityId: skill.id, payload: { fields } });
    }
  }
}

export function initSkillsSync() {
  if (initSkillsSync._started) return;
  initSkillsSync._started = true;

  ensureSkillsReady();

  apiFetch('/api/skills', { headers: { accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((state) => {
      if (!state) return;
      if (Array.isArray(state.skills) && state.skills.length > 0) {
        adoptSkillsState(state);
      }
    })
    .catch(() => {});

  window.addEventListener('openagile:skills-changed', (event) => {
    adoptSkillsState(event.detail);
  });
}
