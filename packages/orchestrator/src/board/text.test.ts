import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@clanks/core';
import { checksRun, designedFrames, framesAsMade, framesNamed } from './text';

/** A command a run made, as the conversation keeps it. */
const ran = (command: string, ok: boolean, result = ''): MessagePart =>
  ({
    type: 'tool',
    name: 'shell_exec',
    status: ok ? 'done' : 'failed',
    arguments: JSON.stringify({ command }),
    result,
  }) as MessagePart;

describe("what a checker's own run says about the build", () => {
  it('finds a build or test that failed the last time it ran', () => {
    expect(checksRun([])).toEqual({ failed: null, built: false });
    expect(checksRun([ran('ls -la', false), ran('git status', true)])).toEqual({
      failed: null,
      built: false,
    });
    expect(checksRun([ran('npm install && npm run build', true)])).toEqual({
      failed: null,
      built: true,
    });
    // Red, then looked around, then passed anyway: still red.
    expect(
      checksRun([ran('npm install && npm run build && npm test', false), ran('npm run', true)]),
    ).toEqual({ failed: 'npm install && npm run build && npm test', built: false });
    // Red, then green: fine.
    expect(checksRun([ran('npm run build', false), ran('npm run build', true)])).toEqual({
      failed: null,
      built: true,
    });
    // Green, then red: not fine.
    expect(checksRun([ran('npm run build', true), ran('npm run build', false)])).toEqual({
      failed: 'npm run build',
      built: false,
    });
  });

  it("doesn't count a check the project never had", () => {
    expect(
      checksRun([
        ran('npm run build', true),
        ran('npm test', false, 'npm error Missing script: "test"'),
        ran('pytest', false, 'bash: pytest: command not found'),
      ]),
    ).toEqual({ failed: null, built: true });
    expect(checksRun([ran('npm test', false, '1 failed, 41 passed')])).toEqual({
      failed: 'npm test',
      built: false,
    });
  });
});

describe('what a design hand-in says it made', () => {
  it('finds the frames it lists and the ones it quotes', () => {
    expect(
      framesNamed({
        frames: [
          'Home / Desktop: the hero and the grid',
          { name: 'Home / Mobile', shows: 'The same, stacked' },
          'Button Primary',
        ],
        summary: 'Designed the storefront.',
        notes: 'The `Cart / Desktop` frame covers the empty state.',
        criteria: [
          {
            text: 'A landing page',
            status: 'met',
            evidence: "Frame 'Landing Page / Desktop' has it.",
          },
          'AC-2: met, see “Checkout / Desktop”',
        ],
      }),
    ).toEqual([
      'Home / Desktop',
      'Home / Mobile',
      'Cart / Desktop',
      'Landing Page / Desktop',
      'Checkout / Desktop',
    ]);
  });

  it("leaves alone what isn't a frame's name", () => {
    expect(
      framesNamed({
        frames: 'all of them',
        notes: 'Uses "primary/lg" and a 4 / 8 / 16 spacing scale. Read/write is fine.',
        criteria: [{ evidence: 'The and/or case is covered' }, null, 3],
      }),
    ).toEqual([]);
  });

  it('lists the frames design tickets have handed in, for a campaign to show', () => {
    expect(
      designedFrames([
        {
          type: 'design',
          output: { type: 'design', frames: ['X / Square', 'LinkedIn / Square: the launch post'] },
        },
        {
          type: 'design',
          output: {
            type: 'design',
            frames: [{ name: 'X / Square' }, { name: 'Landing Page / Desktop' }, 7],
          },
        },
        { type: 'design', output: null },
        { type: 'copy', output: { type: 'copy', frames: ['Not a design'] } },
      ]),
    ).toEqual(['X / Square', 'LinkedIn / Square', 'Landing Page / Desktop']);
  });

  it("records the file's frames, once each, with what was said of them", () => {
    const hero = { name: 'home / desktop', shows: 'The hero' };
    expect(
      framesAsMade(
        ['X / Square', 'Home / Desktop', 'X / Square', 'Landing Page / Desktop'],
        ['X / Square: the launch post', hero, 'Promo / Story: never built'],
      ),
    ).toEqual(['X / Square: the launch post', hero, 'Landing Page / Desktop']);
    expect(framesAsMade(['Home / Desktop'], undefined)).toEqual(['Home / Desktop']);
  });
});
