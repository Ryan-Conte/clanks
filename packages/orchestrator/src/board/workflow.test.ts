import { type ChatEvent, type ToolPart, columnOf } from '@clanks/core';
import { git } from '@clanks/workspace';
import { eq } from 'drizzle-orm';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPort } from '../chat/service';
import { project as projectTable } from '../store/schema';
import { tempDir } from '../test-helpers';
import { call, gitEnv, quiet, repository, say, setup, until, who } from './test-kit';

const usage = (tokens: number): ChatEvent => ({
  type: 'usage',
  usage: {
    promptTokens: tokens,
    completionTokens: 0,
    tokensPerSecond: null,
    promptTokensPerSecond: null,
    durationMs: 1000,
  },
});

/** What a tool call in a run got back, by the tool's name: the last such call. */
function result(
  chat: Awaited<ReturnType<typeof setup>>['chat'],
  conversationId: string,
  tool: string,
): string | null {
  const parts = chat
    .get(conversationId)
    .messages.flatMap((m) => m.parts)
    .filter((p): p is ToolPart => p.type === 'tool' && p.name === tool);
  return parts.at(-1)?.result ?? null;
}

describe('the workflow engine', () => {
  it('builds a pull request: Forge makes it, Gauge bounces a bug, Atlas signs off, and approving merges it', async () => {
    const { context, project, folder, board, chat } = await setup(
      {
        'forge ticket': [
          [
            call('post_progress', {
              message: 'Adding the board list.',
              steps: [{ title: 'Write it' }],
            }),
          ],
          [call('fs_write', { path: 'boards.txt', content: 'Fish 6\n' })],
          [
            call('context_write', {
              kind: 'convention',
              title: 'Board names are title case',
              why: 'The catalog shows them as written',
            }),
          ],
          [
            call('memory_write', {
              body: 'Kept the list in a text file: it is the smallest thing that meets AC-1.',
            }),
          ],
          [call('submit_output', { type: 'pr', title: 'List boards', summary: 'Adds boards.txt' })],
          // Gauge sends it back: the price is missing.
          [call('fs_write', { path: 'boards.txt', content: 'Fish 6 $500\n' })],
          [
            call('submit_output', {
              type: 'pr',
              title: 'List boards',
              notes: '1. Added the price.',
            }),
          ],
        ],
        'gauge ticket': [
          [call('fs_read', { path: 'boards.txt' })],
          [
            call('ticket_bounce', {
              to: 'forge',
              reason: 'AC-1 failed: no price',
              issues: ['Show each board with its price'],
            }),
          ],
          [call('fs_read', { path: 'boards.txt' })],
          [call('review_pass', { summary: 'Boards show with prices.' })],
        ],
        'atlas ticket': [
          [call('memory_search', { query: 'why a text file', clank: 'forge' })],
          [call('review_pass', { summary: 'Fits the spec.' })],
        ],
      },
      { crew: ['forge', 'gauge'] },
    );

    const ticket = board.addTicket({
      projectId: project.id,
      title: 'List the boards',
      type: 'pr',
      description: 'A list of every board with its price.',
      criteria: ['AC-1: Every board shows with its price'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await until(() => quiet(context), 'the runs are over');

    let card = board.snapshot(project.id).tickets[0]!;
    expect(card).toMatchObject({ bounces: 1, state: 'idle', column: 'ready' });
    // Gauge checked twice. The second time it was told the work had changed since it looked.
    const gauge = card.runs.find((r) => r.clankId === 'gauge')!;
    const asked = chat
      .get(gauge.conversationId)
      .messages.filter((m) => m.role === 'user')
      .map((m) => m.content);
    expect(asked).toEqual([
      'Forge handed in SURF-1. Check it against its criteria.',
      'Forge handed in SURF-1. Check it against its criteria. It has changed since you last looked, so what you found then may not hold: read it again before you decide.',
    ]);
    expect(card.route.map((s) => s.clankId)).toEqual(['forge', 'gauge', 'atlas']);
    expect(card.delivery).toMatchObject({
      branch: 'clanks/SURF-1',
      base: 'main',
      changed: true,
      merged: null,
      pr: null,
    });
    // What Forge left uncommitted went on its branch, as Forge's.
    expect(await git(['log', '-1', '--format=%an %s', 'clanks/SURF-1'], { cwd: folder })).toBe(
      'Forge (clanks) Work left by Forge on SURF-1',
    );
    // Gauge checked the first hand-in, then followed Forge's branch to the fix.
    const gaugeRun = card.runs.find((r) => r.clankId === 'gauge')!.conversationId;
    const reads = chat
      .get(gaugeRun)
      .messages.flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === 'tool' && p.name === 'fs_read')
      .map((p) => p.result ?? '');
    expect(reads[0]).toContain('Fish 6');
    expect(reads[0]).not.toContain('$500');
    expect(reads[1]).toContain('Fish 6 $500');
    // Watching Gauge, its diff shows what it's checking: Forge's change, from the branch's base.
    const gaugeState = await context.workspace.state(gaugeRun);
    expect(gaugeState.checkpoints[0]!.label).toMatch(/^Branched from [0-9a-f]{7}$/);
    const checked = await context.workspace.files(gaugeRun, gaugeState.checkpoints[0]!.id, 'live');
    expect(checked.map((f) => f.path)).toEqual(['boards.txt']);
    // Atlas could read why Forge did what it did, while signing it off.
    const atlasRun = card.runs.find((r) => r.clankId === 'atlas')!.conversationId;
    expect(result(chat, atlasRun, 'memory_search')).toContain('smallest thing that meets AC-1');
    // Its note is provisional until the ticket is approved, and Atlas saw it at sign-off.
    expect(context.context.notes(project.id)).toMatchObject([
      { title: 'Board names are title case', status: 'provisional', author: 'forge' },
    ]);

    // Approving merges the branch into main, in the user's own checkout.
    expect(existsSync(join(folder, 'boards.txt'))).toBe(false);
    await board.approve(ticket.id);
    card = board.snapshot(project.id).tickets[0]!;
    expect(card).toMatchObject({ column: 'done', outcome: 'approved' });
    expect(card.delivery?.merged).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(folder, 'boards.txt'), 'utf8')).toBe('Fish 6 $500\n');
    expect(await git(['log', '-1', '--format=%s'], { cwd: folder })).toBe(
      'Merge SURF-1: List the boards',
    );
    expect(context.context.notes(project.id)[0]!.status).toBe('active');
    // Each clank remembers its runs.
    expect(context.context.memories(project.id, 'gauge').map((m) => m.kind)).toContain(
      'run_summary',
    );

    expect(board.snapshot(project.id).events.map((e) => `${e.actor} › ${e.text}`)).toEqual([
      'user › created SURF-1: List the boards for Forge',
      'forge › started SURF-1',
      'forge › noted for the crew: Board names are title case',
      'forge › submitted SURF-1',
      'gauge › bounced SURF-1 to Forge: AC-1 failed: no price',
      'forge › submitted SURF-1',
      'gauge › passed SURF-1',
      'atlas › signed off SURF-1, ready for you',
      'user › merged clanks/SURF-1 into main (SURF-1)',
      'user › approved SURF-1',
    ]);
  }, 60_000);

  it('runs Forge on two tickets at once, and queues the next for a free slot', async () => {
    const { context, project, board } = await setup(
      {
        'forge ticket': (request) => {
          const brief = request.messages[1]!.content;
          const file = /SURF-(\d)/.exec(brief)?.[1] ?? 'x';
          return request.messages.at(-1)!.role === 'tool'
            ? [call('submit_output', { type: 'pr', title: 'Done' })]
            : [call('fs_write', { path: `f${file}.txt`, content: `${file}\n` })];
        },
        'gauge ticket': [[call('review_pass', { summary: 'Fine.' })]],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { crew: ['forge', 'gauge'], held: true },
    );
    const add = (title: string) =>
      board.addTicket({
        projectId: project.id,
        title,
        type: 'pr',
        description: '',
        criteria: ['It exists'],
        stories: [],
        assignee: null,
      });
    const a = add('Make file one');
    const b = add('Make file two');
    const c = add('Make file three');
    // Held, nothing starts, and the cards say why.
    expect(board.ticket(a.id)).toMatchObject({ step: -1, state: 'waiting' });
    expect(board.ticket(a.id).reason).toMatch(/holding new work/);

    // Let go: the test machine's model has two slots, so two Forges start and the third waits.
    context.projects.update(project.id, { held: false });
    board.pumpAll();
    const started = [a, b, c].map((t) => board.ticket(t.id));
    expect(started.map((t) => [t.step, t.state])).toEqual([
      [0, 'working'],
      [0, 'working'],
      [-1, 'waiting'],
    ]);
    expect(started[2]!.reason).toBe('Waiting for tiny:1b: its 2 slots are busy.');
    expect(started.slice(0, 2).map((t) => t.assignee)).toEqual(['forge', 'forge']);
    const running = context.chat.list().filter((c) => c.replying && c.clankId === 'forge');
    expect(running).toHaveLength(2);

    await until(
      () => [a, b, c].every((t) => columnOf(board.ticket(t.id)) === 'ready'),
      'all three are signed off',
    );
    await until(() => quiet(context), 'the runs are over');
    // Each worked on its own branch.
    expect(board.tickets(project.id).map((t) => t.delivery?.branch)).toEqual([
      'clanks/SURF-1',
      'clanks/SURF-2',
      'clanks/SURF-3',
    ]);
  }, 60_000);

  it("won't let a check pass on a build it never ran, or one it saw fail", async () => {
    const { context, project, folder, board, chat } = await setup(
      {
        'forge ticket': [
          [call('fs_write', { path: 'boards.txt', content: 'Fish 6\n' })],
          [call('submit_output', { type: 'pr', title: 'List boards' })],
          // Sent back: the build was red all along, and now it's Forge's to fix.
          [call('fs_write', { path: 'build.js', content: 'process.exit(0);\n' })],
          [call('submit_output', { type: 'pr', title: 'List boards', notes: 'Fixed the build.' })],
        ],
        'gauge ticket': [
          [call('review_pass', { summary: 'The file is there.' })],
          [call('shell_exec', { command: 'npm run build' })],
          [call('review_pass', { summary: 'The build was failing before this change.' })],
          [
            call('ticket_bounce', {
              to: 'forge',
              reason: 'The build fails',
              issues: ['Make `npm run build` pass'],
            }),
          ],
          [call('shell_exec', { command: 'npm run build' })],
          [call('review_pass', { summary: 'It builds, and the file is there.' })],
        ],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { crew: ['forge', 'gauge'], held: true },
    );
    // A project with a build, which is failing before anyone touches it.
    writeFileSync(join(folder, 'package.json'), '{ "scripts": { "build": "node build.js" } }\n');
    writeFileSync(join(folder, 'build.js'), 'process.exit(1);\n');
    await git(['add', '-A'], { cwd: folder });
    await git(['commit', '--quiet', '-m', 'Add a build'], { cwd: folder, env: gitEnv });
    context.projects.update(project.id, { held: false });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'List the boards',
      type: 'pr',
      description: '',
      criteria: ['It lists them'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await until(() => quiet(context), 'the runs are over');
    const gauge = board.snapshot(project.id).tickets[0]!.runs.find((r) => r.clankId === 'gauge')!;
    const passes = chat
      .get(gauge.conversationId)
      .messages.flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === 'tool' && p.name === 'review_pass')
      .map((p) => p.result);
    expect(passes).toEqual([
      "You haven't built SURF-1 as it was handed in this time. Run the project's build (`npm run build`) and look at the result, then pass it or send it back.",
      "`npm run build` failed the last time you ran it, so SURF-1 can't pass: a pass says the build and tests are green. Send it back to its maker with ticket_bounce and what failed, even if the failure was there before this change. If nobody in the crew can fix it, call ask_user.",
      'Passed. SURF-1 goes to Atlas next. Your run ends here.',
    ]);
    expect(board.ticket(ticket.id)).toMatchObject({ bounces: 1 });
  }, 90_000);

  it('keeps a chat in a project up with it as tickets merge, until the chat changes something', async () => {
    const { context, project, folder, board, chat } = await setup(
      {
        'forge ticket': [
          [call('fs_write', { path: 'boards.txt', content: 'Fish 6\n' })],
          [call('submit_output', { type: 'pr', title: 'List boards' })],
        ],
        'gauge ticket': [[call('review_pass', { summary: 'Fine.' })]],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
        'atlas chat': [
          [call('fs_list', { path: '.' })],
          say('Only the README.'),
          [call('fs_list', { path: '.' })],
          say('The boards are there now.'),
        ],
        'forge chat': [
          [call('fs_write', { path: 'notes.txt', content: 'Mine\n' })],
          say('Noted.'),
          [call('fs_list', { path: '.' })],
          say('Still as I left it.'),
        ],
      },
      { crew: ['forge', 'gauge'] },
    );
    const listed = (id: string) =>
      chat
        .get(id)
        .messages.flatMap((m) => m.parts)
        .filter((p): p is ToolPart => p.type === 'tool' && p.name === 'fs_list')
        .map((p) => p.result ?? '');
    // Two chats start on the project as it is: Atlas only looks, Forge writes a file.
    const atlas = chat.start('atlas', 'What is in the project?', null, project.id).conversation;
    const forge = chat.start('forge', 'Keep a note', null, project.id).conversation;
    await until(() => quiet(context), 'both have answered');
    expect(listed(atlas.id)[0]).toContain('README.md');
    expect(listed(atlas.id)[0]).not.toContain('boards.txt');

    // A ticket adds a file and is merged.
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'List the boards',
      type: 'pr',
      description: '',
      criteria: ['It lists them'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await until(() => quiet(context), 'the runs are over');
    await board.approve(ticket.id);
    expect(existsSync(join(folder, 'boards.txt'))).toBe(true);

    // Atlas's chat has changed nothing, so it sees the project as it is now.
    chat.send(atlas.id, 'And now?');
    await until(() => quiet(context), 'Atlas has answered again');
    expect(listed(atlas.id)[1]).toContain('boards.txt');
    // Forge's chat has a file of its own, so its copy is left alone.
    chat.send(forge.id, 'What is there?');
    await until(() => quiet(context), 'Forge has answered again');
    expect(listed(forge.id)[0]).toContain('notes.txt');
    expect(listed(forge.id)[0]).not.toContain('boards.txt');
  }, 60_000);

  it("won't file a ticket that's on the board already, least of all the one being worked", async () => {
    const { context, project, board, chat } = await setup(
      {
        'forge ticket': [
          // A maker's first move, sometimes: to file the work it was just given.
          [call('board_create_ticket', { title: 'make the file.', type: 'pr' })],
          [call('board_create_ticket', { title: 'Make another file', type: 'pr' })],
          [call('board_create_ticket', { title: 'Make another file!', type: 'pr' })],
          [call('fail', { reason: 'Only filing', tried: 'Nothing' })],
        ],
      },
      { crew: ['forge', 'gauge'] },
    );
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Make the file',
      type: 'pr',
      description: '',
      criteria: ['It exists'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => board.ticket(ticket.id).state === 'failed', 'the run is over');
    await until(() => quiet(context), 'nothing is replying');
    const run = board.snapshot(project.id).tickets[0]!.runs[0]!;
    const filed = chat
      .get(run.conversationId)
      .messages.flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === 'tool' && p.name === 'board_create_ticket')
      .map((p) => p.result);
    expect(filed[0]).toBe(
      "No ticket was made. That's SURF-1, the ticket you're working now. Don't file it again: do its work, and hand it in with submit_output.",
    );
    expect(filed[1]).toMatch(/^Filed SURF-2 as a proposal/);
    expect(filed[2]).toBe(
      'No ticket was made. SURF-2 is that ticket already: "Make another file". Change it with board_update_ticket if it needs more, rather than filing it twice.',
    );
    expect(board.tickets(project.id).map((t) => t.key)).toEqual(['SURF-1', 'SURF-2']);
  }, 60_000);

  it('shares a model between projects, so a busy one never keeps every slot', async () => {
    // Which ticket each run was started on, in the order the model first heard of it.
    const starts: string[] = [];
    const { context, project, board } = await setup(
      {
        'forge ticket': (request) => {
          const key = /Start on (\w+-\d+)/.exec(request.messages[1]!.content)?.[1] ?? '?';
          if (request.messages.length === 2) starts.push(key);
          return request.messages.at(-1)!.role === 'tool'
            ? [call('submit_output', { type: 'pr', title: 'Done' })]
            : [call('fs_write', { path: `${key}.txt`, content: 'x\n' })];
        },
        'gauge ticket': [[call('review_pass', { summary: 'Fine.' })]],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { crew: ['forge', 'gauge'], held: true },
    );
    const side = await context.projects.create({
      name: 'Side project',
      brief: 'Something else on the same model.',
      key: 'SIDE',
      workspace: { kind: 'folder', path: await repository() },
      crew: ['forge', 'gauge'],
      model: null,
      models: {},
    });
    context.projects.update(side.id, { held: true });
    const add = (projectId: string, title: string) =>
      board.addTicket({
        projectId,
        title,
        type: 'pr',
        description: '',
        criteria: ['It exists'],
        stories: [],
        assignee: null,
      });
    // Four tickets in the busy project and one in the other, on a model with two slots.
    const busy = ['one', 'two', 'three', 'four'].map((n) => add(project.id, `Make file ${n}`));
    const other = add(side.id, 'Make the side file');
    context.projects.update(project.id, { held: false });
    board.pumpAll();
    expect(busy.map((t) => board.ticket(t.id).state)).toEqual([
      'working',
      'working',
      'waiting',
      'waiting',
    ]);
    context.projects.update(side.id, { held: false });
    board.pumpAll();
    expect(board.ticket(other.id).reason).toBe('Waiting for tiny:1b: its 2 slots are busy.');

    await until(
      () => [...busy, other].every((t) => columnOf(board.ticket(t.id)) === 'ready'),
      'all five are signed off',
    );
    await until(() => quiet(context), 'the runs are over');
    // The first slot the busy project freed went to the other project, not to its own queue.
    expect(starts.slice(0, 2).sort()).toEqual(['SURF-1', 'SURF-2']);
    expect(starts[2]).toBe('SIDE-1');
  }, 60_000);

  it('sends a spec gap to Scribe, who answers and hands the ticket back', async () => {
    const { context, project, board, chat, fake } = await setup(
      {
        'forge ticket': [
          [
            call('ticket_bounce', {
              to: 'scribe',
              reason: 'Spec gap: which currency?',
              issues: ['Say which currency prices are in'],
            }),
          ],
          [call('fs_write', { path: 'price.txt', content: 'AUD\n' })],
          [call('submit_output', { type: 'pr', title: 'Prices in AUD' })],
        ],
        'scribe ticket': [
          [
            call('board_update_ticket', {
              key: 'SURF-1',
              criteria: ['AC-1: Prices show in AUD'],
            }),
          ],
          [call('submit_output', { type: 'pr', summary: 'Prices are in AUD.' })],
        ],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { crew: ['scribe', 'forge'] },
    );
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Show prices',
      type: 'pr',
      description: '',
      criteria: ['AC-1: Prices show'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await until(() => quiet(context), 'the runs are over');

    const card = board.snapshot(project.id).tickets[0]!;
    expect(card).toMatchObject({ bounces: 1, detour: null });
    expect(card.criteria).toEqual([{ id: null, text: 'AC-1: Prices show in AUD' }]);
    expect(card.runs.map((r) => [r.clankId, r.role])).toEqual([
      ['forge', 'maker'],
      ['scribe', 'helper'],
      ['atlas', 'checker'],
    ]);
    // Scribe was told it isn't on the route, and Forge got its answer.
    const scribeAsk = fake.requests.find((r) => who(r) === 'scribe ticket')!;
    expect(scribeAsk.messages[0]!.content).toContain('as the clank Forge sent it to');
    expect(scribeAsk.tools?.map((t) => t.name)).toContain('submit_output');
    const forgeRun = card.runs[0]!.conversationId;
    expect(
      chat
        .get(forgeRun)
        .messages.filter((m) => m.author === 'app')
        .at(-1)!.content,
    ).toBe(
      'Scribe answered what you sent about SURF-1:\n\nPrices are in AUD.\n\nCarry on with SURF-1.',
    );
    expect(board.snapshot(project.id).events.map((e) => e.text)).toEqual(
      expect.arrayContaining([
        'sent SURF-1 to Scribe: Spec gap: which currency?',
        'answered Forge on SURF-1',
      ]),
    );
  }, 60_000);

  it('skips only optional checks, with a reason, and keeps sign-off', async () => {
    const { context, project, board } = await setup({}, { crew: ['forge', 'gauge'], held: true });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Fix the README',
      type: 'pr',
      description: '',
      criteria: ['It reads well'],
      stories: [],
      assignee: 'forge',
    });
    expect(() => board.skipCheck(ticket.id, 'gauge', 'README only')).toThrow(
      /required on pr tickets in this project/,
    );
    expect(() => board.skipCheck(ticket.id, 'atlas', 'Trivial')).toThrow(/required/);
    context.projects.update(project.id, { optionalChecks: ['gauge:pr'] });
    const skipped = board.skipCheck(ticket.id, 'gauge', 'README only');
    expect(skipped.route.map((s) => s.clankId)).toEqual(['forge', 'atlas']);
    expect(skipped.skipped).toEqual([{ clankId: 'gauge', reason: 'README only', by: 'user' }]);
    expect(board.restoreCheck(ticket.id, 'gauge').route.map((s) => s.clankId)).toEqual([
      'forge',
      'gauge',
      'atlas',
    ]);
  });

  it('sends a ticket that keeps bouncing to the user, after the project says how many', async () => {
    const bounce = [
      call('ticket_bounce', { to: 'forge', reason: 'Still broken', issues: ['Fix it'] }),
    ];
    const { context, project, board } = await setup(
      {
        'forge ticket': (request) =>
          request.messages.at(-1)!.role === 'tool' &&
          !request.messages.at(-1)!.content.includes('Handed in')
            ? [call('submit_output', { type: 'pr' })]
            : [call('fs_write', { path: 'a.txt', content: `${request.messages.length}\n` })],
        'gauge ticket': () => bounce,
      },
      { crew: ['forge', 'gauge'] },
    );
    context.projects.update(project.id, { bounceLimit: 1 });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Fix it',
      type: 'pr',
      description: '',
      criteria: ['It works'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => board.ticket(ticket.id).state === 'looping', 'it comes to the user');
    await until(() => quiet(context), 'the runs are over');
    expect(board.ticket(ticket.id)).toMatchObject({ bounces: 2, state: 'looping' });
    expect(board.snapshot(project.id).needsYou).toMatchObject([
      { kind: 'looping', text: 'Bounced 2 times: Fix it' },
    ]);
  }, 60_000);

  it('stops at a budget, and says why', async () => {
    const { context, project, board } = await setup(
      {
        'forge ticket': [
          [usage(4000), call('fs_write', { path: 'a.txt', content: 'a\n' })],
          [usage(4000), call('submit_output', { type: 'pr' })],
        ],
      },
      { crew: ['forge'] },
    );
    context.projects.update(project.id, {
      clankBudgets: { forge: { tokens: 3000, minutes: null, dollars: null } },
    });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Make a',
      type: 'pr',
      description: '',
      criteria: ['a exists'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => board.ticket(ticket.id).state === 'paused', 'the budget stops it');
    await until(() => quiet(context), 'the run is over');
    expect(board.ticket(ticket.id).reason).toBe(
      "Paused: Forge's budget of 3k tokens in this project is spent.",
    );
    const snapshot = board.snapshot(project.id);
    expect(snapshot.clanks.forge).toMatchObject({ reached: '3k tokens', usage: { tokens: 4000 } });
    // Carrying on doesn't get past it: the ticket waits, saying why.
    board.retry(ticket.id);
    expect(board.ticket(ticket.id)).toMatchObject({ state: 'waiting' });
    expect(board.ticket(ticket.id).reason).toBe("Paused: Forge's budget of 3k tokens is spent.");
  }, 60_000);

  it('rejects a ticket, dropping its notes, and sends conflicts back to be resolved', async () => {
    const { context, project, folder, board, chat } = await setup(
      {
        'forge ticket': (request) => {
          const brief = request.messages.filter((m) => m.role === 'user').at(-1)!.content;
          const last = request.messages.at(-1)!;
          if (brief.includes('conflicts')) {
            return last.role === 'tool'
              ? last.content.startsWith('Committed')
                ? [call('submit_output', { type: 'pr' })]
                : [call('git_commit', { message: 'Resolve the conflict' })]
              : [call('fs_write', { path: 'shop.txt', content: 'Both\n' })];
          }
          const key = /SURF-(\d)/.exec(request.messages[1]!.content)?.[1];
          if (last.role === 'tool') return [call('submit_output', { type: 'pr' })];
          return key === '3'
            ? [call('context_write', { kind: 'fact', title: 'Shipping is free' })]
            : [call('fs_write', { path: 'shop.txt', content: `Version ${key}\n` })];
        },
        'atlas ticket': () => [call('review_pass', { summary: 'Fine.' })],
      },
      { crew: ['forge'] },
    );
    const add = (title: string) =>
      board.addTicket({
        projectId: project.id,
        title,
        type: 'pr',
        description: '',
        criteria: ['It works'],
        stories: [],
        assignee: 'forge',
      });
    const one = add('Shop one');
    const two = add('Shop two');
    await until(
      () => [one, two].every((t) => columnOf(board.ticket(t.id)) === 'ready'),
      'both are signed off',
    );
    await until(() => quiet(context), 'the runs are over');

    await board.approve(one.id);
    await expect(board.approve(two.id)).rejects.toThrow(
      'SURF-2 conflicts with main in shop.txt. Send it back to have the conflicts resolved.',
    );
    expect(board.ticket(two.id).delivery?.error).toMatch(/conflicts/);
    await board.resolveConflicts(two.id);
    await until(() => columnOf(board.ticket(two.id)) === 'ready', 'Forge resolves it');
    await until(() => quiet(context), 'the runs are over');
    const forgeRun = board.snapshot(project.id).tickets[1]!.runs[0]!.conversationId;
    expect(result(chat, forgeRun, 'git_commit')).toContain('Committed on clanks/SURF-2');
    await board.approve(two.id);
    expect(readFileSync(join(folder, 'shop.txt'), 'utf8')).toBe('Both\n');

    // A rejected ticket's notes go, and it ends unmerged.
    const three = add('Note the shipping');
    await until(() => columnOf(board.ticket(three.id)) === 'build', 'it starts');
    await until(() => context.context.notes(project.id).length === 1, 'Forge notes it');
    await until(() => quiet(context), 'the run is over');
    await board.reject(three.id, 'Not needed');
    expect(board.ticket(three.id)).toMatchObject({ outcome: 'rejected', reason: 'Not needed' });
    expect(context.context.notes(project.id)).toEqual([]);
  }, 60_000);

  it('gives each run a port of its own, and stops the servers it leaves when it hands in', async () => {
    const { context, project, board, chat } = await setup(
      {
        'forge ticket': [
          [call('shell_exec', { command: 'echo "port $PORT"' })],
          [call('shell_start', { command: 'node -e "setInterval(() => {}, 1000)"' })],
          [call('fs_write', { path: 'a.txt', content: 'a\n' })],
          [call('submit_output', { type: 'pr' })],
        ],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { crew: ['forge'] },
    );
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Make a',
      type: 'pr',
      description: '',
      criteria: ['a exists'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await until(() => quiet(context), 'the runs are over');
    const run = board.snapshot(project.id).tickets[0]!.runs[0]!.conversationId;
    // Nothing asked: these are everyday commands in its worktree.
    expect(result(chat, run, 'shell_exec')).toContain(`port ${runPort(run)}`);
    const sessions = () => context.terminal.list(run);
    await until(() => sessions().every((s) => s.state !== 'running'), 'its server stops');
    expect(sessions().map((s) => s.title)).toEqual([
      'echo "port $PORT"',
      'node -e "setInterval(() => {}, 1000)"',
    ]);
  }, 60_000);

  it('asks a checker that runs out of room thinking to decide, rather than failing the ticket', async () => {
    const { context, project, board, chat } = await setup(
      {
        'forge ticket': [
          [call('fs_write', { path: 'a.txt', content: 'a\n' })],
          [call('submit_output', { type: 'pr' })],
        ],
        'gauge ticket': [
          [
            {
              type: 'text',
              text: 'I will check the link again. Yes. I will check the link again.',
            },
            { type: 'done', finishReason: 'length' },
          ],
          [call('review_pass', { summary: 'a.txt is there.' })],
        ],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { crew: ['forge', 'gauge'] },
    );
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Make a',
      type: 'pr',
      description: '',
      criteria: ['a exists'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await until(() => quiet(context), 'the runs are over');
    const gauge = board.snapshot(project.id).tickets[0]!.runs.find((r) => r.clankId === 'gauge')!;
    const notes = chat
      .get(gauge.conversationId)
      .messages.flatMap((m) => m.parts)
      .filter((p) => p.type === 'note')
      .map((p) => (p as { text: string }).text);
    expect(notes).toEqual([
      'Gauge ran out of room before deciding, so it was asked to decide now.',
    ]);
  }, 60_000);

  it('gives a run on a ticket more rounds than a chat, warns it near the end, then pauses it', async () => {
    let rounds = 0;
    const { context, project, board, chat, fake } = await setup(
      // A maker that only ever reports progress, and never hands in.
      { 'forge ticket': () => [call('post_progress', { message: `Step ${++rounds}` })] },
      { crew: ['forge', 'gauge'] },
    );
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Make a',
      type: 'pr',
      description: '',
      criteria: ['a exists'],
      stories: [],
      assignee: 'forge',
    });
    await until(() => board.ticket(ticket.id).state === 'paused', 'the run reached its limit');
    await until(() => quiet(context), 'the run is over');
    // Three times the forty rounds a chat gets, and it's a pause: the work so far is all there.
    expect(rounds).toBe(120);
    expect(board.ticket(ticket.id)).toMatchObject({
      state: 'paused',
      reason: 'Paused: Forge made 120 rounds of tool calls without handing in.',
    });
    const run = board.snapshot(project.id).tickets[0]!.runs[0]!;
    const notes = chat
      .get(run.conversationId)
      .messages.flatMap((m) => m.parts)
      .filter((p) => p.type === 'note')
      .map((p) => (p as { text: string }).text);
    expect(notes).toEqual([
      'Told Forge to finish up: this run is near its limit of 120 rounds.',
      'Stopped after 120 rounds of tool calls. Carry on to let Forge continue.',
    ]);
    // Eight rounds from the end it was told to hand in what it had.
    const told = fake.requests.findIndex((r) =>
      r.messages.some(
        (m) => m.role === 'user' && m.content.startsWith('This run has only a few rounds'),
      ),
    );
    expect(told).toBe(112);
    expect(fake.requests[told]!.messages.at(-1)!.content).toBe(
      "This run has only a few rounds of tool calls left. Start nothing new: finish the step you're on, then hand in what you have with `submit_output`, and say in its notes what is left to do.",
    );
  }, 60_000);

  it('previews what a clank sees on a ticket, layer by layer', async () => {
    const { context, project, board } = await setup({}, { crew: ['forge', 'gauge'], held: true });
    context.context.addNote({
      projectId: project.id,
      kind: 'fact',
      title: 'Prices include GST',
      body: '',
      why: 'Australian law',
      author: 'user',
      ticketId: null,
      status: 'active',
      pinned: true,
    });
    context.context.remember({
      projectId: project.id,
      clankId: 'gauge',
      kind: 'decision',
      body: 'Test checkout with the declined test card too.',
    });
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Add checkout',
      type: 'pr',
      description: 'Card payments.',
      criteria: ['A declined card keeps the cart'],
      stories: [],
      assignee: 'forge',
    });
    const preview = await context.chat.previewTicket(project.id, 'gauge', ticket.id, 'checker');
    const layer = (id: string) => preview.layers.find((l) => l.id === id)?.text ?? '';
    expect(layer('context')).toContain('Prices include GST');
    expect(layer('memory')).toContain('declined test card');
    expect(layer('run')).toContain('You are working SURF-1 on your own, as one of its checkers.');
    expect(preview.layers.map((l) => l.id)).toEqual([
      'crew',
      'clank',
      'profile',
      'context',
      'memory',
      'run',
    ]);
  });

  it('pushes the branch and opens a pull request on GitHub, and merges it there on approval', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    let head = '';
    const pull = () => ({
      number: 7,
      html_url: 'https://github.com/sam/surf/pull/7',
      state: 'open',
      merged: false,
      mergeable: true,
      head: { sha: head },
    });
    const fakeFetch = (input: string | URL | Request, init: RequestInit = {}) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ method, url, body });
      const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value)));
      if (url === 'https://api.github.com/user') return json({ login: 'sam', name: 'Sam' });
      if (method === 'GET' && url.includes('/pulls?state=open')) return json([]);
      if (method === 'POST' && url.endsWith('/repos/sam/surf/pulls')) return json(pull());
      if (method === 'GET' && url.endsWith('/repos/sam/surf/pulls/7')) return json(pull());
      if (method === 'PUT' && url.endsWith('/pulls/7/merge')) {
        return json({ merged: true, sha: 'f'.repeat(40) });
      }
      return Promise.resolve(new Response('{"message":"Not Found"}', { status: 404 }));
    };
    const { context, project, folder, board } = await setup(
      {
        'forge ticket': [
          [call('fs_write', { path: 'boards.txt', content: 'Fish\n' })],
          [call('submit_output', { type: 'pr', title: 'List boards', summary: 'Adds the list' })],
        ],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { crew: ['forge'], held: true, githubFetch: fakeFetch },
    );
    // The project's folder is a clone: its origin stands in for GitHub.
    const remote = join(tempDir(), 'surf.git');
    await git(['init', '--quiet', '--bare', remote], { cwd: folder });
    await git(['remote', 'add', 'origin', remote], { cwd: folder });
    await git(['push', '--quiet', 'origin', 'main'], { cwd: folder });
    context.store.db
      .update(projectTable)
      .set({ repo: { fullName: 'sam/surf', url: 'https://github.com/sam/surf', private: true } })
      .where(eq(projectTable.id, project.id))
      .run();
    await context.github.signInWithToken('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

    const ticket = board.addTicket({
      projectId: project.id,
      title: 'List the boards',
      type: 'pr',
      description: 'Every board.',
      criteria: ['AC-1: Every board shows'],
      stories: [],
      assignee: 'forge',
    });
    context.projects.update(project.id, { held: false });
    board.pumpAll();
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await until(() => board.ticket(ticket.id).delivery?.pr !== null, 'its pull request is open');
    await until(() => quiet(context), 'the runs are over');

    head = await git(['rev-parse', 'clanks/SURF-1'], { cwd: folder });
    // The branch is on the remote, and the pull request says what it's for.
    expect(await git(['rev-parse', 'clanks/SURF-1'], { cwd: remote })).toBe(head);
    const opened = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))!;
    expect(opened.body).toMatchObject({
      head: 'clanks/SURF-1',
      base: 'main',
      title: 'SURF-1: List the boards',
    });
    expect((opened.body as { body: string }).body).toContain('AC-1: Every board shows');
    expect(board.ticket(ticket.id).delivery?.pr).toMatchObject({ number: 7, state: 'open' });
    expect(board.snapshot(project.id).events.map((e) => e.text)).toContain(
      'opened PR #7 for SURF-1',
    );

    await board.approve(ticket.id);
    expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/pulls/7/merge'))).toBe(true);
    expect(board.ticket(ticket.id)).toMatchObject({ outcome: 'approved' });
    expect(board.ticket(ticket.id).delivery).toMatchObject({
      merged: 'f'.repeat(40),
      pr: { number: 7, state: 'merged' },
    });
    expect(board.snapshot(project.id).events.map((e) => e.text)).toContain('merged PR #7 (SURF-1)');
  }, 60_000);
});
