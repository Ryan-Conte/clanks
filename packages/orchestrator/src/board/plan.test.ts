import type { ChatRequest, Ticket, WorkflowMember } from '@clanks/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test-helpers';
import { firstBuilds, folderState, planProblems } from './plan';
import { SPEC, call, quiet, say, setup, until, who } from './test-kit';

const names = { clank: (id: string) => id, user: 'Sam' };

const member = (id: string, kind: 'maker' | 'checker', outputs: string[]): WorkflowMember =>
  ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    kind,
    stage: kind === 'maker' ? 'build' : 'qa',
    appliesTo: [],
    outputs,
    bounceTo: [],
  }) as WorkflowMember;

const crew = [
  member('prism', 'maker', ['design']),
  member('forge', 'maker', ['pr']),
  member('gauge', 'checker', []),
];

function ticket(number: number, type: string, dependsOn: Ticket[] = [], done = false): Ticket {
  return {
    id: `t${number}`,
    number,
    key: `SURF-${number}`,
    type,
    dependsOn: dependsOn.map((t) => t.id),
    doneAt: done ? new Date() : null,
  } as Ticket;
}

describe('what a plan is checked for', () => {
  it("tells a folder nothing is built in from one that's started", () => {
    const empty = tempDir();
    expect(folderState(empty)).toEqual({ unstarted: true, designed: false });
    // Notes, a licence, dotfiles and a design aren't the app.
    writeFileSync(join(empty, 'README.md'), '# Surf\n');
    writeFileSync(join(empty, 'LICENSE'), 'MIT\n');
    writeFileSync(join(empty, '.gitignore'), 'node_modules\n');
    mkdirSync(join(empty, 'design'));
    writeFileSync(join(empty, 'design', 'site.design'), '{}');
    expect(folderState(empty)).toEqual({ unstarted: true, designed: true });
    writeFileSync(join(empty, 'package.json'), '{}');
    expect(folderState(empty)).toEqual({ unstarted: false, designed: true });
    // A folder that can't be read never holds a plan up.
    expect(folderState(join(empty, 'missing'))).toEqual({ unstarted: false, designed: true });
  });

  it('finds the code tickets that would start first, through whatever they wait on', () => {
    const setup = ticket(2, 'pr');
    const design = ticket(3, 'design', [setup]);
    const catalog = ticket(4, 'pr', [design]);
    const cart = ticket(5, 'pr');
    const old = ticket(1, 'pr', [], true);
    const after = ticket(6, 'pr', [old]);
    expect(firstBuilds([old, setup, design, catalog, cart, after]).map((t) => t.key)).toEqual([
      'SURF-2',
      'SURF-5',
      'SURF-6',
    ]);
  });

  it('asks for one setup ticket before the rest on an empty folder', () => {
    const planned = [ticket(2, 'pr'), ticket(3, 'pr'), ticket(4, 'pr')];
    const empty = { unstarted: true, designed: true };
    const problems = planProblems({ planned, all: planned, crew, folder: empty, names });
    expect(problems.map((p) => [p.id, p.firm])).toEqual([['empty-folder', true]]);
    expect(problems[0]!.text).toContain('SURF-2, SURF-3 and SURF-4 would all start at once');

    // One ticket first, the rest behind it: nothing to say. Nor in a folder with an app in it.
    const first = ticket(2, 'pr');
    const chained = [first, ticket(3, 'pr', [first]), ticket(4, 'pr', [first])];
    expect(planProblems({ planned: chained, all: chained, crew, folder: empty, names })).toEqual(
      [],
    );
    const started = { unstarted: false, designed: true };
    expect(planProblems({ planned, all: planned, crew, folder: started, names })).toEqual([]);
  });

  it('asks once for a design when a designer is in the crew and nothing is designed', () => {
    const planned = [ticket(2, 'pr')];
    const bare = { unstarted: false, designed: false };
    const problems = planProblems({ planned, all: planned, crew, folder: bare, names });
    expect(problems.map((p) => [p.id, p.firm])).toEqual([['no-design', false]]);
    expect(problems[0]!.text).toContain('create a `design` ticket for Prism');

    // Not with a design ticket on the board, a design in the folder, or no designer.
    const all = [...planned, ticket(3, 'design')];
    expect(planProblems({ planned, all, crew, folder: bare, names })).toEqual([]);
    const designed = { unstarted: false, designed: true };
    expect(planProblems({ planned, all: planned, crew, folder: designed, names })).toEqual([]);
    const noDesigner = crew.filter((c) => c.id !== 'prism');
    expect(planProblems({ planned, all: planned, crew: noDesigner, folder: bare, names })).toEqual(
      [],
    );
    // A plan with no code in it has no screens to design.
    const copy = [ticket(2, 'copy')];
    const writers = [...crew, member('quill', 'maker', ['copy'])];
    expect(planProblems({ planned: copy, all: copy, crew: writers, folder: bare, names })).toEqual(
      [],
    );
  });

  it("says when nobody in the crew makes a ticket's type", () => {
    const planned = [ticket(2, 'copy'), ticket(3, 'copy'), ticket(4, 'campaign')];
    const folder = { unstarted: false, designed: true };
    const problems = planProblems({ planned, all: planned, crew, folder, names });
    expect(problems.map((p) => p.id)).toEqual(['no-maker', 'no-maker']);
    expect(problems[0]!.text).toContain(
      'Nobody in the crew makes `copy` tickets, so SURF-2 and SURF-3',
    );
  });
});

/** The scripts that take an idea to a spec waiting for the user. */
const toSpec = {
  'atlas chat': [
    [
      call('board_create_ticket', {
        title: 'Write the spec for the surf shop',
        type: 'spec',
        description: 'Goal: sell surf boards online.',
        assignee: 'scribe',
      }),
    ],
    say('Scribe is writing the spec.'),
  ],
  'scribe ticket': [
    [call('spec_write', { content: SPEC })],
    [call('submit_output', { type: 'spec', changes: 'First version.' })],
  ],
  'atlas ticket': [[call('review_pass', { summary: 'Covers browsing and checkout.' })]],
};

/** One ticket per story and nothing else: what a small model plans when left to it. */
const perStory = [
  [call('board_create_ticket', { title: 'Build the catalog', type: 'pr', stories: ['US-1'] })],
  [call('board_create_ticket', { title: 'Build checkout', type: 'pr', stories: ['US-2'] })],
  say('Two tickets are on the board.'),
];

async function approveSpec(kit: Awaited<ReturnType<typeof setup>>) {
  const { board, chat, context, project } = kit;
  chat.start('atlas', 'Build me a site that sells surf boards', null, project.id);
  await until(
    () => board.snapshot(project.id).tickets[0]?.column === 'ready' && quiet(context),
    'the spec is ready',
  );
  await board.approve(board.snapshot(project.id).tickets[0]!.id);
}

describe('a plan on an empty folder', () => {
  it('goes back to Atlas before anything starts, and starts once it can work', async () => {
    // What the board looked like each time the planner was asked, to see nothing had started.
    const seen: string[][] = [];
    // The planner's script reads the board, which is there only once the kit is.
    const late: { kit?: Awaited<ReturnType<typeof setup>> } = {};
    const planning = [
      ...perStory,
      [
        call('board_create_ticket', {
          title: 'Set up the Next.js app',
          type: 'pr',
          criteria: ['`npm run build` succeeds and the home page renders'],
        }),
        call('board_create_ticket', {
          title: 'Design the storefront',
          type: 'design',
          stories: ['US-1', 'US-2'],
        }),
      ],
      [
        call('board_link_dependency', { key: 'SURF-2', depends_on: 'SURF-4' }),
        call('board_link_dependency', { key: 'SURF-2', depends_on: 'SURF-5' }),
        call('board_link_dependency', { key: 'SURF-3', depends_on: 'SURF-2' }),
      ],
      say('Setup and the design go first, then the catalog, then checkout.'),
    ];
    const kit = await setup({
      ...toSpec,
      'atlas planning': (request: ChatRequest) => {
        const tickets = late.kit!.board.snapshot(late.kit!.project.id).tickets;
        seen.push(tickets.filter((t) => t.type !== 'spec').map((t) => `${t.key} ${t.column}`));
        return planning[request.messages.filter((m) => m.role === 'assistant').length]!;
      },
      // The crew's own runs stop at once: this test is about what starts, not what it does.
      'forge ticket': [[call('fail', { reason: 'Not in this test', tried: 'Nothing' })]],
      'prism ticket': [[call('fail', { reason: 'Not in this test', tried: 'Nothing' })]],
    });
    late.kit = kit;
    const { board, context, project, fake } = kit;
    await approveSpec(kit);
    await until(
      () =>
        board
          .snapshot(project.id)
          .tickets.some((t) => t.runs.some((r) => r.role === 'maker' && t.type !== 'spec')) &&
        quiet(context),
      'the plan was made and work began',
    );

    // Atlas was told what the folder and the crew mean for the plan, up front.
    const brief = fake.requests.find((r) => who(r) === 'atlas planning')!.messages[0]!.content;
    expect(brief).toContain(
      "The project's folder has no code yet. If anything in this plan is built in code, one ticket sets the app up first",
    );
    expect(brief).toContain('Prism is in the crew and nothing is designed yet.');
    expect(brief).toContain("Nothing starts until you've finished planning.");

    // Its first plan came back with both problems, and nothing started while it was fixed.
    const plan = context.chat.list().find((c) => c.role === 'planner')!;
    const sentBack = context.chat
      .get(plan.id)
      .messages.filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(sentBack).toHaveLength(2);
    expect(sentBack[1]).toContain("The plan can't run as it stands, so nothing has started.");
    expect(sentBack[1]).toContain("1. The project's folder has no code yet");
    expect(sentBack[1]).toContain('SURF-2 and SURF-3 would all start at once');
    expect(sentBack[1]).toContain('2. Prism is in the crew and nothing is designed yet');
    expect(seen.flat().every((line) => line.endsWith('backlog'))).toBe(true);
    expect(seen.at(-1)).toEqual([
      'SURF-2 backlog',
      'SURF-3 backlog',
      'SURF-4 backlog',
      'SURF-5 backlog',
    ]);

    // Then only what waits on nothing began: setup and the design, not the catalog or checkout.
    const tickets = board.snapshot(project.id).tickets;
    const began = (key: string) => tickets.find((t) => t.key === key)!.runs.length > 0;
    expect(['SURF-2', 'SURF-3', 'SURF-4', 'SURF-5'].map(began)).toEqual([false, false, true, true]);
    const events = board.snapshot(project.id).events.map((e) => `${e.actor} › ${e.text}`);
    expect(events).toContain('atlas › spec v1: created 4 tickets');
    // Forge was told its copy starts empty.
    const forge = fake.requests.find((r) => who(r) === 'forge ticket')!.messages[0]!.content;
    expect(forge).toContain("The project's folder has no code yet, so your copy starts empty");
  }, 60_000);

  it('puts the tickets in order itself when the planner never does', async () => {
    const kit = await setup(
      {
        ...toSpec,
        'atlas planning': [
          ...perStory,
          say('The two tickets cover both stories.'),
          say('They are both on the board.'),
        ],
        'forge ticket': [[call('fail', { reason: 'Not in this test', tried: 'Nothing' })]],
      },
      // No designer, so the only thing wrong with the plan is the empty folder.
      { crew: ['scribe', 'forge', 'gauge'] },
    );
    const { board, context, project } = kit;
    await approveSpec(kit);
    await until(
      () =>
        board.snapshot(project.id).tickets.some((t) => t.type === 'pr' && t.runs.length > 0) &&
        quiet(context),
      'the plan was made and work began',
    );
    // Asked twice, then put in order: the catalog first, checkout behind it.
    const plan = context.chat.list().find((c) => c.role === 'planner')!;
    expect(context.chat.get(plan.id).messages.filter((m) => m.role === 'user')).toHaveLength(3);
    const tickets = board.snapshot(project.id).tickets;
    const catalog = tickets.find((t) => t.key === 'SURF-2')!;
    const checkout = tickets.find((t) => t.key === 'SURF-3')!;
    expect(checkout.dependsOn).toEqual([catalog.id]);
    expect([catalog.runs.length > 0, checkout.runs.length > 0]).toEqual([true, false]);
    expect(board.snapshot(project.id).events.map((e) => `${e.actor} › ${e.text}`)).toContain(
      "app › put SURF-3 in order behind SURF-2: the folder has no code yet, so they can't start together",
    );
  }, 60_000);
});
