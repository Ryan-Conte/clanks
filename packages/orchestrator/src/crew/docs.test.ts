import {
  ALWAYS_AVAILABLE_TOOLS,
  type ClankFrontmatter,
  TOOL_NAMES,
  estimateTokens,
  isToolName,
  toolsMatching,
} from '@clanks/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crewFolder } from '../test-helpers';
import {
  CREW_RULES_FILE,
  PREMADE_CREW,
  parseClankDoc,
  parseCrewRules,
  stripComments,
} from './docs';

/** The crew docs that ship with the app, plus the custom-clank template and its worked example. */
const DOCS = [...PREMADE_CREW.map((id) => `${id}.md`), 'custom.md', 'examples/sentinel.md'];

const read = (file: string) => readFileSync(join(crewFolder, file), 'utf8');
const rules = parseCrewRules(read(CREW_RULES_FILE));

/** The first word of every tool name, such as `fs` or `browser`: backticked words like these are tools. */
const TOOL_PREFIXES = new Set(TOOL_NAMES.map((name) => name.split('_')[0]!));

/** Backticked words in a doc that name, or look like they name, a tool. */
function toolMentions(text: string): string[] {
  const found = new Set<string>();
  for (const [, word] of text.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)) {
    if (isToolName(word!) || (word!.includes('_') && TOOL_PREFIXES.has(word!.split('_')[0]!))) {
      found.add(word!);
    }
  }
  return [...found];
}

function toolsGiven(frontmatter: ClankFrontmatter): Set<string> {
  const { allow, ask } = frontmatter.tools;
  return new Set([...ALWAYS_AVAILABLE_TOOLS, ...[...allow, ...ask].flatMap(toolsMatching)]);
}

describe('the crew rules', () => {
  it('name only tools every clank has', () => {
    for (const tool of toolMentions(rules)) {
      expect(ALWAYS_AVAILABLE_TOOLS, `CREW.md mentions ${tool}`).toContain(tool);
    }
  });

  it('use only the variables the app fills in', () => {
    const used = [...rules.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(
      new Set(['clank.name', 'user.name', 'date', 'os', 'crew', 'workflow']),
    );
  });
});

describe.each(DOCS)('%s', (file) => {
  const text = read(file);
  const doc = parseClankDoc(text);

  it('has valid frontmatter whose tools are real', () => {
    const { allow, ask, deny } = doc.frontmatter.tools;
    for (const entry of [...allow, ...ask, ...deny]) {
      expect(toolsMatching(entry), `${entry} names no tool`).not.toEqual([]);
    }
    const listed = [...allow, ...ask].flatMap(toolsMatching);
    for (const tool of ALWAYS_AVAILABLE_TOOLS) {
      expect(listed, `${tool} is always available, so it isn't listed`).not.toContain(tool);
    }
  });

  it('stays under 2,500 tokens with the crew rules', () => {
    expect(estimateTokens(rules) + estimateTokens(doc.body)).toBeLessThanOrEqual(2500);
  });

  it('names only real tools it is given', () => {
    const given = toolsGiven(doc.frontmatter);
    for (const tool of toolMentions(doc.body)) {
      expect(isToolName(tool), `${tool} isn't a tool`).toBe(true);
      expect(given.has(tool), `${file} mentions ${tool} but isn't given it`).toBe(true);
    }
  });

  it('says what its finishing call is', () => {
    if (file === 'custom.md') return;
    const finish = doc.frontmatter.workflow.kind === 'maker' ? 'submit_output' : 'review_pass';
    expect(doc.body).toContain(`\`${finish}\``);
  });

  it('uses only the variables the app fills in', () => {
    for (const [, name] of doc.body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      expect(['date', 'os', 'clank.name', 'user.name', 'crew', 'workflow']).toContain(name);
    }
  });

  it('keeps notes for people out of the prompt', () => {
    expect(doc.body).not.toContain('<!--');
  });
});

describe('the tool check', () => {
  it('finds the tools a doc names, and words that only look like tools', () => {
    const forge = parseClankDoc(read('forge.md'));
    expect(toolMentions(forge.body)).toEqual(
      expect.arrayContaining(['fs_edit', 'shell_start', 'browser_open', 'submit_output']),
    );
    expect(toolMentions('Use `fs_frobnicate`, `npm test` and `min_context`.')).toEqual([
      'fs_frobnicate',
    ]);
  });

  it('catches a tool the clank is not given', () => {
    const quill = parseClankDoc(read('quill.md'));
    expect(toolsGiven(quill.frontmatter).has('shell_exec')).toBe(false);
    expect(toolsGiven(quill.frontmatter).has('ask_clank')).toBe(true);
  });
});

describe('parseClankDoc', () => {
  const valid = read('forge.md');

  it('accepts Windows line endings and a byte order mark', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseClankDoc(bom + valid.replace(/\r?\n/g, '\r\n')).frontmatter.id).toBe('forge');
  });

  it('explains what is wrong', () => {
    expect(() => parseClankDoc('# Forge\n\nNo frontmatter.')).toThrow(/frontmatter/);
    expect(() => parseClankDoc('---\nid: [unclosed\n---\nBody')).toThrow(/valid YAML/);
    expect(() => parseClankDoc(valid.replace('temperature: 0.2', 'temperature: hot'))).toThrow(
      /temperature/,
    );
    expect(() =>
      parseClankDoc(valid.replace(/---\s*$/, '').split(/\n---\n/)[0] + '\n---\n'),
    ).toThrow(/no prompt/);
  });

  it('strips comments', () => {
    expect(stripComments('a <!-- note\nfor people --> b')).toBe('a  b');
  });
});
