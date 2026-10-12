import {
  BUILTIN_TEMPLATES,
  DEFAULT_PROJECT_CREW,
  SAMPLE_TEMPLATE,
  columnOf,
  fillTemplate,
} from '@clanks/core';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, repository, say, setup, until } from '../board/test-kit';
import { createCallerFactory } from '../trpc';
import { appRouter } from '../router';
import { tempDir } from '../test-helpers';
import { createFromTemplate, createSample, projectTemplates, quickStart } from './templates';

describe('project templates', () => {
  it('ship with the app, each with a crew that exists and something to start with', async () => {
    const { context } = await setup({});
    const templates = projectTemplates(context);
    expect(templates.map((t) => t.id)).toEqual([
      'ship-a-feature',
      'landing-page',
      'plan-a-launch',
      'question-to-report',
      'sample',
    ]);
    for (const template of templates) {
      expect(template.crew, template.id).toContain('atlas');
      for (const id of template.crew)
        expect(context.crew.has(id), `${template.id}: ${id}`).toBe(true);
      expect(template.kickoff !== '' || template.tickets.length > 0, template.id).toBe(true);
      for (const ticket of template.tickets) {
        // Whoever a ticket is for makes its type, and is in the template's crew.
        expect(template.crew, `${template.id}: ${ticket.title}`).toContain(ticket.clank);
        expect(context.crew.get(ticket.clank!).frontmatter.outputs).toContain(ticket.type);
      }
    }
    expect(fillTemplate('{{name}}: {{ brief }}', { name: 'Surf', brief: ' boards ' })).toBe(
      'Surf: boards',
    );
  });

  it('start a project with its crew, and tell Atlas what the template asks', async () => {
    let asked = '';
    const { context } = await setup({
      'atlas chat': (request) => {
        asked = request.messages.at(-1)!.content;
        return say('On it.');
      },
    });
    const started = await createFromTemplate(
      context,
      {
        name: 'Payments',
        brief: 'Which payment providers suit a small shop in Australia?',
        key: 'PAY',
        workspace: { kind: 'folder', path: await repository() },
        crew: ['atlas', 'scout', 'quill'],
        model: null,
        models: {},
      },
      'question-to-report',
    );
    expect(context.projects.members(started.project.id).map((m) => m.clankId)).toEqual([
      'atlas',
      'scout',
      'quill',
    ]);
    expect(started).toMatchObject({ tickets: 0, notes: [] });
    await until(
      () => !context.chat.get(started.conversationId!).conversation.replying,
      'Atlas has answered',
    );
    expect(asked).toContain(
      'I have a question: Which payment providers suit a small shop in Australia?',
    );
    expect(asked).toContain('Create a research ticket for Scout');
    await expect(
      createFromTemplate(
        context,
        {
          name: 'x',
          brief: '',
          key: 'XX',
          workspace: { kind: 'folder', path: await repository() },
          crew: ['atlas'],
          model: null,
          models: {},
        },
        'nothing-like-it',
      ),
    ).rejects.toThrow(/isn't installed/);
  });

  it('run the sample: two tickets on the board, the second waiting on the first', async () => {
    const { context } = await setup({
      'quill ticket': [
        [
          call('submit_output', {
            type: 'copy',
            title: 'Bean There',
            body: 'Headline: Coffee worth the walk.\n\nOpen Saturdays, 7 to 1, at the market.',
          }),
        ],
      ],
      'atlas ticket': [[call('review_pass', { summary: 'It reads well.' })]],
      // Forge is left asking, so the sample stays where the test can look at it.
      'forge ticket': [[call('ask_user', { question: 'Which colours?' })]],
    });
    const folder = join(tempDir(), 'coffee-cart');
    const started = await createSample(context, folder);
    expect(started.project).toMatchObject({ name: 'Coffee cart', key: 'CART', folder });
    expect(started).toMatchObject({ conversationId: null, tickets: 2, notes: [] });
    const tickets = context.board.tickets(started.project.id);
    expect(tickets.map((t) => [t.key, t.type, t.assignee])).toEqual([
      ['CART-1', 'copy', 'quill'],
      ['CART-2', 'pr', 'forge'],
    ]);
    expect(tickets[1]!.dependsOn).toEqual([tickets[0]!.id]);
    const sample = BUILTIN_TEMPLATES.find((t) => t.id === SAMPLE_TEMPLATE)!;
    expect(tickets[0]!.description).toContain(sample.example);
    // The crew gets going on its own: Quill writes, Atlas signs it off, and it waits for the user.
    await until(
      () => columnOf(context.board.ticket(tickets[0]!.id)) === 'ready',
      'the copy is ready for the user',
    );
    expect(columnOf(context.board.ticket(tickets[1]!.id))).toBe('backlog');
  }, 60_000);

  it('start a project from one sentence: a name, a folder, the usual crew and Atlas told', async () => {
    let asked = '';
    const { context } = await setup({
      'atlas chat': (request) => {
        asked = request.messages.at(-1)!.content;
        return say('Tell me more.');
      },
    });
    const root = tempDir();
    const idea = 'I want to build a website for my bakery, with a menu and opening hours';
    const started = await quickStart(context, { idea }, root);
    expect(started.project).toMatchObject({
      name: 'Website for my bakery',
      key: 'WEBS',
      folder: join(root, 'website-for-my-bakery'),
      brief: idea,
    });
    expect(context.projects.members(started.project.id).map((m) => m.clankId)).toEqual([
      ...DEFAULT_PROJECT_CREW,
    ]);
    await until(
      () => !context.chat.get(started.conversationId!).conversation.replying,
      'Atlas has answered',
    );
    expect(asked).toBe(idea);

    // The same idea again gets a folder and a key of its own.
    const again = await quickStart(context, { idea }, root);
    expect(again.project).toMatchObject({
      key: 'WEBS2',
      folder: join(root, 'website-for-my-bakery-2'),
    });

    // From a template, the crew and the first message are the template's.
    const report = await quickStart(
      context,
      { idea: 'Which payment providers suit a small shop?', templateId: 'question-to-report' },
      root,
    );
    expect(context.projects.members(report.project.id).map((m) => m.clankId)).toEqual([
      'atlas',
      'scout',
      'quill',
    ]);
    await until(
      () => !context.chat.get(report.conversationId!).conversation.replying,
      'Atlas has answered',
    );
    expect(asked).toContain('I have a question: Which payment providers suit a small shop?');
    await expect(
      quickStart(context, { idea, templateId: 'nothing-like-it' }, root),
    ).rejects.toThrow(/isn't installed/);
  });

  it('are offered once: making the sample marks it as offered', async () => {
    const { context } = await setup({});
    const caller = createCallerFactory(appRouter)(context);
    expect(context.settings.get().sampleOffered).toBe(false);
    expect((await caller.projects.templates()).length).toBeGreaterThanOrEqual(5);
    context.settings.update({ sampleOffered: true });
    expect(context.settings.get().sampleOffered).toBe(true);
  });
});
