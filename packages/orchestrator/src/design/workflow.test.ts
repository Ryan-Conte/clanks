import { type ToolPart, columnOf } from '@clanks/core';
import type { Geometry } from '@clanks/design';
import { git } from '@clanks/workspace';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, quiet, say, setup, until } from '../board/test-kit';
import { formatNotes } from '../chat/service';
import type { DesignHost } from './service';

const TOKENS = [
  { name: 'color.sand.50', value: '#fbf7ef' },
  { name: 'color.ink.900', value: '#12202b' },
  { name: 'color.ocean.600', value: '#0b6fa4' },
  { name: 'color.bg', value: '{color.sand.50}', dark: '{color.ink.900}' },
  { name: 'color.text', value: '{color.ink.900}', dark: '{color.sand.50}' },
  { name: 'color.brand', value: '{color.ocean.600}' },
  { name: 'color.on-brand', value: '#ffffff' },
  { name: 'space.2', value: 8 },
  { name: 'space.4', value: 16 },
  { name: 'radius.md', value: 8 },
  { name: 'font.family.sans', value: 'Inter' },
  // As a small model writes it: JSON inside a string.
  {
    name: 'type.display',
    value: '{ "font": "{font.family.sans}", "size": 48, "weight": 700, "lineHeight": 1.1 }',
  },
  { name: 'type.body', value: { font: '{font.family.sans}', size: 16, lineHeight: 1.5 } },
];

const HOME = `
<Frame name="Home / Desktop" w=1440 layout=col gap={space.4} pad={space.4} fill={color.bg}>
  <Text name="Headline" style={type.display} color={color.text}>Find your next board.</Text>
  <Frame name="Shop button" layout=row padX={space.4} padY={space.2} fill={color.brand} radius={radius.md}>
    <Text name="Label" style={type.body} color={color.on-brand}>Shop boards</Text>
  </Frame>
</Frame>`;

function results(
  chat: Awaited<ReturnType<typeof setup>>['chat'],
  conversationId: string,
  tool: string,
): string[] {
  return chat
    .get(conversationId)
    .messages.flatMap((m) => m.parts)
    .filter((p): p is ToolPart => p.type === 'tool' && p.name === tool)
    .map((p) => p.result ?? '');
}

/** Draws nothing, but says where every layer would be: all inside a frame of the width asked for. */
const fakeHost: DesignHost = {
  draw: (input) => {
    const keys = [...input.html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]!);
    const boxes: Geometry = Object.fromEntries(
      keys.map((key, i) => [key, { x: 0, y: i * 20, w: 200, h: 20, sw: 200, sh: 20 }]),
    );
    if (keys[0]) boxes[keys[0]] = { x: 0, y: 0, w: input.width, h: 600, sw: input.width, sh: 600 };
    return Promise.resolve({
      boxes,
      width: input.width,
      height: 600,
      png: input.capture ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) : null,
    });
  },
};

describe('a design ticket', () => {
  it('is built by Prism in Studio, signed off, merged, and handed to Forge with its tokens and frames', async () => {
    let forgeSaw = '';
    const { context, project, folder, board, chat } = await setup(
      {
        'prism ticket': [
          // Handing in before there's anything to hand in is refused.
          [call('submit_output', { type: 'design', title: 'Home' })],
          [call('design_tokens_set', { tokens: TOKENS })],
          [
            call('fs_write', {
              path: 'design/DESIGN.md',
              content: '# Surf shop\n\nCalm, bright, fast.\n',
            }),
          ],
          [call('design_create', { markup: HOME })],
          [
            call('design_make_component', {
              node: 'Shop button',
              name: 'Button',
              variant: 'primary',
            }),
          ],
          [call('design_lint', {})],
          [call('design_render', { frame: 'Home / Desktop' })],
          // Saying a screen is there when it isn't is refused too.
          [
            call('submit_output', {
              type: 'design',
              title: 'Home page',
              frames: ['Home / Desktop: the hero', 'Button / primary'],
              criteria: [
                {
                  text: 'Phones too',
                  status: 'met',
                  evidence: "The frame 'Home / Mobile' shows it.",
                },
              ],
            }),
          ],
          [
            call('submit_output', {
              type: 'design',
              title: 'Home page',
              frames: [{ name: 'Home / Desktop', shows: 'The hero with the shop button' }],
              language: 'design/DESIGN.md',
            }),
          ],
        ],
        'atlas ticket': [
          [call('design_read', {})],
          [call('review_pass', { summary: 'It has the hero and the button.' })],
        ],
        'forge ticket': (request) => {
          forgeSaw = request.messages[0]!.content;
          return [call('fail', { reason: 'Only looking.' })];
        },
      },
      { held: true, designHost: fakeHost },
    );
    const design = board.addTicket({
      projectId: project.id,
      title: 'Design the home page',
      type: 'design',
      description: 'The storefront home page.',
      criteria: ['There is a frame named Home / Desktop'],
      stories: [],
      assignee: 'prism',
    });
    const build = board.addTicket({
      projectId: project.id,
      title: 'Build the home page',
      type: 'pr',
      description: 'Build it from the design.',
      criteria: ['It matches the design'],
      stories: [],
      assignee: 'forge',
    });
    board.linkTickets(build.id, design.id, false);
    context.projects.update(project.id, { held: false });
    board.pumpAll();
    await until(() => columnOf(board.ticket(design.id)) === 'ready', 'the design is ready');

    const run = chat.list().find((c) => c.ticketId === design.id && c.role === 'maker')!;
    const submits = results(chat, run.id, 'submit_output');
    expect(submits[0]).toMatch(/There's no design to hand in yet/);
    expect(submits[1]).toBe(
      'The hand-in names "Home / Mobile", but the design has no frame called that. Its frames: Home / Desktop. Build what\'s missing with design_create, or hand in only what is there and say in your notes what isn\'t.',
    );
    expect(submits[2]).toMatch(/^Handed in\./);
    expect(results(chat, run.id, 'design_tokens_set')[0]).toMatch(/added 13/);
    expect(results(chat, run.id, 'design_make_component')[0]).toMatch(
      /Made the component Button \(c\d+\) with the variant "primary"/,
    );
    expect(results(chat, run.id, 'design_lint')[0]).toMatch(/^No problems in 1 frame\.$/);
    expect(results(chat, run.id, 'design_render')[0]).toMatch(
      /Drew "Home \/ Desktop" in light mode/,
    );
    // The picture is kept for the user, as a PNG.
    const render = chat
      .get(run.id)
      .messages.flatMap((m) => m.parts)
      .find((p): p is ToolPart => p.type === 'tool' && p.name === 'design_render')!;
    expect(render.image).toMatch(/\.png$/);
    // Each change to the design is a checkpoint in the run.
    const state = await context.workspace.state(run.id);
    expect(state.checkpoints.map((c) => c.label)).toEqual(
      expect.arrayContaining(['Setting 13 tokens', 'Designing `Home / Desktop`']),
    );

    const handed = board.ticket(design.id);
    expect(handed.output).toMatchObject({
      file: 'design/site.design',
      lint: 'no problems',
      frames: [{ name: 'Home / Desktop' }],
    });
    expect(handed.delivery).toMatchObject({ branch: 'clanks/SURF-1', changed: true });
    const atlas = chat.list().find((c) => c.ticketId === design.id && c.role === 'checker')!;
    expect(results(chat, atlas.id, 'design_read')[0]).toContain('Frame "Home / Desktop"');

    // Nothing is in the project's own folder until the user approves.
    expect(existsSync(join(folder, 'design'))).toBe(false);
    await board.approve(design.id);
    expect(readFileSync(join(folder, 'design/DESIGN.md'), 'utf8')).toContain('Calm, bright, fast.');
    expect(existsSync(join(folder, 'design/site.design/document.json'))).toBe(true);

    // Forge, building on the design, is told its language, tokens and frames.
    await until(() => forgeSaw !== '' && quiet(context), 'Forge has started');
    expect(forgeSaw).toContain('## Design');
    expect(forgeSaw).toContain('Calm, bright, fast.');
    expect(forgeSaw).toContain('{color.brand} {color.ocean.600}');
    expect(forgeSaw).toContain('Frame "Home / Desktop" x=0 y=0 w=1440 layout=col');
    expect(forgeSaw).toContain('Component Button');
    expect(forgeSaw).toContain('This ticket builds on a design');
    expect(forgeSaw).toContain('`design_read`, `design_render`');
  }, 60_000);
});

describe("the user's edits in Studio", () => {
  it('are kept, checkpointed, and told to the clank with the next message', async () => {
    const { context, project, chat } = await setup(
      {
        'prism chat': [
          [call('design_tokens_set', { tokens: TOKENS })],
          [call('design_create', { markup: HOME })],
          say('The home page is on the canvas.'),
          // Later, not knowing the user restyled the button, it restyles it too.
          [
            call('design_update', {
              id: 'Shop button',
              set: { fill: '{color.text}', radius: 0 },
            }),
          ],
          say('Done.'),
        ],
      },
      { held: true },
    );
    const { conversation } = chat.start('prism', 'Design the home page.', null, project.id);
    await until(() => !chat.get(conversation.id).conversation.replying, 'Prism has replied');
    const run = context.workspace.run(conversation.id)!;
    const before = context.design.snapshot(run.cwd);
    const button = before.design!.pages[0]!.children[0]!;
    const id = button.type === 'frame' ? button.children[1]!.id : '';

    // The user restyles the button by hand, and pins a comment to the headline.
    context.design.applyUser({
      dir: run.cwd,
      ops: [{ op: 'update', id, set: { fill: '{color.on-brand}' } }],
      conversationId: conversation.id,
    });
    context.workspace.pin({
      conversationId: conversation.id,
      path: 'design/site.design',
      node: 'n3',
      name: 'Headline',
      frame: 'n2',
      frameName: 'Home / Desktop',
      page: 'p1',
      x: 40,
      y: 40,
      body: 'Make this friendlier.',
    });
    const notes = (await context.workspace.state(conversation.id)).notes;
    expect(notes.map((n) => [n.kind, n.status])).toEqual([
      ['design', 'pending'],
      ['pin', 'pending'],
    ]);
    expect(formatNotes(notes)).toBe(
      [
        'My review notes from Studio:',
        '',
        `1. I edited the design \`design/site.design\` myself in Studio:`,
        `   - [${id}] "Shop button" fill → {color.on-brand}`,
        '   Keep my changes. Read those layers again with design_read before you change them.',
        '2. About the layer [n3] "Headline" in the frame "Home / Desktop" in the design `design/site.design`: Make this friendlier.',
      ].join('\n'),
    );
    // A moment later the edit is a checkpoint of the user's.
    await until(
      () =>
        context.workspace
          .checkpoints(run.id)
          .some((c) => c.author === 'user' && c.label === 'You edited the design'),
      'the edit is checkpointed',
    );

    // Before the notes are sent, the clank's own change to the same property is turned down.
    expect(context.design.untoldEdits(conversation.id).size).toBe(1);
    chat.send(conversation.id, 'Square off the button.');
    await until(() => !chat.get(conversation.id).conversation.replying, 'Prism has replied again');
    const sent = chat.get(conversation.id).messages.at(-2)!;
    expect(sent.content).toContain('Square off the button.');
    expect(sent.content).toContain('I edited the design `design/site.design` myself in Studio');
    // Now it has been told, so its change is its own decision and goes through.
    expect(context.design.untoldEdits(conversation.id).size).toBe(0);
    const after = context.design.snapshot(run.cwd).design!.pages[0]!.children[0]!;
    expect(after.type === 'frame' ? after.children[1] : null).toMatchObject({
      fill: '{color.text}',
      radius: 0,
    });
    expect(
      (await context.workspace.state(conversation.id)).notes.every((n) => n.status === 'sent'),
    ).toBe(true);
  }, 60_000);

  it('go on the branch when made after the design was handed in, so they are merged with it', async () => {
    const { context, project, folder, board, chat } = await setup(
      {
        'prism ticket': [
          [call('design_tokens_set', { tokens: TOKENS })],
          [call('design_create', { markup: HOME })],
          [call('submit_output', { type: 'design', title: 'Home page' })],
        ],
        'atlas ticket': [[call('review_pass', { summary: 'Fine.' })]],
      },
      { held: true },
    );
    const ticket = board.addTicket({
      projectId: project.id,
      title: 'Design the home page',
      type: 'design',
      description: '',
      criteria: [],
      stories: [],
      assignee: 'prism',
    });
    context.projects.update(project.id, { held: false });
    board.pumpAll();
    await until(() => columnOf(board.ticket(ticket.id)) === 'ready', 'the design is ready');
    const run = chat.list().find((c) => c.ticketId === ticket.id && c.role === 'maker')!;
    const dir = context.workspace.run(run.id)!.cwd;
    const head = board.ticket(ticket.id).delivery!.head;
    const frame = context.design.snapshot(dir).design!.pages[0]!.children[0]!;
    const button = frame.type === 'frame' ? frame.children[1]! : frame;

    context.design.applyUser({
      dir,
      ops: [{ op: 'update', id: button.id, set: { fill: '{color.text}' } }],
      conversationId: run.id,
    });
    await until(() => board.ticket(ticket.id).delivery!.head !== head, 'the edit is on the branch');
    const log = await git(['log', '-1', '--format=%s', 'clanks/SURF-1'], { cwd: folder });
    expect(log).toBe('Edits by Sam on SURF-1');

    await board.approve(ticket.id);
    const page = JSON.parse(
      readFileSync(join(folder, 'design/site.design/pages/p1.json'), 'utf8'),
    ) as { children: { children: { fill: string }[] }[] };
    expect(page.children[0]!.children[1]!.fill).toBe('{color.text}');
  }, 60_000);
});
