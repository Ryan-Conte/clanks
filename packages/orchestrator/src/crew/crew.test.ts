import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/store';
import { crewFolder, migrationsFolder, tempDir } from '../test-helpers';
import { CrewService } from './crew';
import { PREMADE_CREW } from './docs';

function setup() {
  const store = openStore({ file: ':memory:', migrationsFolder });
  const editedDir = join(tempDir(), 'crew');
  const crew = new CrewService({ bundledDir: crewFolder, editedDir, db: store.db });
  return { crew, editedDir, db: store.db };
}

const forge = readFileSync(join(crewFolder, 'forge.md'), 'utf8');

describe('CrewService', () => {
  it('lists the premade crew in roster order, as their docs describe them', () => {
    const { crew } = setup();
    const summaries = crew.summaries();
    expect(summaries.map((c) => c.id)).toEqual([...PREMADE_CREW]);
    expect(summaries[0]).toMatchObject({
      id: 'atlas',
      name: 'Atlas',
      role: 'Lead',
      avatar: 'violet',
      kind: 'checker',
      stage: 'signoff',
      model: null,
      doc: 'bundled',
      docError: null,
    });
    expect(crew.rules()).toMatch(/^You are \{\{clank\.name\}\}/);
  });

  it('uses an edited doc, and resets to the bundled one', () => {
    const { crew, editedDir } = setup();
    const changes: number[] = [];
    crew.on('change', () => changes.push(1));
    const edited = forge.replace('You are the engineer.', 'You are the engineer. Use tabs.');
    expect(crew.saveDoc('forge', edited)).toMatchObject({ doc: 'edited' });
    expect(crew.get('forge').body).toContain('Use tabs.');
    expect(readFileSync(join(editedDir, 'forge.md'), 'utf8')).toBe(edited);
    expect(crew.docText('forge')).toMatchObject({ edited: true, text: edited, bundled: forge });

    expect(crew.resetDoc('forge')).toMatchObject({ doc: 'bundled' });
    expect(crew.get('forge').body).not.toContain('Use tabs.');
    expect(changes).toHaveLength(2);
  });

  it('treats saving the bundled text as a reset', () => {
    const { crew } = setup();
    crew.saveDoc('forge', forge.replace(/\r\n/g, '\n') + '\n');
    expect(crew.get('forge').doc).toBe('bundled');
  });

  it('refuses a doc that would not work', () => {
    const { crew } = setup();
    expect(() => crew.saveDoc('forge', 'just a prompt')).toThrow(/frontmatter/);
    expect(() => crew.saveDoc('forge', forge.replace('id: forge', 'id: forge2'))).toThrow(
      /must stay forge/,
    );
    expect(() => crew.saveDoc('nobody', forge)).toThrow(/no clank called nobody/);
    expect(crew.get('forge').doc).toBe('bundled');
  });

  it('keeps working on the bundled doc when an edited copy breaks outside the app', () => {
    const { crew, editedDir } = setup();
    mkdirSync(editedDir, { recursive: true });
    writeFileSync(join(editedDir, 'gauge.md'), '---\nid: gauge\n---\nBroken.');
    const gauge = crew.get('gauge');
    expect(gauge.doc).toBe('edited');
    expect(gauge.docError).toMatch(/frontmatter has problems/);
    expect(gauge.body).toContain('You are QA.');
  });

  it('saves profile changes, which win over the doc', () => {
    const { crew } = setup();
    crew.updateProfile('quill', { name: 'Penny', avatar: 'cyan' });
    crew.updateProfile('quill', { model: { provider: 'anthropic', model: 'claude-x' } });
    expect(crew.summaries().find((c) => c.id === 'quill')).toMatchObject({
      name: 'Penny',
      avatar: 'cyan',
      model: { provider: 'anthropic', model: 'claude-x' },
    });
    crew.clearModel('anthropic');
    crew.updateProfile('quill', { name: null });
    expect(crew.get('quill')).toMatchObject({ name: 'Quill', avatar: 'cyan' });
    expect(crew.get('quill').overrides.model).toBeNull();
  });
});
