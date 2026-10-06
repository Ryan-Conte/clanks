import {
  type ChatEvent,
  type ChatRequest,
  type ModelRecord,
  type ToolPart,
  columnOf,
} from '@clanks/core';
import { createFakeProvider } from '@clanks/providers';
import { git } from '@clanks/workspace';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteModelRepository } from '../store/models';
import { startTestOrchestrator, tempDir } from '../test-helpers';

const MODEL = 'tiny:1b';

const model: ModelRecord = {
  id: MODEL,
  source: 'catalog',
  title: MODEL,
  repo: 'test/repo',
  revision: 'a'.repeat(40),
  quant: 'Q4_0',
  params: '1B',
  license: 'mit',
  tags: ['general'],
  capabilities: { tools: true, vision: false, reasoning: false },
  files: [{ role: 'model', path: 'm.gguf', sha256: 'b'.repeat(64), size: 1000 }],
  facts: {
    architecture: 'llama',
    blockCount: 2,
    contextLength: 32_768,
    kvPerToken: 10,
    swaKvPerToken: 0,
    slidingWindow: 0,
    parameterCount: null,
  },
  size: 1000,
  keepLoaded: false,
  pulledAt: new Date(),
};

const SPEC = `# Surf shop: spec

## Overview
A website that sells surf boards in Australia.

## Stories

### US-1 Browse boards
As a shopper, I want to see every board with its price, so that I can pick one.

Acceptance criteria
- AC-1.1: Given the shop, when I open it, then I see every board with its price.
- AC-1.2: Given a sold-out board, when I see it, then it says sold out.

### US-2 Checkout
As a shopper, I want to pay by card, so that I can buy a board.

Acceptance criteria
- AC-2.1: Given a cart, when I pay with a valid card, then I see an order number.
`;

const call = (name: string, args: object): ChatEvent => ({
  type: 'tool_call',
  call: {
    id: `${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: JSON.stringify(args),
  },
});
const say = (text: string): ChatEvent[] => [{ type: 'text', text }];

/** Which conversation a request is from, by what its system prompt says. */
function who(request: ChatRequest): string {
  const system = request.messages[0]!.content;
  const name = /^You are (\w+)/.exec(system)?.[1] ?? '?';
  const mode = /Mode: (\w+)/.exec(system)?.[1] ?? '?';
  return `${name.toLowerCase()} ${mode}`;
}

type Script = ChatEvent[][] | ((request: ChatRequest) => ChatEvent[]);

/**
 * Replays a script per conversation: each reply is picked by who's asking and how many times the
 * model has spoken in that conversation already, or by a function of the request.
 */
function scripted(scripts: Record<string, Script>) {
  return (request: ChatRequest): ChatEvent[] => {
    const key = who(request);
    const script = scripts[key];
    if (typeof script === 'function') return script(request);
    const turn = request.messages.filter((m) => m.role === 'assistant').length;
    const reply = script?.[turn];
    if (!reply) throw new Error(`No reply scripted for ${key}, turn ${turn}`);
    return reply;
  };
}

async function repository(): Promise<string> {
  const root = join(tempDir(), 'surf');
  mkdirSync(root);
  const env = {
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await git(['init', '--quiet', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# Surf shop\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '--quiet', '-m', 'Start'], { cwd: root, env });
  return root;
}

async function setup(scripts: Record<string, Script>) {
  const orchestrator = startTestOrchestrator();
  const { context } = orchestrator;
  sqliteModelRepository(context.store.db).putModel(model);
  const blobs = join(orchestrator.paths.models, 'blobs');
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, `sha256-${'b'.repeat(64)}`), 'gguf');
  context.settings.update({
    crewModel: MODEL,
    profile: { name: 'Sam', timeZone: 'UTC', language: '', preferences: '' },
  });
  const fake = createFakeProvider({ id: 'builtin', replies: scripted(scripts) });
  context.providers.replace(fake);
  const project = await context.projects.create({
    name: 'Surf shop',
    brief: 'A website that sells surf boards.',
    key: 'SURF',
    workspace: { kind: 'folder', path: await repository() },
    crew: ['scribe', 'prism', 'forge', 'gauge'],
    model: null,
    models: {},
  });
  return { context, fake, project, board: context.board, chat: context.chat };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting until ${what}`);
}

const quiet = (context: Awaited<ReturnType<typeof setup>>['context']) =>
  context.chat.list().every((c) => !c.replying);

describe('the spec flow', () => {
  it('turns an idea into an approved spec and a board of tickets with dependencies', async () => {
    const { context, fake, project, board, chat } = await setup({
      'atlas chat': [
        [
          call('board_create_ticket', {
            title: 'Write the spec for the surf shop',
            type: 'spec',
            description:
              'Goal: sell surf boards online in Australia. Shoppers browse and pay by card.',
            assignee: 'scribe',
          }),
        ],
        say('Scribe is writing the spec on SURF-1. You approve it when Atlas has signed it off.'),
      ],
      'scribe ticket': [
        [call('spec_read', {})],
        [call('spec_write', { content: SPEC })],
        [
          call('submit_output', {
            type: 'spec',
            changes: 'First version: US-1 and US-2.',
            assumptions: ['Card payments only'],
            notes: 'No shipping yet.',
          }),
        ],
      ],
      'atlas ticket': [
        [call('spec_read', {})],
        [call('review_pass', { summary: 'Covers browsing and checkout, all testable.' })],
      ],
      'atlas planning': [
        [
          call('board_create_ticket', {
            title: 'Set up the Next.js app',
            type: 'pr',
            description: 'Scaffold the site.',
            criteria: ['`npm run build` succeeds and the home page renders'],
            assignee: 'forge',
          }),
          call('board_create_ticket', {
            title: 'Design the storefront',
            type: 'design',
            stories: ['US-1'],
            assignee: 'prism',
          }),
        ],
        [
          call('board_create_ticket', {
            title: 'Build the storefront',
            type: 'pr',
            stories: ['US-1'],
            assignee: null,
            depends_on: ['SURF-2', 'SURF-3'],
          }),
        ],
        [
          call('board_create_ticket', {
            title: 'Add checkout',
            type: 'pr',
            stories: ['us-2'],
            depends_on: ['SURF-4'],
          }),
        ],
        say('Four tickets are on the board: setup and design can start together.'),
      ],
    });

    const { conversation } = chat.start(
      'atlas',
      'Build me a surfing website that sells surf boards',
      null,
      project.id,
    );
    expect(conversation).toMatchObject({
      projectId: project.id,
      folder: project.folder,
      role: null,
    });

    // Scribe writes, Atlas signs off, and it comes to Sam.
    await until(
      () => board.snapshot(project.id).tickets[0]?.column === 'ready',
      'the spec is ready',
    );
    await until(() => quiet(context), 'the runs are over');
    let snapshot = board.snapshot(project.id);
    const spec = snapshot.tickets[0]!;
    expect(spec).toMatchObject({
      key: 'SURF-1',
      type: 'spec',
      assignee: 'scribe',
      origin: 'chat',
      createdBy: 'atlas',
      conversationId: conversation.id,
      specVersion: 1,
      state: 'idle',
    });
    expect(spec.route.map((s) => s.clankId)).toEqual(['scribe', 'atlas']);
    expect(spec.output).toMatchObject({ type: 'spec', changes: 'First version: US-1 and US-2.' });
    expect(spec.reviews).toMatchObject([
      { clankId: 'atlas', summary: 'Covers browsing and checkout, all testable.' },
    ]);
    expect(snapshot.specs).toMatchObject([{ version: 1, status: 'signed_off', stories: 2 }]);
    expect(snapshot.needsYou).toMatchObject([
      { key: 'SURF-1', kind: 'ready', text: 'Approve spec v1' },
    ]);
    expect(spec.runs.map((r) => [r.clankId, r.role])).toEqual([
      ['scribe', 'maker'],
      ['atlas', 'checker'],
    ]);

    // Scribe worked on a branch named for the ticket, and was told what it was working on.
    const scribeRun = spec.runs[0]!.conversationId;
    expect(context.workspace.run(scribeRun)?.branch).toBe('clanks/SURF-1');
    const scribeAsk = fake.requests.find((r) => who(r) === 'scribe ticket')!;
    const system = scribeAsk.messages[0]!.content;
    expect(system).toContain('## Project context');
    expect(system).toContain('Project: Surf shop. A website that sells surf boards.');
    expect(system).toContain('You are working SURF-1 on your own, as its maker.');
    expect(system).toContain('Goal: sell surf boards online in Australia.');
    expect(system).toContain('**Scribe (you)** → Atlas → Sam');
    expect(scribeAsk.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining(['spec_write', 'submit_output', 'ask_user', 'fail']),
    );
    expect(scribeAsk.tools?.map((t) => t.name)).not.toContain('review_pass');
    expect(scribeAsk.messages[1]).toEqual({
      role: 'user',
      content: 'Start on SURF-1: Write the spec for the surf shop.',
    });
    const atlasAsk = fake.requests.find((r) => who(r) === 'atlas ticket')!;
    expect(atlasAsk.tools?.map((t) => t.name)).toContain('review_pass');
    expect(atlasAsk.tools?.map((t) => t.name)).not.toContain('submit_output');
    const read = fake.requests.filter((r) => who(r) === 'atlas ticket')[1]!.messages.at(-1)!;
    expect(read.content).toContain('# Spec v1 (draft, with Atlas for sign-off)');

    // The app's briefs are marked as the app's in the run.
    const runMessages = chat.get(scribeRun).messages;
    expect(runMessages[0]).toMatchObject({ role: 'user', author: 'app' });

    // Sam approves, and Atlas plans the board from it.
    board.approve(spec.id);
    await until(
      () => context.chat.list().some((c) => c.role === 'planner') && quiet(context),
      'Atlas has planned',
    );
    snapshot = board.snapshot(project.id);
    expect(snapshot.specs).toMatchObject([{ version: 1, status: 'approved' }]);
    expect(
      snapshot.tickets.map((t) => [t.key, t.type, t.assignee, t.column, t.origin, t.specVersion]),
    ).toEqual([
      ['SURF-1', 'spec', 'scribe', 'done', 'chat', 1],
      ['SURF-2', 'pr', 'forge', 'backlog', 'spec', 1],
      ['SURF-3', 'design', 'prism', 'backlog', 'spec', 1],
      ['SURF-4', 'pr', null, 'backlog', 'spec', 1],
      ['SURF-5', 'pr', null, 'backlog', 'spec', 1],
    ]);
    const byKey = (key: string) => snapshot.tickets.find((t) => t.key === key)!;
    expect(
      byKey('SURF-4').dependsOn.map((id) => snapshot.tickets.find((t) => t.id === id)!.key),
    ).toEqual(['SURF-2', 'SURF-3']);
    expect(byKey('SURF-2').route.map((s) => s.clankId)).toEqual(['forge', 'gauge', 'atlas']);
    expect(byKey('SURF-3').route.map((s) => s.clankId)).toEqual(['prism', 'atlas']);
    // Criteria come from the stories unless the ticket gives its own.
    expect(byKey('SURF-4').criteria.map((c) => c.id)).toEqual(['AC-1.1', 'AC-1.2']);
    expect(byKey('SURF-5').criteria.map((c) => c.id)).toEqual(['AC-2.1']);
    expect(byKey('SURF-5').stories).toEqual(['US-2']);
    expect(byKey('SURF-2').criteria).toEqual([
      { id: null, text: '`npm run build` succeeds and the home page renders' },
    ]);
    expect(snapshot.needsYou).toEqual([]);

    const planAsk = fake.requests.find((r) => who(r) === 'atlas planning')!;
    expect(planAsk.messages[0]!.content).toContain('Sam approved spec v1 of Surf shop');
    expect(planAsk.messages[0]!.content).toContain(
      'Stories in v1: US-1 Browse boards; US-2 Checkout.',
    );

    // The feed tells the story.
    expect(snapshot.events.map((e) => `${e.actor} › ${e.text}`)).toEqual([
      'atlas › created SURF-1: Write the spec for the surf shop for Scribe',
      'scribe › started SURF-1',
      'scribe › submitted SURF-1',
      'atlas › signed off SURF-1, ready for you',
      'user › approved spec v1 (SURF-1)',
      'atlas › created SURF-2: Set up the Next.js app for Forge',
      'atlas › created SURF-3: Design the storefront for Prism',
      'atlas › created SURF-4: Build the storefront',
      'atlas › created SURF-5: Add checkout',
      'atlas › spec v1: created 4 tickets',
    ]);
    expect(context.board.summaries()[0]).toMatchObject({
      name: 'Surf shop',
      counts: { backlog: 4, build: 0, review: 0, ready: 0, done: 1 },
      needsYou: 0,
      working: 0,
    });
  }, 30_000);

  it('keeps a spec ticket whose brief has draft stories, rather than refusing it', async () => {
    // What gemma4:26b did: it wrote its own draft stories into `stories`, before any spec existed.
    const { context, project, board, chat } = await setup({
      'atlas chat': [
        [
          call('board_create_ticket', {
            title: 'Create the spec',
            type: 'spec',
            description: 'Goal: a minimalist surf shop.',
            stories: [
              'US-1: As a shopper, I want to browse a catalog of surf products.',
              'US-2: As a shopper, I want to add items to a cart.',
            ],
          }),
          call('board_create_ticket', {
            title: 'Set up the app',
            type: 'pr',
            stories: ['US-9'],
            criteria: ['It builds'],
          }),
          call('board_create_ticket', { title: 'Build it', type: 'pr', assignee: 'scribe' }),
        ],
        say('Scribe is writing the spec on SURF-1.'),
      ],
      'scribe ticket': [
        [call('spec_write', { content: SPEC })],
        [call('submit_output', { type: 'spec' })],
      ],
      'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
    });
    const { conversation } = chat.start('atlas', 'A surf shop, minimalist.', null, project.id);
    await until(
      () => board.tickets(project.id).some((t) => columnOf(t) === 'ready'),
      'the spec is written',
    );
    await until(() => quiet(context), 'the runs are over');

    const results = chat
      .get(conversation.id)
      .messages[1]!.parts.filter((p): p is ToolPart => p.type === 'tool')
      .map((p) => [p.status, p.result]);
    expect(results[0]![0]).toBe('done');
    expect(results[0]![1]).toContain('Created SURF-1: Create the spec.');
    expect(results[0]![1]).toContain('the ones you gave are in its description to start from');
    expect(results[0]![1]).not.toContain('no acceptance criteria');
    expect(results[1]![0]).toBe('done');
    expect(results[1]![1]).toContain(
      "There's no spec with stories yet, so it doesn't reference US-9.",
    );
    // A call that does fail says plainly that nothing happened.
    expect(results[2]).toEqual([
      'failed',
      "No ticket was made. Scribe doesn't make pr tickets. Forge (forge) does, or leave it open.",
    ]);

    const [spec, setup_] = board.tickets(project.id);
    expect(spec).toMatchObject({ key: 'SURF-1', stories: [], assignee: 'scribe' });
    expect(spec!.description).toBe(
      'Goal: a minimalist surf shop.\n\nStories to start from:\n- US-1: As a shopper, I want to browse a catalog of surf products.\n- US-2: As a shopper, I want to add items to a cart.',
    );
    expect(setup_).toMatchObject({ key: 'SURF-2', stories: [] });
  }, 30_000);

  it('sends work back with reasons, and reminds a run to hand the ticket on', async () => {
    const { context, fake, project, board } = await setup({
      'scribe ticket': [
        [call('spec_write', { content: SPEC.replace(/- AC-2\.1.*\n/, '') })],
        [call('submit_output', { type: 'spec' })],
        say("I've written it."),
        [call('spec_write', { content: SPEC })],
        [call('submit_output', { type: 'spec' })],
        [call('spec_write', { content: `${SPEC}- AC-2.2: Declined cards keep the cart.\n` })],
        [call('submit_output', { type: 'spec' })],
        [call('spec_write', { content: `${SPEC}- AC-2.2: A declined card keeps the cart.\n` })],
        [call('submit_output', { type: 'spec' })],
      ],
      'atlas ticket': [
        [
          call('ticket_bounce', {
            to: 'Scribe',
            reason: 'Checkout misses declined cards',
            issues: ['Add a criterion for a declined card'],
          }),
        ],
        [call('review_pass', { summary: 'Good now.' })],
        [call('review_pass', { summary: 'Still good.' })],
      ],
    });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Write the spec',
      type: 'spec',
      description: 'A surf shop.',
      criteria: [],
      stories: [],
      assignee: 'scribe',
    });
    expect(ticket.state).toBe('working');

    // The first hand-in is refused: a story has no criteria.
    await until(() => fake.requests.length > 3, 'Scribe hands in');
    const refused = fake.requests.filter((r) => who(r) === 'scribe ticket')[2]!;
    expect(refused.messages.at(-1)!.content).toContain('US-2 has no acceptance criteria');

    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it comes back signed off');
    await until(() => quiet(context), 'the runs are over');

    const scribeRun = context.chat
      .list()
      .find((c) => c.ticketId === ticket.id && c.clankId === 'scribe')!;
    const messages = context.chat.get(scribeRun.id).messages;
    // The plain reply got a reminder, and the bounce came to Scribe as the app's message.
    const notes = messages.flatMap((m) => m.parts).filter((p) => p.type === 'note');
    expect(notes.map((n) => n.text)).toEqual([
      'Reminded Scribe to end the run by handing the ticket on.',
    ]);
    expect(messages.filter((m) => m.author === 'app').map((m) => m.content)).toEqual([
      'Start on SURF-1: Write the spec.',
      'Atlas sent SURF-1 back to you: Checkout misses declined cards\n\n1. Add a criterion for a declined card\n\nFix it, then hand it in again.',
    ]);
    const snapshot = board.snapshot(project.id);
    expect(snapshot.tickets[0]).toMatchObject({ bounces: 1, column: 'ready' });
    expect(snapshot.tickets[0]!.bounceHistory).toMatchObject([
      { from: 'atlas', to: 'scribe', reason: 'Checkout misses declined cards' },
    ]);
    expect(snapshot.events.map((e) => e.text)).toContain(
      'bounced SURF-1 to Scribe: Checkout misses declined cards',
    );

    // Sam asks for a change, which goes back to Scribe without counting as a bounce.
    board.requestChanges(ticket.id, 'Add a criterion about a declined card keeping the cart');
    expect(board.ticket(ticket.id)).toMatchObject({ bounces: 1, step: 0, state: 'working' });
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it comes back again');
    await until(() => quiet(context), 'the runs are over');
    expect(board.ticket(ticket.id).bounces).toBe(1);
    expect(
      context.chat
        .get(scribeRun.id)
        .messages.filter((m) => m.author === 'app')
        .at(-1)!.content,
    ).toBe(
      'Sam asked for changes on SURF-1:\n\nAdd a criterion about a declined card keeping the cart\n\nMake them, then hand it in again.',
    );
  }, 30_000);

  it('pauses on a question, and carries on with the answer', async () => {
    const { context, project, board, chat } = await setup({
      'scribe ticket': [
        [
          call('ask_user', {
            question: 'Do you ship outside Australia?',
            options: ['Australia only', 'Worldwide'],
            recommendation: 'Australia only',
          }),
        ],
        [call('spec_write', { content: SPEC })],
        [call('submit_output', { type: 'spec' })],
      ],
      'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
    });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Write the spec',
      type: 'spec',
      description: '',
      criteria: [],
      stories: [],
      assignee: 'scribe',
    });
    await until(() => board.ticket(ticket.id).state === 'question', 'Scribe asks');
    await until(() => quiet(context), 'the run pauses');
    const snapshot = board.snapshot(project.id);
    expect(snapshot.tickets[0]!.column).toBe('build');
    expect(snapshot.needsYou).toMatchObject([
      { kind: 'question', text: 'Do you ship outside Australia?' },
    ]);
    const run = snapshot.needsYou[0]!.conversationId!;
    const ask = chat.get(run).messages[1]!.parts.find((p): p is ToolPart => p.type === 'tool')!;
    expect(ask).toMatchObject({ name: 'ask_user', status: 'done' });

    chat.send(run, 'Australia only.');
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it goes on to sign-off');
    await until(() => quiet(context), 'the runs are over');
  }, 30_000);

  it('stops a run that never hands the ticket on, and retries it', async () => {
    const { context, project, board } = await setup({
      'scribe ticket': (request) => {
        const retried = request.messages.some(
          (m) => m.role === 'user' && m.content.includes('Write it now'),
        );
        if (!retried) return say('Thinking about it.');
        return request.messages.at(-1)!.role === 'tool'
          ? [call('submit_output', { type: 'spec' })]
          : [call('spec_write', { content: SPEC })];
      },
      'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
    });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Write the spec',
      type: 'spec',
      description: '',
      criteria: [],
      stories: [],
      assignee: null,
    });
    await until(() => board.ticket(ticket.id).state === 'failed', 'the run gives up');
    expect(board.ticket(ticket.id)).toMatchObject({
      assignee: 'scribe',
      reason: 'Scribe stopped without handing the ticket on.',
    });
    expect(board.snapshot(project.id).needsYou).toMatchObject([{ kind: 'failed' }]);
    await until(() => quiet(context), 'the run is over');

    board.retry(ticket.id, 'Write it now, please.');
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it carries on');
    await until(() => quiet(context), 'the runs are over');
  }, 30_000);
});

describe('the board', () => {
  it('takes cards from the user, and keeps to the workflow', async () => {
    const { project, board, context } = await setup({});
    const add = (title: string, type: 'pr' | 'design', assignee: string | null = null) =>
      board.addTicket({
        projectId: project.id,
        title,
        type,
        description: '',
        criteria: ['It works'],
        stories: [],
        assignee,
      });
    const a = add('Set up the app', 'pr', 'forge');
    const b = add('Design the shop', 'design');
    const c = add('Build the shop', 'pr');
    expect([a.key, b.key, c.key]).toEqual(['SURF-1', 'SURF-2', 'SURF-3']);
    expect(c.route).toEqual([
      { clankId: null, role: 'maker' },
      { clankId: 'gauge', role: 'checker' },
      { clankId: 'atlas', role: 'checker' },
    ]);
    expect(a.criteria).toEqual([{ id: null, text: 'It works' }]);

    // Only a clank that makes the type can have it.
    expect(() => board.assignTicket(c.id, 'scribe')).toThrow("Scribe doesn't make pr tickets");
    expect(board.assignTicket(c.id, 'forge').assignee).toBe('forge');
    add('Add checkout', 'pr');
    expect(() =>
      board.addTicket({
        projectId: project.id,
        title: 'Copy',
        type: 'copy',
        description: '',
        criteria: [],
        stories: [],
        assignee: null,
      }),
    ).toThrow("Nobody in this project's crew makes copy tickets");
    // Dependencies can't loop.
    board.linkTickets(c.id, a.id, false);
    board.linkTickets(c.id, b.id, false);
    expect(() => board.linkTickets(a.id, c.id, false)).toThrow(
      'That would make a loop: SURF-3 already waits on SURF-1',
    );
    expect(() => board.linkTickets(a.id, a.id, false)).toThrow("can't wait on itself");

    // The backlog is the user's to order; nothing is approved by a drag.
    board.reorder(c.id, a.id);
    expect(board.tickets(project.id).map((t) => t.key)).toEqual([
      'SURF-3',
      'SURF-1',
      'SURF-2',
      'SURF-4',
    ]);
    board.reorder(c.id, null);
    expect(board.tickets(project.id).at(-1)!.key).toBe('SURF-3');
    expect(() => board.move(a.id, 'done')).toThrow(/Nothing is approved by a drag/);
    expect(() => board.approve(a.id)).toThrow("SURF-1 isn't ready for you yet");

    await board.removeTicket(b.id);
    expect(board.ticket(c.id).dependsOn).toEqual([a.id]);
    const feed = board.snapshot(project.id).events.map((e) => `${e.actor} › ${e.text}`);
    expect(feed).toContain('user › SURF-3 waits on SURF-1');
    expect(feed).toContain('user › moved SURF-3 to the top');
    expect(feed).toContain('user › deleted SURF-2: Design the shop');

    // A project's crew is its own: Atlas always stays in it, and only its crew chats there.
    expect(() => context.projects.setMember(project.id, 'atlas', false)).toThrow(/stays/);
    expect(() => context.chat.start('quill', 'Hello', null, project.id)).toThrow(
      "Quill isn't in Surf shop's crew",
    );
    context.projects.setMember(project.id, 'quill', true);
    expect(context.projects.members(project.id).map((m) => m.clankId)).toContain('quill');
  });

  it('gives a chat in a project the board, and a model of its own', async () => {
    const { context, fake, project, chat } = await setup({
      'atlas chat': [[call('board_list', {})], say('The board is empty.')],
      'forge chat': [say('Hello.')],
    });
    context.projects.update(project.id, { model: { provider: 'builtin', model: MODEL } });
    const { conversation } = chat.start('atlas', "What's the status?", null, project.id);
    await until(() => quiet(context), 'Atlas answers');
    const result = chat
      .get(conversation.id)
      .messages[1]!.parts.find((p): p is ToolPart => p.type === 'tool')!;
    expect(result.result).toBe('The board for Surf shop is empty.');
    const system = fake.requests[0]!.messages[0]!.content;
    expect(system).toContain(
      'Mode: chat. You are talking with Sam directly, in the project Surf shop.',
    );
    expect(system).toContain("Board and spec tools work on this project's board");
    expect(fake.requests[0]!.tools?.map((t) => t.name)).not.toContain('submit_output');

    // Forge may file a ticket, but only as a proposal for Atlas.
    expect(fake.requests[0]!.tools?.map((t) => t.name)).toContain('board_create_ticket');
    chat.start('forge', 'Hi', null, project.id);
    await until(() => quiet(context), 'Forge answers');
    const forgeTools = fake.requests.at(-1)!.tools?.map((t) => t.name) ?? [];
    expect(forgeTools).toContain('board_create_ticket');
    expect(forgeTools).not.toContain('board_list');

    // A project's chats and runs go with it; its folder stays.
    await context.board.deleteProject(project.id);
    expect(context.chat.list()).toEqual([]);
    expect(context.projects.list()).toEqual([]);
  }, 30_000);
});
