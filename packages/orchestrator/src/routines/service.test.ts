import { type ChatRequest, type ToolPart, columnOf } from '@clanks/core';
import type { Geometry } from '@clanks/design';
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Script, call, say, setup, until } from '../board/test-kit';
import type { DesignHost } from '../design/service';
import { scheduledAction } from '../store/schema';
import { tempDir } from '../test-helpers';
import type { RoutineNotice } from './service';

const SYDNEY = 'Australia/Sydney';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const POSTER = {
  'manifest.yaml': `
id: poster
name: Poster
summary: Posts for the surf shop.
hosts: ["api.poster.example"]
links: ["poster.example"]
auth: { type: api_key, header: Authorization, format: "Bearer {secret}" }
openapi: openapi.yaml
operations:
  - { id: recent_posts, op: "GET /posts", risk: read }
  - id: create_post
    op: "POST /posts"
    risk: outbound
    verify: recent_posts
    link: "https://poster.example/p/{id}"
  - { id: shout, op: "POST /shouts", risk: outbound }
  - id: schedule_post
    op: "POST /scheduled"
    risk: outbound
    schedule: publish_at
    cancel: cancel_scheduled
  - { id: cancel_scheduled, op: "DELETE /scheduled/{id}", risk: outbound }
guide: guide.md
`,
  'openapi.yaml': `
openapi: 3.0.3
servers: [{ url: "https://api.poster.example" }]
paths:
  /posts:
    get: { summary: The latest posts. }
    post:
      summary: Publish a post.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [text]
              properties:
                text: { type: string }
                image: { type: string, description: A PNG, in base64. }
  /shouts:
    post:
      summary: Shout something.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [text]
              properties:
                text: { type: string }
  /scheduled:
    post:
      summary: Hold a post to publish later.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [text, publish_at]
              properties:
                text: { type: string }
                publish_at: { type: string }
  /scheduled/{id}:
    delete:
      summary: Take back a post that's held.
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
`,
  'guide.md': 'Posts are public as soon as they are made.\n',
};

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: Record<string, unknown>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stands in for the service actions post to. `answer` decides what each call gets. */
function poster(answer: (seen: Seen, calls: Seen[]) => Response | Promise<Response> | undefined) {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== 'api.poster.example') throw new TypeError('fetch failed');
    const request: Seen = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as never) : {},
    };
    seen.push(request);
    const given = await answer(request, seen);
    if (given) return given;
    if (request.method === 'GET') return json({ data: [] });
    return json({ id: `p_${seen.filter((s) => s.method === 'POST').length}` });
  };
  return { fetch: fake, seen, posts: () => seen.filter((s) => s.method === 'POST') };
}

/** Draws nothing, but says where every layer would be, and hands back a picture when asked. */
const designHost: DesignHost = {
  draw: (input) => {
    const keys = [...input.html.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]!);
    const boxes: Geometry = Object.fromEntries(
      keys.map((key, i) => [key, { x: 0, y: i * 20, w: 200, h: 20, sw: 200, sh: 20 }]),
    );
    if (keys[0]) boxes[keys[0]] = { x: 0, y: 0, w: input.width, h: 900, sw: input.width, sh: 900 };
    return Promise.resolve({
      boxes,
      width: input.width,
      height: 900,
      png: input.capture ? PNG : null,
    });
  },
};

const pass = [call('review_pass', { summary: 'It does what its criteria say.' })];

/** A project with the Poster service connected, a clock the test moves, and the notices sent. */
async function kit(
  scripts: Record<string, Script> = {},
  options: {
    crew?: string[];
    start?: string;
    answer?: Parameters<typeof poster>[0];
    tags?: () => string[];
  } = {},
) {
  const service = poster(options.answer ?? (() => undefined));
  let clock = new Date(options.start ?? '2026-11-12T01:00:00Z');
  const base = await setup(
    { 'atlas ticket': [pass], ...scripts },
    {
      crew: options.crew ?? ['prism', 'buzz'],
      designHost,
      orchestrator: {
        integrationsFetch: service.fetch,
        routines: {
          now: () => clock,
          start: false,
          ...(options.tags ? { tags: () => Promise.resolve(options.tags!()) } : {}),
        },
      },
    },
  );
  const { context, project } = base;
  context.settings.update({
    profile: { name: 'Sam', timeZone: SYDNEY, language: '', preferences: '' },
  });
  const dir = join(tempDir(), 'poster');
  mkdirSync(dir);
  for (const [name, text] of Object.entries(POSTER)) writeFileSync(join(dir, name), text);
  await context.integrations.addFromFolder(dir);
  const connection = await context.integrations.connect({
    integrationId: 'poster',
    label: '@surfshop',
    secret: 'poster-key-1',
    mode: 'live',
  });
  context.integrations.setProject(project.id, connection.id, ['buzz']);
  const notices: RoutineNotice[] = [];
  context.routines.on('notice', (notice) => notices.push(notice));
  const routines = context.routines;
  return {
    ...base,
    routines,
    service,
    notices,
    connection,
    /** Moves the clock, then does whatever has come due. */
    at: async (iso: string) => {
      clock = new Date(iso);
      await routines.tick();
      await routines.idle();
    },
    set: (iso: string) => {
      clock = new Date(iso);
    },
    snapshot: () => routines.snapshot(project.id),
  };
}

/** A routine that only posts: nothing for a model to make, so its run waits for approval at once. */
const announce = (extra: Record<string, unknown> = {}, action: Record<string, unknown> = {}) => ({
  name: 'Friday shout',
  schedule: 'every friday at 1pm',
  inputs: { message: 'Longboards are 20% off all weekend.' },
  steps: [
    {
      id: 'publish',
      action: {
        integration: 'poster',
        operation: 'create_post',
        at: '17:00',
        payload: { text: '{{inputs.message}}' },
        ...action,
      },
    },
  ],
  ...extra,
});

/** Friday 13 November 2026 in Sydney, as UTC: 13:00 is 02:00Z and 17:00 is 06:00Z. */
const FRIDAY_1PM = '2026-11-13T02:00:00Z';
const FRIDAY_5PM = '2026-11-13T06:00:00Z';

type Kit = Awaited<ReturnType<typeof kit>>;

/** Starts the Friday run and returns it once it waits for approval. */
async function waiting(k: Kit, definition: Record<string, unknown> = announce()) {
  const routine = k.routines.create(k.project.id, definition);
  k.routines.activate(routine.id);
  await k.at(FRIDAY_1PM);
  const run = k.snapshot().runs[0]!;
  expect(run.status).toBe('awaiting_approval');
  return { routine, run, action: run.actions[0]! };
}

describe('the promo banner routine', () => {
  const BANNER = `
<Frame name="Promo / X" w=1600 h=900 layout=col pad={space.4} fill={color.bg}>
  <Text name="Offer" color={color.text}>20% off all longboards this weekend</Text>
</Frame>`;
  const PLAN =
    '## Goal and metric\nSales.\n\n## Audience\nSurfers.\n\n## Positioning\nx\n\n## Message pillars\ny\n\n## Channels\nPoster.\n\n## Calendar\nFriday.\n\n## Budget\n$0\n\n## Risks\nNone.';

  it('makes the banner and the post, waits for one approval, and posts at 17:00', async () => {
    let buzzSaw = '';
    const k = await kit({
      'prism ticket': [
        [
          call('design_tokens_set', {
            tokens: [
              { name: 'color.bg', value: '#0b6fa4' },
              { name: 'color.text', value: '#ffffff' },
              { name: 'space.4', value: 16 },
            ],
          }),
        ],
        [call('design_create', { markup: BANNER })],
        [
          call('submit_output', {
            type: 'design',
            title: 'Promo banner',
            summary: 'One banner for X.',
            frames: ['Promo / X: the offer, big'],
          }),
        ],
      ],
      'buzz ticket': (request: ChatRequest) => {
        buzzSaw = request.messages[0]!.content;
        return [
          call('submit_output', {
            type: 'campaign',
            title: 'Weekend promo post',
            plan: PLAN,
            posts: [
              {
                channel: 'Poster',
                account: '@surfshop',
                text: 'Longboards are 20% off all weekend. poster.example/sale',
                visual: 'Promo / X',
              },
            ],
          }),
        ];
      },
    });
    const routine = k.routines.create(k.project.id, {
      name: 'Weekend promo',
      schedule: 'every friday at 1pm',
      time_zone: SYDNEY,
      inputs: { offer: '20% off all longboards this weekend' },
      steps: [
        {
          id: 'banner',
          ticket: {
            clank: 'prism',
            type: 'design',
            title: 'Promo banner: {{inputs.offer}}',
            criteria: ["One frame named 'Promo / X' at 1600×900"],
          },
        },
        {
          id: 'copy',
          depends_on: ['banner'],
          ticket: { clank: 'buzz', type: 'campaign', title: 'Post for {{inputs.offer}}' },
        },
        {
          id: 'publish',
          depends_on: ['banner', 'copy'],
          action: {
            integration: 'poster',
            operation: 'create_post',
            connection: '@surfshop',
            at: '17:00',
            payload: {
              text: '{{steps.copy.output.posts[0].text}}',
              image: "{{steps.banner.output.frames['Promo / X'].png}}",
            },
          },
        },
      ],
    });
    // A draft schedules nothing, and shows what it would do.
    const draft = k.snapshot().routines[0]!;
    expect(draft).toMatchObject({
      status: 'draft',
      triggerText: 'Fridays at 13:00 (Australia/Sydney)',
      problems: [],
      nextRunAt: null,
    });
    expect(draft.nextRuns).toHaveLength(5);
    expect(draft.nextRuns[0]!.toISOString()).toBe('2026-11-13T02:00:00.000Z');
    await k.at('2026-11-13T01:59:00Z');
    expect(k.snapshot().runs).toHaveLength(0);

    k.routines.activate(routine.id);
    await k.at(FRIDAY_1PM);
    // The whole run is on the board at once, each ticket with when it's due.
    const tickets = k.board.tickets(k.project.id);
    expect(tickets.map((t) => [t.key, t.type, t.assignee, t.origin])).toEqual([
      ['SURF-1', 'design', 'prism', 'routine'],
      ['SURF-2', 'campaign', 'buzz', 'routine'],
    ]);
    expect(tickets[0]!.title).toBe('Promo banner: 20% off all longboards this weekend');
    expect(tickets[1]!.dependsOn).toEqual([tickets[0]!.id]);
    expect(tickets[0]!.routine).toMatchObject({
      name: 'Weekend promo',
      date: '2026-11-13',
      dueAt: '2026-11-13T05:00:00.000Z',
      dueWhy: 'so it can be reviewed before the 17:00 post',
    });

    // Buzz starts once the banner is signed off, without waiting for it to be approved.
    await until(
      () => k.board.tickets(k.project.id).every((t) => columnOf(t) === 'ready'),
      'both tickets are signed off',
    );
    await k.routines.idle();
    expect(buzzSaw).toContain('Created by the routine "Weekend promo"');
    expect(buzzSaw).toContain(
      'Due 16:00 on Fri 13 Nov, so it can be reviewed before the 17:00 post',
    );

    // One card: the post as it will go out, with its banner, account and time.
    const run = k.snapshot().runs[0]!;
    expect(run.status).toBe('awaiting_approval');
    const [action] = run.actions;
    expect(action).toMatchObject({
      status: 'pending_approval',
      integrationName: 'Poster',
      connectionLabel: '@surfshop',
      mode: 'live',
      text: 'Longboards are 20% off all weekend. poster.example/sale',
      fields: [{ name: 'image', value: 'Promo / X.png' }],
      problems: [],
      madeBy: 'buzz',
    });
    expect(action!.executeAt.toISOString()).toBe('2026-11-13T06:00:00.000Z');
    expect(action!.media).toHaveLength(1);
    expect(k.routines.media(action!.id, action!.media[0]!.sha256)!.url).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(k.notices.map((n) => n.kind)).toEqual(['ready']);
    expect(k.snapshot().needs).toMatchObject([{ kind: 'approve', runId: run.id }]);
    expect(k.service.posts()).toHaveLength(0);

    await k.routines.approveRun(run.id);
    await k.routines.idle();
    expect(k.board.tickets(k.project.id).every((t) => t.outcome === 'approved')).toBe(true);
    expect(k.snapshot().runs[0]).toMatchObject({ status: 'approved' });

    // Not a minute early.
    await k.at('2026-11-13T05:59:59Z');
    expect(k.service.posts()).toHaveLength(0);
    await k.at(FRIDAY_5PM);
    expect(k.service.posts()).toEqual([
      {
        method: 'POST',
        path: '/posts',
        auth: 'Bearer poster-key-1',
        body: {
          text: 'Longboards are 20% off all weekend. poster.example/sale',
          image: Buffer.from(PNG).toString('base64'),
        },
      },
    ]);
    const done = k.snapshot().runs[0]!;
    expect(done.status).toBe('done');
    expect(done.actions[0]).toMatchObject({
      status: 'done',
      attempts: 1,
      result: { id: 'p_1', url: 'https://poster.example/p/p_1', handedOff: false },
    });
    // The clank whose words it was hears how it went.
    expect(
      k.context.context
        .memories(k.project.id, 'buzz')
        .map((m) => m.body)
        .join('\n'),
    ).toMatch(/Sent through Poster as @surfshop.*https:\/\/poster\.example\/p\/p_1/);
    // It goes out once, and the routine carries on to next Friday.
    await k.at('2026-11-13T06:05:00Z');
    expect(k.service.posts()).toHaveLength(1);
    expect(k.routines.routine(routine.id).nextRunAt!.toISOString()).toBe(
      '2026-11-20T02:00:00.000Z',
    );
  }, 60_000);
});

describe('a scheduled action', () => {
  it('is missed, not posted late, when the computer was asleep at its time', async () => {
    const k = await kit();
    const { run } = await waiting(k);
    await k.routines.approveRun(run.id);
    // Asleep through 17:00, awake at 17:20: past the 15 minutes it may be late by.
    await k.at('2026-11-13T06:20:00Z');
    expect(k.service.posts()).toHaveLength(0);
    const missed = k.snapshot().runs[0]!;
    expect(missed.status).toBe('missed');
    expect(missed.actions[0]).toMatchObject({ status: 'missed' });
    expect(missed.actions[0]!.error).toMatch(/wasn't sent late/);
    expect(k.notices.at(-1)).toMatchObject({ kind: 'missed', actionId: missed.actions[0]!.id });
    expect(k.snapshot().needs.map((n) => n.kind)).toContain('missed');

    // Post now is the user's own say-so, so it goes.
    await k.routines.postNow(missed.actions[0]!.id);
    await k.routines.idle();
    expect(k.service.posts()).toHaveLength(1);
    expect(k.snapshot().runs[0]).toMatchObject({ status: 'done' });
  });

  it('still goes out a few minutes late, inside its grace', async () => {
    const k = await kit();
    const { run } = await waiting(k);
    await k.routines.approveRun(run.id);
    await k.at('2026-11-13T06:14:00Z');
    expect(k.service.posts()).toHaveLength(1);
  });

  it('never goes out unapproved', async () => {
    const k = await kit();
    await waiting(k);
    // A reminder half an hour before, then nothing at its time.
    await k.at('2026-11-13T05:31:00Z');
    expect(k.notices.map((n) => n.kind)).toEqual(['ready', 'reminder']);
    await k.at(FRIDAY_5PM);
    expect(k.service.posts()).toHaveLength(0);
    const run = k.snapshot().runs[0]!;
    expect(run.actions[0]).toMatchObject({ status: 'missed' });
    expect(run.actions[0]!.error).toMatch(/wasn't approved by its time/);
    expect(run.status).toBe('missed');
  });

  it('asks again when its words or its time change after approval', async () => {
    const k = await kit();
    const { run, action } = await waiting(k);
    await k.routines.approveRun(run.id);
    k.routines.editAction(action.id, { text: 'Longboards are 25% off all weekend.' });
    expect(k.snapshot().runs[0]).toMatchObject({ status: 'awaiting_approval' });
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({
      status: 'pending_approval',
      approvedAt: null,
      payloadHash: null,
    });
    await k.routines.approveRun(run.id);
    k.routines.editAction(action.id, { executeAt: new Date('2026-11-13T07:00:00Z') });
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({ status: 'pending_approval' });
    await k.at(FRIDAY_5PM);
    expect(k.service.posts()).toHaveLength(0);
    await k.routines.approveRun(run.id);
    await k.at('2026-11-13T07:00:00Z');
    expect(k.service.posts().map((p) => p.body.text)).toEqual([
      'Longboards are 25% off all weekend.',
    ]);
  });

  it("doesn't go out if it isn't what was approved any more", async () => {
    const k = await kit();
    const { run, action } = await waiting(k);
    await k.routines.approveRun(run.id);
    // Changed behind the app's back, as nothing in the app can.
    k.context.store.db
      .update(scheduledAction)
      .set({ payload: { text: 'Send all your money to this address.' } })
      .where(eq(scheduledAction.id, action.id))
      .run();
    await k.at(FRIDAY_5PM);
    expect(k.service.posts()).toHaveLength(0);
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({ status: 'failed' });
    expect(k.snapshot().runs[0]!.actions[0]!.error).toMatch(/isn't what was approved/);
  });

  it('tries again after a failure that may pass, inside its window', async () => {
    const k = await kit(
      {},
      {
        answer: (seen, calls) =>
          seen.method === 'POST' && calls.filter((c) => c.method === 'POST').length < 3
            ? json({ error: { message: 'Over capacity' } }, 503)
            : undefined,
      },
    );
    const { run } = await waiting(k);
    await k.routines.approveRun(run.id);
    await k.at(FRIDAY_5PM);
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({ status: 'approved', attempts: 1 });
    expect(k.snapshot().runs[0]!.actions[0]!.error).toMatch(/Trying again: Over capacity/);
    // Not before its wait is up.
    await k.at('2026-11-13T06:00:03Z');
    expect(k.service.posts()).toHaveLength(1);
    await k.at('2026-11-13T06:00:06Z');
    await k.at('2026-11-13T06:00:30Z');
    expect(k.service.posts()).toHaveLength(3);
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({ status: 'done', attempts: 3 });
  });

  it("isn't tried again when the service turns it down", async () => {
    const k = await kit(
      {},
      {
        answer: (seen) =>
          seen.method === 'POST' ? json({ error: { message: 'Duplicate post' } }, 403) : undefined,
      },
    );
    const { run } = await waiting(k);
    await k.routines.approveRun(run.id);
    await k.at(FRIDAY_5PM);
    await k.at('2026-11-13T06:10:00Z');
    expect(k.service.posts()).toHaveLength(1);
    const failed = k.snapshot().runs[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.actions[0]!.error).toBe('Poster turned it down: Duplicate post');
    expect(k.notices.map((n) => n.kind)).toContain('failed');
  });

  it('asks the service whether it went out before trying again after no answer', async () => {
    let posted = false;
    const k = await kit(
      {},
      {
        answer: (seen) => {
          if (seen.method === 'POST') {
            posted = true;
            // The post is made, and the answer is lost on the way back.
            throw new TypeError('fetch failed');
          }
          return posted
            ? json({ data: [{ id: 'p_9', text: 'Longboards are 20% off all weekend.' }] })
            : undefined;
        },
      },
    );
    const { run } = await waiting(k);
    await k.routines.approveRun(run.id);
    await k.at(FRIDAY_5PM);
    await k.at('2026-11-13T06:01:00Z');
    expect(k.service.posts()).toHaveLength(1);
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({
      status: 'done',
      result: { summary: 'It went out: the service lists it.' },
    });
  });

  it('finds out what happened to one that was mid-call when the app stopped', async () => {
    const k = await kit(
      {},
      {
        answer: (seen) =>
          seen.method === 'GET' ? json({ data: [{ text: 'Nothing like it.' }] }) : undefined,
      },
    );
    const { run, action } = await waiting(k);
    await k.routines.approveRun(run.id);
    const stopMidCall = () =>
      k.context.store.db
        .update(scheduledAction)
        .set({ status: 'executing', attempts: 1, attemptId: 'a1' })
        .where(eq(scheduledAction.id, action.id))
        .run();
    // The service lists nothing like it: it never went, so it's sent while its window is open.
    stopMidCall();
    k.set('2026-11-13T06:02:00Z');
    k.routines.start();
    await k.routines.idle();
    await k.routines.tick();
    expect(k.service.posts()).toHaveLength(1);
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({ status: 'done' });
  });

  it('asks the user about one whose outcome nobody can tell', async () => {
    const k = await kit();
    const { run, action } = await waiting(k, announce({}, { operation: 'shout' }));
    await k.routines.approveRun(run.id);
    k.context.store.db
      .update(scheduledAction)
      .set({ status: 'executing', attempts: 1, attemptId: 'a1' })
      .where(eq(scheduledAction.id, action.id))
      .run();
    k.set('2026-11-13T06:02:00Z');
    k.routines.start();
    await k.routines.idle();
    await k.routines.tick();
    // No way to check, so it isn't sent again on a guess.
    expect(k.service.posts()).toHaveLength(0);
    expect(k.snapshot().runs[0]!.actions[0]).toMatchObject({ status: 'unknown' });
    expect(k.notices.at(-1)).toMatchObject({ kind: 'unknown' });
    expect(k.snapshot().needs.map((n) => n.kind)).toContain('unknown');
    await k.routines.decideUnknown(action.id, 'sent');
    expect(k.snapshot().runs[0]).toMatchObject({ status: 'done' });
  });

  it('is handed to a service that can hold it, and taken back from there', async () => {
    const k = await kit();
    const { run, action } = await waiting(
      k,
      announce({}, { operation: 'schedule_post', deliver: 'hand_off' }),
    );
    await k.routines.approveRun(run.id);
    await k.routines.idle();
    // Sent straight away, with its time, so it goes out with this computer off.
    expect(k.service.posts()).toMatchObject([
      {
        path: '/scheduled',
        body: {
          text: 'Longboards are 20% off all weekend.',
          publish_at: '2026-11-13T06:00:00.000Z',
        },
      },
    ]);
    expect(k.snapshot().actions[0]).toMatchObject({
      status: 'done',
      result: { id: 'p_1', handedOff: true },
    });
    await k.routines.cancelAction(action.id);
    expect(k.service.seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/scheduled/p_1' });
    expect(k.snapshot().actions.find((a) => a.id === action.id)).toMatchObject({
      status: 'cancelled',
    });
  });

  it("can't be approved with nothing to send it from", async () => {
    const k = await kit();
    k.context.integrations.setProject(k.project.id, k.connection.id, null);
    const routine = k.routines.create(k.project.id, announce());
    expect(k.snapshot().routines[0]!.problems.join(' ')).toMatch(
      /no account is turned on in this project for `poster` \(Poster\)/,
    );
    expect(() => k.routines.activate(routine.id)).toThrow(/can't be turned on yet/);
  });
});

describe('runs', () => {
  const digest = (extra: Record<string, unknown> = {}) => ({
    name: 'Monday digest',
    schedule: 'every monday at 9',
    steps: [
      {
        id: 'plan',
        ticket: {
          clank: 'buzz',
          type: 'campaign',
          title: 'Plan the week of {{run.date}}',
        },
      },
    ],
    ...extra,
  });
  const buzz = {
    'buzz ticket': [
      [
        call('submit_output', {
          type: 'campaign',
          title: 'The week',
          plan: '## Goal and metric\nx',
          posts: [],
        }),
      ],
    ],
  };
  /** Monday 16 November 2026, 09:00 in Sydney. */
  const MONDAY_9AM = '2026-11-15T22:00:00Z';

  it('start late, once, when a routine of tickets was missed', async () => {
    const k = await kit(buzz);
    const routine = k.routines.create(k.project.id, digest());
    k.routines.activate(routine.id);
    // Off for three weeks.
    await k.at('2026-12-02T03:00:00Z');
    const runs = k.snapshot().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'working', trigger: { kind: 'late', missed: 3 } });
    expect(k.board.tickets(k.project.id).map((t) => t.title)).toEqual([
      'Plan the week of 2026-11-30',
    ]);
    // Its work is the user's to approve on the board, like any ticket's; then the run is done.
    await until(() => columnOf(k.board.tickets(k.project.id)[0]!) === 'ready', 'it is signed off');
    await k.board.approve(k.board.tickets(k.project.id)[0]!.id);
    await k.routines.idle();
    expect(k.snapshot().runs[0]).toMatchObject({ status: 'done' });
  });

  it('are skipped and recorded when the routine says to skip what it missed', async () => {
    const k = await kit(buzz);
    const routine = k.routines.create(k.project.id, digest({ missed: { policy: 'skip' } }));
    k.routines.activate(routine.id);
    await k.at('2026-11-24T03:00:00Z');
    expect(k.snapshot().runs.map((r) => r.status)).toEqual(['missed', 'missed']);
    expect(k.board.tickets(k.project.id)).toHaveLength(0);
    expect(k.notices.at(-1)).toMatchObject({ kind: 'missed' });
    // The next one runs as usual.
    await k.at('2026-11-29T22:00:00Z');
    expect(k.snapshot().runs[0]).toMatchObject({ status: 'working', trigger: { kind: 'time' } });
  });

  it('ask what to do when the routine says to ask', async () => {
    const k = await kit(buzz);
    const routine = k.routines.create(k.project.id, digest({ missed: { policy: 'ask' } }));
    k.routines.activate(routine.id);
    await k.at('2026-11-17T03:00:00Z');
    const [asked] = k.snapshot().runs;
    expect(asked).toMatchObject({ status: 'missed', asks: true });
    expect(k.snapshot().needs).toMatchObject([{ kind: 'missed', runId: asked!.id }]);
    k.routines.answerMissed(asked!.id, 'run');
    await k.routines.idle();
    expect(
      k
        .snapshot()
        .runs.map((r) => r.status)
        .sort(),
    ).toEqual(['missed', 'working']);
    expect(k.snapshot().needs).toEqual([]);
  });

  it("don't start while the one before is still going, unless the routine queues them", async () => {
    // Buzz never hands in, so the first run is still going a week later.
    const stuck = { 'buzz ticket': [[call('ask_user', { question: 'Which week?' })]] };
    const k = await kit(stuck);
    const routine = k.routines.create(k.project.id, digest());
    k.routines.activate(routine.id);
    await k.at(MONDAY_9AM);
    await k.at('2026-11-22T22:00:00Z');
    expect(k.snapshot().runs.map((r) => r.status)).toEqual(['skipped', 'working']);
    expect(k.snapshot().runs[0]!.reason).toMatch(/was still going/);

    k.routines.update(routine.id, digest({ concurrency: 'queue' }));
    await k.at('2026-11-29T22:00:00Z');
    expect(k.snapshot().runs[0]).toMatchObject({ status: 'scheduled' });
    expect(k.snapshot().runs[0]!.reason).toMatch(/Waiting for the run/);
    // The first one ends, and the one in line starts.
    k.routines.cancelRun(k.snapshot().runs.at(-1)!.id);
    await k.routines.tick();
    await k.routines.idle();
    expect(k.snapshot().runs.map((r) => r.status)).toEqual(['working', 'skipped', 'cancelled']);
  });

  it('never run twice for one time, whatever the clock does', async () => {
    const k = await kit(buzz);
    const routine = k.routines.create(k.project.id, digest());
    k.routines.activate(routine.id);
    await k.at(MONDAY_9AM);
    // The clock is set back an hour, and comes round to 09:00 again.
    k.routines.activate(routine.id);
    await k.at('2026-11-15T21:00:00Z');
    await k.at(MONDAY_9AM);
    expect(k.snapshot().runs).toHaveLength(1);
  });

  it('use inputs changed for one upcoming run, and the defaults after it', async () => {
    const k = await kit();
    const routine = k.routines.create(k.project.id, announce());
    k.routines.activate(routine.id);
    k.routines.planRun(routine.id, new Date(FRIDAY_1PM), { message: 'Closed this Friday.' });
    await k.at(FRIDAY_1PM);
    expect(k.snapshot().runs[0]!.actions[0]!.text).toBe('Closed this Friday.');
    k.routines.cancelRun(k.snapshot().runs[0]!.id);
    await k.at('2026-11-20T02:00:00Z');
    expect(k.snapshot().runs[0]!.actions[0]!.text).toBe('Longboards are 20% off all weekend.');
  });

  it('pause the routine after three failures in a row', async () => {
    const k = await kit(
      {},
      { answer: (seen) => (seen.method === 'POST' ? json({ error: 'No.' }, 400) : undefined) },
    );
    const routine = k.routines.create(k.project.id, announce({ schedule: 'every day at 1pm' }));
    k.routines.activate(routine.id);
    for (const day of ['12', '13', '14']) {
      await k.at(`2026-11-${day}T02:00:00Z`);
      await k.routines.approveRun(k.snapshot().runs[0]!.id);
      await k.at(`2026-11-${day}T06:00:00Z`);
    }
    expect(k.snapshot().runs.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    expect(k.snapshot().routines[0]).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(k.snapshot().routines[0]!.pausedReason).toMatch(/last 3 runs failed/);
    expect(k.notices.at(-1)).toMatchObject({ kind: 'paused' });
  });

  it('stop for everything while routines are paused, and owe nothing afterwards', async () => {
    const k = await kit();
    const routine = k.routines.create(k.project.id, announce());
    k.routines.activate(routine.id);
    k.context.settings.update({ routinesPaused: true });
    await k.at(FRIDAY_1PM);
    expect(k.snapshot()).toMatchObject({ paused: true, runs: [], coming: [] });
    k.set('2026-11-14T00:00:00Z');
    k.context.settings.update({ routinesPaused: false });
    await k.routines.tick();
    expect(k.snapshot().runs).toHaveLength(0);
    expect(k.routines.routine(routine.id).nextRunAt!.toISOString()).toBe(
      '2026-11-20T02:00:00.000Z',
    );
  });
});

describe('events', () => {
  const notes = (trigger: Record<string, unknown>) => ({
    name: 'Announce it',
    trigger,
    steps: [
      {
        id: 'post',
        action: {
          integration: 'poster',
          operation: 'create_post',
          at: '+1h',
          payload: { text: 'Out now: {{event.tag}}{{event.key}}' },
        },
      },
    ],
  });

  it('start a routine when a tag that matches appears', async () => {
    let tags = ['v0.9.0'];
    const k = await kit({}, { tags: () => tags });
    const routine = k.routines.create(
      k.project.id,
      notes({ kind: 'event', event: 'git.tag', match: 'v*' }),
    );
    k.routines.activate(routine.id);
    // What's there already isn't news.
    await k.routines.pollTags();
    tags = ['v0.9.0', 'nightly-3', 'v1.0.0'];
    await k.routines.pollTags();
    await k.routines.idle();
    const runs = k.snapshot().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: { kind: 'event', event: { name: 'git.tag', detail: { tag: 'v1.0.0' } } },
    });
    expect(runs[0]!.actions[0]!.text).toBe('Out now: v1.0.0');
    expect(k.snapshot().routines[0]!.triggerText).toBe(
      "When a new tag appears in the project's repository (pattern v*)",
    );
  });

  it('start a routine when a ticket of the type it waits for is done', async () => {
    const k = await kit({
      'buzz ticket': [
        [call('submit_output', { type: 'campaign', title: 'x', plan: '## Goal\nx', posts: [] })],
      ],
    });
    const routine = k.routines.create(
      k.project.id,
      notes({ kind: 'event', event: 'ticket.done', filters: { type: 'campaign' } }),
    );
    k.routines.activate(routine.id);
    const ticket = k.board.addTicket({
      projectId: k.project.id,
      title: 'Plan the launch',
      type: 'campaign',
      description: '',
      criteria: [],
      stories: [],
      assignee: null,
    });
    await until(() => columnOf(k.board.ticket(ticket.id)) === 'ready', 'it is signed off');
    expect(k.snapshot().runs).toHaveLength(0);
    await k.board.approve(ticket.id);
    await k.routines.idle();
    expect(k.snapshot().runs[0]!.actions[0]!.text).toBe('Out now: SURF-1');
  });

  it('start a routine when another one finishes, and never itself in a circle', async () => {
    const k = await kit();
    const first = k.routines.create(k.project.id, announce());
    const after = k.routines.create(k.project.id, {
      ...notes({ kind: 'event', event: 'routine.finished', filters: { status: 'done' } }),
      name: 'Afterwards',
    });
    k.routines.activate(first.id);
    k.routines.activate(after.id);
    await k.at(FRIDAY_1PM);
    await k.routines.approveRun(k.snapshot().runs[0]!.id);
    await k.at(FRIDAY_5PM);
    await k.routines.idle();
    const runs = k.snapshot().runs;
    expect(runs.map((r) => [r.routineName, r.status])).toEqual([
      ['Afterwards', 'awaiting_approval'],
      ['Friday shout', 'done'],
    ]);
    // Its own finish doesn't start it again.
    k.routines.cancelRun(runs[0]!.id);
    await k.routines.idle();
    expect(k.snapshot().runs).toHaveLength(2);
  });
});

describe("the crew's routine tools", () => {
  const toolParts = (k: Kit, id: string) =>
    k.chat
      .get(id)
      .messages.flatMap((m) => m.parts)
      .filter((p): p is ToolPart => p.type === 'tool');

  it('let Atlas draft a routine, which only the user can turn on', async () => {
    const k = await kit({
      'atlas chat': [
        [call('routine_list', {})],
        [
          // Buzz makes campaigns, not designs: the draft is turned back, saying so.
          call('routine_propose', {
            name: 'Weekend promo',
            schedule: 'every friday at 1pm',
            steps: [{ id: 'banner', ticket: { clank: 'buzz', type: 'design', title: 'Banner' } }],
          }),
        ],
        [
          call('routine_propose', {
            name: 'Weekend promo',
            schedule: 'every Friday at 1pm',
            inputs: { offer: '20% off longboards' },
            // As a small model writes a list: JSON inside a string.
            steps: JSON.stringify([
              {
                id: 'copy',
                ticket: { clank: 'buzz', type: 'campaign', title: 'Post for {{inputs.offer}}' },
              },
              {
                id: 'publish',
                depends_on: ['copy'],
                action: {
                  integration: 'poster',
                  operation: 'create_post',
                  at: '17:00',
                  payload: { text: '{{steps.copy.output.posts[0].text}}' },
                },
              },
            ]),
          }),
        ],
        say('I drafted a routine for you to look over and activate.'),
      ],
    });
    const { conversation } = k.chat.start(
      'atlas',
      'Every Friday, have Buzz write a promo post and post it at 5pm.',
      null,
      k.project.id,
    );
    await until(() => !k.chat.get(conversation.id).conversation.replying, 'the reply is done');
    const [list, refused, proposed] = toolParts(k, conversation.id);
    expect(list!.result).toBe('This project has no routines yet.');
    expect(refused).toMatchObject({ status: 'failed' });
    expect(refused!.result).toMatch(/Buzz doesn't make design tickets/);
    expect(proposed).toMatchObject({ status: 'done', decidedBy: 'policy' });
    expect(proposed!.result).toMatch(/Drafted "Weekend promo" \[routine [0-9a-f-]{36}\]/);
    expect(proposed!.result).toMatch(/publish: goes out at 17:00, once Sam has approved it/);

    const [draft] = k.snapshot().routines;
    expect(draft).toMatchObject({
      status: 'draft',
      createdBy: 'atlas',
      conversationId: conversation.id,
      nextRunAt: null,
    });
    expect(k.snapshot().needs).toMatchObject([{ kind: 'draft', routineId: draft!.id }]);
    // Nothing a clank has can turn it on, and a draft never runs.
    const atlas = await k.context.tools.forChat(k.context.crew.get('atlas'), {
      workspace: false,
      project: true,
      projectId: k.project.id,
    });
    expect([...atlas.specs.keys()].filter((name) => name.startsWith('routine_')).sort()).toEqual([
      'routine_get',
      'routine_list',
      'routine_propose',
    ]);
    await k.at(FRIDAY_1PM);
    expect(k.snapshot().runs).toHaveLength(0);
  });

  it('keep a change to a routine that is on beside it, until the user takes it', async () => {
    const k = await kit({
      'buzz chat': [
        [
          call('routine_propose', {
            ...announce({ schedule: 'every friday at 2pm' }),
            routine: 'Friday shout',
          }),
        ],
        say('Proposed.'),
      ],
    });
    const live = k.routines.create(k.project.id, announce());
    k.routines.activate(live.id);
    const { conversation } = k.chat.start('buzz', 'Move it to 2pm.', null, k.project.id);
    await until(() => !k.chat.get(conversation.id).conversation.replying, 'the reply is done');
    const routines = k.snapshot().routines;
    expect(routines.map((r) => [r.status, r.triggerText, r.replaces])).toEqual([
      ['active', 'Fridays at 13:00 (Australia/Sydney)', null],
      ['draft', 'Fridays at 14:00 (Australia/Sydney)', live.id],
    ]);
    k.routines.activate(routines[1]!.id);
    expect(k.snapshot().routines.map((r) => [r.id, r.status, r.triggerText])).toEqual([
      [live.id, 'active', 'Fridays at 14:00 (Australia/Sydney)'],
    ]);
  });
});

describe('a campaign', () => {
  it('has its approved posts scheduled, each going out at its time', async () => {
    const k = await kit({
      'buzz ticket': [
        [
          call('submit_output', {
            type: 'campaign',
            title: 'Launch',
            plan: '## Goal and metric\nx',
            posts: [
              { channel: 'Poster', at: '2026-11-14T09:00:00+11:00', text: 'We open on Saturday.' },
              { channel: 'Poster', text: 'No time on this one.' },
              { channel: 'Carrier pigeon', at: 'tomorrow at 9am', text: 'Coo.' },
            ],
          }),
        ],
      ],
    });
    const ticket = k.board.addTicket({
      projectId: k.project.id,
      title: 'Plan the launch',
      type: 'campaign',
      description: '',
      criteria: [],
      stories: [],
      assignee: null,
    });
    await until(() => columnOf(k.board.ticket(ticket.id)) === 'ready', 'it is signed off');
    await expect(k.routines.scheduleCampaign(ticket.id, [0])).rejects.toThrow(
      /Approve the campaign first/,
    );
    await k.board.approve(ticket.id);
    const plan = k.routines.campaignPlan(ticket.id);
    expect(plan.map((p) => p.problems)).toEqual([
      [],
      ['It names no time.'],
      ['No integration posts to Carrier pigeon.'],
    ]);
    expect(plan[0]).toMatchObject({
      integrationId: 'poster',
      operationId: 'create_post',
      connectionLabel: '@surfshop',
    });
    expect(await k.routines.scheduleCampaign(ticket.id, [0])).toBe(1);
    expect(k.snapshot().actions[0]).toMatchObject({
      status: 'approved',
      source: 'SURF-1: Plan the launch',
      text: 'We open on Saturday.',
    });
    expect(k.routines.campaignPlan(ticket.id)[0]!.problems).toEqual(['It is scheduled already.']);
    await k.at('2026-11-13T22:00:00Z');
    expect(k.service.posts().map((p) => p.body)).toEqual([{ text: 'We open on Saturday.' }]);
  });
});

describe('a routine as a file', () => {
  it('is exported as YAML and imported as a draft', async () => {
    const k = await kit();
    const routine = k.routines.create(k.project.id, announce({ description: 'Tells people.' }));
    const { yaml } = k.routines.exportYaml(routine.id);
    expect(yaml).toContain('name: Friday shout');
    expect(yaml).toContain('cron: 0 13 * * 5');
    const copy = k.routines.importYaml(k.project.id, yaml.replace('Friday shout', 'Second shout'));
    expect(copy).toMatchObject({ status: 'draft' });
    expect(copy.definition).toEqual({ ...routine.definition, name: 'Second shout' });
    expect(() => k.routines.importYaml(k.project.id, 'name: x\nsteps: []')).toThrow(/steps/);
    expect(k.routines.duplicate(routine.id).definition.name).toBe('Friday shout (copy)');
  });

  it('reads a schedule in words back before anything is saved', async () => {
    const k = await kit();
    const preview = await k.routines.previewSchedule('every weekday at 9', SYDNEY);
    expect(preview).toMatchObject({
      trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
      text: 'Every weekday at 09:00 (Australia/Sydney)',
      problem: null,
    });
    expect(preview.nextRuns).toHaveLength(5);
    const lost = await k.routines.previewSchedule('when the surf is good', SYDNEY);
    expect(lost.trigger).toBeNull();
    expect(lost.problem).toMatch(/isn't one clanks can read/);
  });
});
