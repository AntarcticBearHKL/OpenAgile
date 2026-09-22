import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { mountToBody } from './setup.js';

vi.mock('../../src/modules/modals.js', () => ({
  setupModalCloseHandlers: (modalId, closeHandler) => {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    modal.querySelector('.modal-backdrop')?.addEventListener('click', closeHandler);
    modal
      .querySelectorAll('[id$="-close-btn"], [id$="-close-modal-btn"], [id$="-cancel-btn"], [id^="cancel-"]')
      .forEach((btn) => btn.addEventListener('click', closeHandler));
  }
}));

vi.mock('../../src/modules/icons.js', () => ({
  renderIcons: vi.fn()
}));

const SKILLS_KEY = 'openagile:skills';

const FIXTURE = `
  <button id="skills-btn" type="button" aria-haspopup="dialog">Skills</button>
  <div id="skills-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="skills-modal-title">
    <div class="modal-backdrop" data-close-modal></div>
    <article class="modal-content skills-modal-content">
      <header class="modal-header-row">
        <h3 id="skills-modal-title">Skills</h3>
        <button id="skills-close-modal-btn" type="button">X</button>
      </header>
      <div class="skills-layout">
        <aside class="skills-list-pane">
          <div class="skills-list-header">
            <span class="skills-list-heading">Skills</span>
            <button id="skill-add-btn" type="button">+</button>
          </div>
          <ul id="skills-list" class="skills-list" role="listbox"></ul>
        </aside>
        <section class="skills-editor-pane">
          <div id="skills-empty-state" class="skills-empty-state">
            <p class="skills-empty-title">No skills yet</p>
          </div>
          <form id="skill-form" class="skills-editor hidden" novalidate>
            <input id="skill-name" type="text">
            <input id="skill-description" type="text">
            <textarea id="skill-content"></textarea>
            <button id="skill-delete-btn" type="button">Delete</button>
            <button id="skill-save-btn" type="submit">Save</button>
          </form>
        </section>
      </div>
    </article>
  </div>
`;

const SKILL_A = {
  id: 'skill-a',
  name: 'Workflow',
  description: 'How work moves',
  content: 'Move tasks left to right.',
  order: 1
};

const SKILL_B = {
  id: 'skill-b',
  name: 'Naming',
  description: 'Task naming rules',
  content: 'Prefix tasks with the epic name.',
  order: 2
};

let skillsModule;

function seedSkills(skills) {
  localStorage.setItem(SKILLS_KEY, JSON.stringify(skills));
}

function projectedSkills() {
  return skillsModule.listSkills();
}

function openModal() {
  fireEvent.click(document.getElementById('skills-btn'));
}

function skillItems() {
  return Array.from(document.querySelectorAll('#skills-list .skill-item'));
}

beforeEach(async () => {
  vi.resetModules();
  mountToBody(FIXTURE);
  globalThis.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ skills: [] }) }));

  skillsModule = await import('../../src/modules/skills.js');
  const { initializeSkillsUI } = await import('../../src/modules/skills-modal.js');
  initializeSkillsUI();
});

describe('skills modal', () => {
  test('opens from the header button and closes via the close button', () => {
    seedSkills([SKILL_A]);
    const modal = document.getElementById('skills-modal');

    expect(modal.classList.contains('hidden')).toBe(true);
    openModal();
    expect(modal.classList.contains('hidden')).toBe(false);

    fireEvent.click(document.getElementById('skills-close-modal-btn'));
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('closes via the backdrop', () => {
    openModal();
    const modal = document.getElementById('skills-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    fireEvent.click(modal.querySelector('.modal-backdrop'));
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('renders stored skills, selects the first, and shows its content', () => {
    seedSkills([SKILL_A, SKILL_B]);
    openModal();

    const items = skillItems();
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.skill-item-name').textContent).toBe('Workflow');
    expect(items[0].querySelector('.skill-item-description').textContent).toBe('How work moves');
    expect(items[0].classList.contains('skill-item--active')).toBe(true);
    expect(items[0].getAttribute('aria-selected')).toBe('true');

    expect(document.getElementById('skill-name').value).toBe('Workflow');
    expect(document.getElementById('skill-description').value).toBe('How work moves');
    expect(document.getElementById('skill-content').value).toBe('Move tasks left to right.');
    expect(document.getElementById('skill-form').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('skills-empty-state').classList.contains('hidden')).toBe(true);
  });

  test('clicking another skill moves the selection and loads its fields', () => {
    seedSkills([SKILL_A, SKILL_B]);
    openModal();

    fireEvent.click(skillItems()[1]);

    const items = skillItems();
    expect(items[1].classList.contains('skill-item--active')).toBe(true);
    expect(items[0].classList.contains('skill-item--active')).toBe(false);
    expect(document.getElementById('skill-name').value).toBe('Naming');
    expect(document.getElementById('skill-content').value).toBe('Prefix tasks with the epic name.');
  });

  test('shows the empty state instead of the editor when no skills exist', () => {
    openModal();

    expect(document.getElementById('skills-empty-state').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('skill-form').classList.contains('hidden')).toBe(true);
    expect(skillItems()).toHaveLength(0);
  });

  test('add creates a skill, selects it, and focuses the name field', () => {
    openModal();
    fireEvent.click(document.getElementById('skill-add-btn'));

    expect(projectedSkills()).toHaveLength(1);
    expect(skillItems()).toHaveLength(1);
    expect(skillItems()[0].querySelector('.skill-item-name').textContent).toBe('New skill');

    const nameInput = document.getElementById('skill-name');
    expect(nameInput.value).toBe('New skill');
    expect(document.activeElement).toBe(nameInput);
    expect(document.getElementById('skill-form').classList.contains('hidden')).toBe(false);
  });

  test('save persists all fields and emits DATA_CHANGED', async () => {
    seedSkills([SKILL_A]);
    const { on, DATA_CHANGED } = await import('../../src/modules/events.js');
    const changed = vi.fn();
    on(DATA_CHANGED, changed);

    openModal();
    document.getElementById('skill-name').value = 'Workflow v2';
    document.getElementById('skill-description').value = 'Updated';
    document.getElementById('skill-content').value = 'New instructions.';
    fireEvent.submit(document.getElementById('skill-form'));

    const [saved] = projectedSkills();
    expect(saved.name).toBe('Workflow v2');
    expect(saved.description).toBe('Updated');
    expect(saved.content).toBe('New instructions.');
    expect(changed).toHaveBeenCalled();
  });

  test('delete arms on the first click and deletes on the second', () => {
    seedSkills([SKILL_A, SKILL_B]);
    openModal();

    const deleteBtn = document.getElementById('skill-delete-btn');
    fireEvent.click(deleteBtn);

    expect(deleteBtn.classList.contains('is-armed')).toBe(true);
    expect(deleteBtn.textContent).toBe('!');
    expect(projectedSkills()).toHaveLength(2);

    fireEvent.click(deleteBtn);

    expect(projectedSkills()).toHaveLength(1);
    expect(projectedSkills()[0].id).toBe('skill-b');
    expect(deleteBtn.classList.contains('is-armed')).toBe(false);
    expect(deleteBtn.textContent).toBe('Delete');
    expect(document.getElementById('skill-content').value).toBe('Prefix tasks with the epic name.');
  });

  test('blur cancels an armed delete', () => {
    seedSkills([SKILL_A]);
    openModal();

    const deleteBtn = document.getElementById('skill-delete-btn');
    fireEvent.click(deleteBtn);
    expect(deleteBtn.classList.contains('is-armed')).toBe(true);

    fireEvent.blur(deleteBtn);

    expect(deleteBtn.classList.contains('is-armed')).toBe(false);
    expect(deleteBtn.textContent).toBe('Delete');
    expect(projectedSkills()).toHaveLength(1);
  });

  test('Escape closes the modal', () => {
    openModal();
    const modal = document.getElementById('skills-modal');
    expect(modal.classList.contains('hidden')).toBe(false);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  test('re-renders when DATA_CHANGED is emitted', async () => {
    seedSkills([SKILL_A]);
    openModal();
    expect(skillItems()).toHaveLength(1);

    skillsModule.createSkill({ name: 'Naming' });

    expect(skillItems()).toHaveLength(2);
  });
});
