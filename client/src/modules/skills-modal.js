// Skills editor modal — plain-text usage guides the AI agent reads over MCP.

import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  initSkillsSync
} from './skills.js';
import { setupModalCloseHandlers } from './modal-utils.js';
import { emit, on, DATA_CHANGED } from './events.js';
import { renderIcons } from './icons.js';
import { $id, h } from './dom.js';
import { createArmedDeleteController } from './armed-delete-button.js';

let initialized = false;
let selectedSkillId = null;
let forceEditorReload = false;
let deleteConfirm = null;

function renderList(skills) {
  const listEl = $id('skills-list');
  if (!listEl) return;

  listEl.innerHTML = '';
  skills.forEach((skill) => {
    const isActive = skill.id === selectedSkillId;
    const item = h('li', {
      class: `skill-item${isActive ? ' skill-item--active' : ''}`,
      role: 'option',
      tabIndex: 0,
      'data-skill-id': skill.id,
      'aria-selected': String(isActive)
    },
      h('span', { class: 'skill-item-name' }, skill.name),
      skill.description ? h('span', { class: 'skill-item-description' }, skill.description) : null
    );

    item.addEventListener('click', () => selectSkill(skill.id));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectSkill(skill.id);
      }
    });

    listEl.appendChild(item);
  });
}

function populateEditor(skill) {
  const nameInput = $id('skill-name');
  const descriptionInput = $id('skill-description');
  const contentInput = $id('skill-content');
  if (nameInput) nameInput.value = skill.name;
  if (descriptionInput) descriptionInput.value = skill.description;
  if (contentInput) contentInput.value = skill.content;
}

function renderEditor(skill, force) {
  const form = $id('skill-form');
  const empty = $id('skills-empty-state');
  if (!form || !empty) return;

  if (!skill) {
    form.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  form.classList.remove('hidden');

  // Never clobber in-progress edits on background DATA_CHANGED re-renders.
  if (!force && form.contains(document.activeElement)) return;

  populateEditor(skill);
}

function render() {
  const modal = $id('skills-modal');
  if (!modal) return;

  const skills = listSkills();
  if (!skills.some((skill) => skill.id === selectedSkillId)) {
    selectedSkillId = skills.length ? skills[0].id : null;
  }

  renderList(skills);
  renderEditor(selectedSkillId ? getSkill(selectedSkillId) : null, forceEditorReload);
  forceEditorReload = false;
  renderIcons();
}

function selectSkill(skillId) {
  if (skillId === selectedSkillId) return;
  deleteConfirm?.reset();
  selectedSkillId = skillId;
  forceEditorReload = true;
  render();
}

function showSkillsModal() {
  forceEditorReload = true;
  render();
  $id('skills-modal')?.classList.remove('hidden');

  const selectedItem = selectedSkillId
    ? document.querySelector(`#skills-list [data-skill-id="${selectedSkillId}"]`)
    : null;
  (selectedItem || $id('skill-add-btn'))?.focus();
}

function hideSkillsModal() {
  deleteConfirm?.reset();
  $id('skills-modal')?.classList.add('hidden');
}

function handleAdd() {
  deleteConfirm?.reset();
  const skill = createSkill({ name: 'New skill' });
  selectedSkillId = skill.id;
  forceEditorReload = true;
  emit(DATA_CHANGED, { affectsBoard: false });

  const nameInput = $id('skill-name');
  nameInput?.focus();
  nameInput?.select();
}

function handleSave(event) {
  event.preventDefault();
  if (!selectedSkillId) return;

  const saved = updateSkill(selectedSkillId, {
    name: $id('skill-name')?.value ?? '',
    description: $id('skill-description')?.value ?? '',
    content: $id('skill-content')?.value ?? ''
  });
  if (!saved) return;

  emit(DATA_CHANGED, { affectsBoard: false });

  const skill = getSkill(selectedSkillId);
  if (skill) populateEditor(skill);
}

function handleDeleteClick() {
  if (!selectedSkillId) return;
  deleteConfirm?.handleClick();
}

export function initializeSkillsUI() {
  if (initialized) return;
  initialized = true;

  initSkillsSync();

  $id('skills-btn')?.addEventListener('click', showSkillsModal);
  setupModalCloseHandlers('skills-modal', hideSkillsModal);

  $id('skill-add-btn')?.addEventListener('click', handleAdd);
  $id('skill-form')?.addEventListener('submit', handleSave);
  const deleteBtn = $id('skill-delete-btn');
  if (deleteBtn) {
    deleteConfirm = createArmedDeleteController({
      button: deleteBtn,
      armedContent: '!',
      armedTitle: 'Click again to confirm delete',
      armedAria: 'Click again to confirm delete',
      onRestore: () => {
        deleteBtn.textContent = 'Delete';
        deleteBtn.title = 'Delete skill';
        deleteBtn.setAttribute('aria-label', 'Delete skill');
      },
      onConfirm: () => {
        const skillId = selectedSkillId;
        deleteConfirm?.reset();
        if (deleteSkill(skillId)) {
          selectedSkillId = null;
          forceEditorReload = true;
          emit(DATA_CHANGED, { affectsBoard: false });
        }
      }
    });
    deleteBtn.addEventListener('click', handleDeleteClick);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const modal = $id('skills-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    const dialog = $id('dialog-modal');
    if (dialog && !dialog.classList.contains('hidden')) return;
    hideSkillsModal();
  });

  on(DATA_CHANGED, render);

  render();
}
