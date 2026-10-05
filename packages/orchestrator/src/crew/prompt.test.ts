import { type UserProfile } from '@clanks/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/store';
import { crewFolder, migrationsFolder, tempDir } from '../test-helpers';
import { type Clank, CrewService } from './crew';
import { parseClankDoc } from './docs';
import { instructionsFor } from './instructions';
import {
  type PromptInput,
  type RunContext,
  assemblePrompt,
  crewRoster,
  workflowStages,
} from './prompt';

const profile: UserProfile = {
  name: 'Sam',
  timeZone: 'Australia/Perth',
  language: 'Australian English',
  preferences: 'Short answers. Never use {{date}} literally.',
};

function crewService() {
  const store = openStore({ file: ':memory:', migrationsFolder });
  return new CrewService({ bundledDir: crewFolder, editedDir: tempDir(), db: store.db });
}

/** A chat's run context: no folder and no tools unless a test gives them. */
function chat(overrides: Partial<RunContext> = {}): RunContext {
  return {
    mode: 'chat',
    folder: null,
    workspace: null,
    workspaceStatus: null,
    tools: [],
    shell: null,
    toolsUnsupported: false,
    problems: [],
    ...overrides,
  };
}

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  const crew = crewService();
  return {
    rules: crew.rules(),
    clank: crew.get('forge'),
    crew: crew.list(),
    profile,
    instructions: null,
    run: chat(),
    // 23:30 UTC is already the next day in Perth.
    now: new Date('2026-10-04T23:30:00Z'),
    platform: 'win32',
    ...overrides,
  };
}

/** Sentinel, the worked custom checker, as if it were in the crew. */
function sentinel(): Clank {
  const doc = parseClankDoc(readFileSync(join(crewFolder, 'examples/sentinel.md'), 'utf8'));
  return {
    ...doc,
    id: 'sentinel',
    name: 'Sentinel',
    avatar: 'red',
    overrides: { name: null, avatar: null, model: null, tools: {} },
    doc: 'bundled',
    docError: null,
  };
}

describe('assemblePrompt', () => {
  it('stacks the layers in order, stable ones first', () => {
    const prompt = assemblePrompt(input());
    expect(prompt.layers.map((l) => l.id)).toEqual(['crew', 'clank', 'profile', 'run']);
    expect(prompt.system).toBe(prompt.layers.map((l) => l.text).join('\n\n'));
    expect(prompt.system.indexOf('## The crew')).toBeLessThan(prompt.system.indexOf('# Forge'));
    expect(prompt.tokens).toBeGreaterThan(1000);
  });

  it('fills in the variables, in the user’s time zone', () => {
    const { system } = assemblePrompt(input());
    expect(system).toMatch(/^You are Forge, one of the clanks/);
    expect(system).toContain("on Sam's computer. Today is 2026-10-05. The computer runs Windows.");
    // The user's own text is never templated.
    expect(system).toContain('Never use {{date}} literally.');
    expect(system.replace('{{date}} literally', '')).not.toContain('{{');
  });

  it('describes the crew and the workflow', () => {
    const { system } = assemblePrompt(input());
    expect(system).toContain(
      '- Forge (`forge`), Engineer: makes `pr`. Writes the code and tests in its own worktree and opens pull requests.',
    );
    expect(system).toContain('- Atlas (`atlas`), Lead: signs off every ticket.');
    expect(system).toContain('- Gauge (`gauge`), QA: checks `pr`.');
    expect(system).toContain(
      '1. Spec: Scribe\n2. Design: Prism\n3. Build: Forge, Scout, Quill, Buzz\n4. QA: Gauge\n5. Sign-off: Atlas',
    );
  });

  it('places a custom checker after the stage it follows', () => {
    const crew = [...input().crew, sentinel()];
    expect(workflowStages(crew)).toContain(
      '4. QA: Gauge\n5. Security: Sentinel\n6. Sign-off: Atlas',
    );
    expect(crewRoster(crew)).toContain('- Sentinel (`sentinel`), Security: checks `pr`.');
  });

  it('describes the user from their profile', () => {
    const profileLayer = assemblePrompt(input()).layers.find((l) => l.id === 'profile')!;
    expect(profileLayer.text).toBe(
      [
        '## About Sam',
        '',
        '- Name: Sam',
        '- Time zone: Australia/Perth',
        '- Language: Australian English. Write in it.',
        '',
        'How Sam likes to work:',
        '',
        'Short answers. Never use {{date}} literally.',
      ].join('\n'),
    );
  });

  it('calls a user with no name "the user", capitalised where a sentence starts', () => {
    const empty = { name: '', timeZone: 'UTC', language: '', preferences: '' };
    const atlas = crewService().get('atlas');
    const { system, layers } = assemblePrompt(input({ profile: empty, clank: atlas }));
    expect(system).toContain("on the user's computer");
    expect(system).toContain('\nThe user: "Build me a surfing website');
    expect(system).toContain('\nThe user can watch you work');
    expect(system).not.toMatch(/(?:^|\n|\. )the user/);
    expect(layers.find((l) => l.id === 'profile')!.text).toBe(
      '## About the user\n\n- Time zone: UTC',
    );
  });

  it('says a chat has no tools, so the clank never claims to have used one', () => {
    const run = assemblePrompt(
      input({ run: chat({ folder: 'C:\\surf', workspaceStatus: 'not_repo' }) }),
    ).layers.at(-1)!;
    expect(run.id).toBe('run');
    expect(run.text).toContain('Mode: chat. You are talking with Sam directly.');
    expect(run.text).toContain('This chat is about the folder `C:\\surf`.');
    expect(run.text).toContain("It isn't a git repository yet");
    expect(run.text).toContain('No tools are connected to this chat');
  });

  it('tells a clank with tools where its copy is and how it works', () => {
    const run = assemblePrompt(
      input({
        run: chat({
          folder: 'C:\\surf',
          workspace: {
            worktree: 'D:\\wt\\chat-1',
            cwd: 'D:\\wt\\chat-1',
            branch: 'clanks/chat-1',
            baseCommit: 'abcdef1234567890',
          },
          workspaceStatus: 'ready',
          tools: ['fs_read', 'shell_exec'],
          shell: 'bash',
          problems: ['GitHub: it failed to start'],
        }),
      }),
    ).layers.at(-1)!;
    expect(run.text).toContain(
      'a git worktree on the branch `clanks/chat-1`, made from commit `abcdef1`',
    );
    expect(run.text).toContain('Your tools here: `fs_read`, `shell_exec`.');
    expect(run.text).toContain('Commands run in bash.');
    expect(run.text).toContain('Sam watches your file changes in the diff editor');
    expect(run.text).toContain("These tools aren't working right now: GitHub: it failed to start.");
    expect(run.text).not.toContain('No tools are connected');
    const unsupported = assemblePrompt(input({ run: chat({ toolsUnsupported: true }) }));
    expect(unsupported.layers.at(-1)!.text).toContain("The model you run on can't call tools");
  });

  it("adds the project's instructions for this clank, untemplated", () => {
    const text = [
      '# Surf shop',
      '',
      'Prices include GST. {{date}} stays as it is.',
      '',
      '## For Forge',
      '',
      'Use pnpm.',
      '',
      '## For Buzz',
      '',
      'One emoji per post.',
    ].join('\n');
    const layer = assemblePrompt(input({ instructions: { file: 'CLANKS.md', text } })).layers.find(
      (l) => l.id === 'instructions',
    )!;
    expect(layer.title).toBe('CLANKS.md');
    expect(layer.text).toContain('Sam wrote these in `CLANKS.md` for this project. Follow them.');
    expect(layer.text).toContain('{{date}} stays as it is.');
    expect(layer.text).toContain('## For Forge\n\nUse pnpm.');
    expect(layer.text).not.toContain('emoji');
    expect(layer.truncated).toBe(false);
  });

  it('cuts instructions over their budget, and says so', () => {
    const text = Array.from({ length: 800 }, (_, i) => `Rule ${i}: keep it tidy.`).join('\n');
    const layer = assemblePrompt(input({ instructions: { file: 'AGENTS.md', text } })).layers.find(
      (l) => l.id === 'instructions',
    )!;
    expect(layer.truncated).toBe(true);
    expect(layer.tokens).toBeLessThanOrEqual(1520);
    expect(layer.text).toMatch(/\(The rest was cut to fit\.\)$/);
  });
});

describe('instructionsFor', () => {
  const clank = { id: 'gauge', names: ['Gauge'] };

  it('keeps shared sections and the clank’s own, wherever they are', () => {
    const text = [
      'Top.',
      '## Build',
      'pnpm build',
      '## For Forge and Gauge',
      'Both.',
      '## For Forge',
      'Forge only.',
      '### Still Forge',
      'Nested.',
      '## Deploy',
      'Shared again.',
    ].join('\n');
    expect(instructionsFor(text, clank)).toBe(
      [
        'Top.',
        '## Build',
        'pnpm build',
        '## For Forge and Gauge',
        'Both.',
        '## Deploy',
        'Shared again.',
      ].join('\n'),
    );
  });

  it('ignores headings inside code blocks', () => {
    const text = ['## For Forge', '```sh', '## For Gauge', 'echo hi', '```', 'Forge only.'].join(
      '\n',
    );
    expect(instructionsFor(text, clank)).toBe('');
  });

  it('matches names whatever their case, and drops comments', () => {
    expect(instructionsFor('## for GAUGE\nHi <!-- note -->', clank)).toBe('## for GAUGE\nHi');
  });
});
