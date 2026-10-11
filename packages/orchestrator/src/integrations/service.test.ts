import type { ChatRequest, ToolPart } from '@clanks/core';
import { eq } from 'drizzle-orm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, say, setup, until } from '../board/test-kit';
import { connection as connectionTable } from '../store/schema';
import { startTestOrchestrator, tempDir } from '../test-helpers';

const KEY = 'sk_test_51HabcdefGHIJKLmnopQRSTuv';
const LIVE_KEY = 'sk_live_51HabcdefGHIJKLmnopQRSTuv';

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stands in for the services integrations call, answering by host and path. */
function fakeServices(routes: Record<string, (seen: Seen) => Response> = {}) {
  const seen: Seen[] = [];
  const fake: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const request: Seen = {
      method: init?.method ?? 'GET',
      url: url.toString(),
      auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    seen.push(request);
    const route = Object.keys(routes).find((key) =>
      `${request.method} ${url.host}${url.pathname}`.startsWith(key),
    );
    if (route) return Promise.resolve(routes[route]!(request));
    if (url.host !== 'api.stripe.com') return Promise.reject(new TypeError('fetch failed'));
    if (request.auth !== `Bearer ${KEY}` && request.auth !== `Bearer ${LIVE_KEY}`) {
      return Promise.resolve(
        json({ error: { message: 'Invalid API Key provided: sk_test_****' } }, 401),
      );
    }
    if (url.pathname === '/v1/account') {
      return Promise.resolve(
        json({ id: 'acct_1', settings: { dashboard: { display_name: 'Surf Shop' } } }),
      );
    }
    if (url.pathname === '/v1/products' && request.method === 'GET') {
      return Promise.resolve(
        json({ object: 'list', has_more: false, data: [{ id: 'prod_1', name: 'Longboard' }] }),
      );
    }
    if (url.pathname === '/v1/refunds' && request.method === 'POST') {
      return Promise.resolve(json({ id: 're_1', status: 'succeeded' }));
    }
    return Promise.resolve(json({ error: { message: `No such route: ${url.pathname}` } }, 404));
  };
  return { fetch: fake, seen };
}

const toolParts = (context: Awaited<ReturnType<typeof setup>>['context'], id: string) =>
  context.chat
    .get(id)
    .messages.flatMap((m) => m.parts)
    .filter((p): p is ToolPart => p.type === 'tool');

const system = (request: ChatRequest) => request.messages[0]!.content;

describe('connecting an account', () => {
  it('keeps the key in the keychain, and says which mode it is for', async () => {
    const services = fakeServices();
    const { context } = startTestOrchestrator({ integrationsFetch: services.fetch });
    const connection = await context.integrations.connect({ integrationId: 'stripe', secret: KEY });
    expect(connection).toMatchObject({
      integrationId: 'stripe',
      mode: 'test',
      account: 'Surf Shop',
      label: 'Surf Shop (test)',
      authType: 'api_key',
      newHosts: [],
    });
    // It was checked against the service before it was saved.
    expect(services.seen[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.stripe.com/v1/account',
      auth: `Bearer ${KEY}`,
    });
    expect(context.secrets.refs()).toContain(`integration:${connection.id}`);
    // Not in the database, and not in anything the window is sent.
    expect(JSON.stringify(context.store.db.select().from(connectionTable).all())).not.toContain(
      KEY,
    );
    expect(JSON.stringify(context.integrations.snapshot())).not.toContain(KEY);

    const live = await context.integrations.connect({ integrationId: 'stripe', secret: LIVE_KEY });
    expect(live).toMatchObject({ mode: 'live', label: 'Surf Shop (live)' });
    // Stripe's keys say which they are, so it isn't for the user to say otherwise.
    expect(() => context.integrations.setMode(live.id, 'test')).toThrow(/says which mode/);

    context.integrations.disconnect(connection.id);
    expect(context.secrets.refs()).not.toContain(`integration:${connection.id}`);
    expect(
      context.integrations.snapshot().integrations.find((i) => i.id === 'stripe')!.connections,
    ).toHaveLength(1);
  });

  it('saves nothing the service turns down', async () => {
    const { context } = startTestOrchestrator({ integrationsFetch: fakeServices().fetch });
    await expect(
      context.integrations.connect({ integrationId: 'stripe', secret: 'sk_test_wrongwrongwrong' }),
    ).rejects.toThrow(/^Stripe turned it down: Invalid API Key provided: sk_test_\*\*\*\*$/);
    await expect(
      context.integrations.connect({ integrationId: 'stripe', secret: 'whatever-this-is' }),
    ).rejects.toThrow(/doesn't look like a Stripe secret key: it would start with sk_test_/);
    await expect(
      context.integrations.connect({ integrationId: 'stripe', secret: '' }),
    ).rejects.toThrow(/Paste the Secret key first/);
    expect(context.secrets.refs()).toEqual([]);
    expect(context.store.db.select().from(connectionTable).all()).toEqual([]);
  });

  it('treats an account as the real one unless the user says it is a test', async () => {
    const services = fakeServices({
      'POST slack.com/api/auth.test': () => json({ ok: true, team: 'Surf Crew' }),
    });
    const { context } = startTestOrchestrator({ integrationsFetch: services.fetch });
    const real = await context.integrations.connect({
      integrationId: 'slack',
      secret: 'xoxb-1-abc',
    });
    expect(real).toMatchObject({ mode: 'live', account: 'Surf Crew' });
    context.integrations.setMode(real.id, 'test');
    expect(
      context.integrations.snapshot().integrations.find((i) => i.id === 'slack')!.connections[0]!
        .mode,
    ).toBe('test');
  });

  it('signs in with OAuth in the user’s browser, and renews the token when it runs out', async () => {
    let issued = 0;
    const services = fakeServices({
      'POST oauth2.googleapis.com/token': (seen) => {
        const form = new URLSearchParams(seen.body);
        issued++;
        return form.get('grant_type') === 'authorization_code'
          ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
          : json({ access_token: `at-${issued}`, expires_in: 3600 });
      },
      'GET analyticsadmin.googleapis.com/v1beta/accountSummaries': (seen) =>
        seen.auth?.startsWith('Bearer at-')
          ? json({ accountSummaries: [{ displayName: 'Surf Shop GA' }] })
          : json({ error: { message: 'Unauthenticated' } }, 401),
      'POST analyticsdata.googleapis.com/v1beta/properties/123:runReport': () =>
        json({ rows: [{ metricValues: [{ value: '42' }] }] }),
    });
    const { context, project, chat } = await setup(
      {
        'gauge chat': [
          [
            call('int_google_analytics_run_report', {
              property: '123',
              dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
              metrics: [{ name: 'activeUsers' }],
            }),
          ],
          say('42 active users.'),
        ],
      },
      { crew: ['gauge'], orchestrator: { integrationsFetch: services.fetch } },
    );
    const pending = await context.integrations.startOAuth({
      integrationId: 'google_analytics',
      clientId: 'client-1',
      clientSecret: 'client-secret',
    });
    const page = new URL(pending.url);
    const redirect = page.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(context.integrations.snapshot().oauth?.integrationId).toBe('google_analytics');

    // Something else on the computer that guesses the address can't finish the sign-in.
    const forged = await fetch(`${redirect}?code=stolen&state=guess`);
    expect(forged.status).toBe(400);
    expect(context.integrations.snapshot().oauth).not.toBeNull();

    const back = await fetch(`${redirect}?code=code-1&state=${page.searchParams.get('state')}`);
    expect(await back.text()).toContain('Connected');
    const connections = () =>
      context.integrations.snapshot().integrations.find((i) => i.id === 'google_analytics')!
        .connections;
    await until(() => connections().length === 1, 'the account is connected');
    expect(connections()[0]).toMatchObject({ account: 'Surf Shop GA', authType: 'oauth2' });
    expect(context.integrations.snapshot().oauth).toBeNull();
    const exchange = new URLSearchParams(services.seen[0]!.body);
    expect(exchange.get('code')).toBe('code-1');
    expect(exchange.get('code_verifier')).toMatch(/^[\w-]{40,}$/);
    expect(JSON.stringify(context.integrations.snapshot())).not.toContain('at-1');

    // An hour on, the access token has run out: it's renewed before the next call.
    const [connection] = connections();
    context.store.db
      .update(connectionTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(connectionTable.id, connection!.id))
      .run();
    context.integrations.setProject(project.id, connection!.id, ['gauge']);
    const { conversation } = chat.start('gauge', 'How many users?', null, project.id);
    await until(() => !chat.get(conversation.id).conversation.replying, 'the reply is done');
    const [report] = toolParts(context, conversation.id);
    // A report is asked for with a POST, but it only reads, so it runs without asking.
    expect(report).toMatchObject({ status: 'done', decidedBy: 'policy' });
    expect(report!.result).toContain('"value": "42"');
    const calls = services.seen.slice(-2);
    expect(new URLSearchParams(calls[0]!.body).get('grant_type')).toBe('refresh_token');
    expect(calls[1]!.auth).toBe('Bearer at-2');

    // A later version of the integration that renews somewhere else gets no refresh token there.
    context.store.db
      .update(connectionTable)
      .set({ expiresAt: new Date(Date.now() - 1000), hosts: ['analyticsdata.googleapis.com'] })
      .where(eq(connectionTable.id, connection!.id))
      .run();
    const asked = services.seen.length;
    const later = chat.start('gauge', 'And now?', null, project.id);
    await until(() => !chat.get(later.conversation.id).conversation.replying, 'the reply is done');
    expect(toolParts(context, later.conversation.id)[0]).toMatchObject({ status: 'failed' });
    expect(toolParts(context, later.conversation.id)[0]!.result).toMatch(
      /renews its sign-in at oauth2\.googleapis\.com, which it didn't when the account was connected/,
    );
    expect(services.seen.length).toBe(asked);
  });
});

describe('a clank using a connected service', () => {
  const scripts = {
    'gauge chat': [
      [call('int_stripe_list_products', { limit: 2 })],
      [call('int_stripe_create_refund', { payment_intent: 'pi_1', amount: 500 })],
      say('Refunded $5.'),
    ],
  };

  it('gets its tools only where it is turned on, reads freely and asks before a change', async () => {
    const services = fakeServices();
    const { context, project, chat, fake, folder } = await setup(scripts, {
      crew: ['forge', 'gauge'],
      orchestrator: { integrationsFetch: services.fetch },
    });
    const connection = await context.integrations.connect({ integrationId: 'stripe', secret: KEY });
    const offered = async (clankId: string, projectId: string | null) =>
      [
        ...(
          await context.tools.forChat(context.crew.get(clankId), { workspace: true, projectId })
        ).specs.keys(),
      ].filter((name) => name.startsWith('int_'));
    // Connected, but not turned on anywhere yet.
    expect(await offered('gauge', project.id)).toEqual([]);
    context.integrations.setProject(project.id, connection.id, ['gauge']);
    expect((await offered('gauge', project.id)).length).toBe(19);
    expect(await offered('forge', project.id)).toEqual([]);
    expect(await offered('gauge', null)).toEqual([]);
    expect(context.board.snapshot(project.id).integrations).toEqual([
      {
        connectionId: connection.id,
        integrationId: 'stripe',
        name: 'Stripe',
        label: 'Surf Shop (test)',
        mode: 'test',
        clanks: ['gauge'],
      },
    ]);

    const { conversation } = chat.start('gauge', 'Refund the last order', null, project.id);
    await until(
      () => toolParts(context, conversation.id).some((p) => p.status === 'asking'),
      'the refund asks',
    );
    const [list, refund] = toolParts(context, conversation.id);
    // The read ran without asking.
    expect(list).toMatchObject({
      status: 'done',
      decidedBy: 'policy',
      label: 'Calling Stripe: `list_products`',
    });
    expect(list!.result).toContain('Longboard');
    expect(list!.result).not.toContain(KEY);
    // The change waits, and the approval says which account, in which mode, and exactly what.
    expect(refund!.approval).toEqual({
      kind: 'tool',
      subject: 'POST https://api.stripe.com/v1/refunds\npayment_intent = pi_1\namount = 500',
      pattern: '*',
      scope: folder,
      reason: 'It changes data in Stripe (Surf Shop (test), test mode)',
      integration: {
        name: 'Stripe',
        account: 'Surf Shop (test)',
        mode: 'test',
        host: 'api.stripe.com',
        risk: 'write',
      },
    });
    expect(services.seen.filter((s) => s.method === 'POST')).toEqual([]);

    // On a test account a refund is a write, so it can be allowed for good in this project.
    chat.decide(conversation.id, refund!.id, { decision: 'always', pattern: '*' });
    await until(() => !chat.get(conversation.id).conversation.replying, 'the reply is done');
    expect(toolParts(context, conversation.id)[1]).toMatchObject({
      status: 'done',
      decidedBy: 'user',
    });
    expect(services.seen.at(-1)).toMatchObject({
      method: 'POST',
      url: 'https://api.stripe.com/v1/refunds',
      auth: `Bearer ${KEY}`,
      body: 'payment_intent=pi_1&amount=500',
    });
    expect(context.tools.rules().map((r) => [r.tool, r.pattern])).toEqual([
      ['int_stripe_create_refund', '*'],
    ]);
    const again = chat.start('gauge', 'And the one before', null, project.id);
    await until(() => !chat.get(again.conversation.id).conversation.replying, 'the reply is done');
    expect(toolParts(context, again.conversation.id).map((p) => [p.status, p.decidedBy])).toEqual([
      ['done', 'policy'],
      ['done', 'rule'],
    ]);

    // What Gauge was told: the account, its mode and the integration's guide. Never the key.
    const prompt = system(fake.requests[0]!);
    expect(prompt).toContain('## Connected services');
    expect(prompt).toContain('Tools whose names start with `int_` call services Sam connected');
    expect(prompt).toContain('### Stripe: test mode');
    expect(prompt).toContain('Account: Surf Shop (test). Tools: `int_stripe_get_account`');
    expect(prompt).toContain('In test mode no money moves.');
    expect(prompt).toContain(
      'Connected services: Stripe, test mode (account "Surf Shop (test)"), for Gauge.',
    );
    expect(JSON.stringify(fake.requests)).not.toContain(KEY);
  });

  it('asks every time on a live account, whatever is allowed elsewhere', async () => {
    const services = fakeServices();
    const { context, project, chat } = await setup(
      {
        'gauge chat': [
          [call('int_stripe_create_refund', { payment_intent: 'pi_1' })],
          say('Refunded.'),
        ],
      },
      { crew: ['gauge'], orchestrator: { integrationsFetch: services.fetch } },
    );
    const live = await context.integrations.connect({ integrationId: 'stripe', secret: LIVE_KEY });
    context.integrations.setProject(project.id, live.id, ['gauge']);
    // The user tries to allow it on the clank's profile: it can be denied or turned off, not allowed.
    context.tools.setPolicy('gauge', 'int_stripe_create_refund', 'allow');
    const policy = context.tools
      .policies('gauge')
      .find((p) => p.name === 'int_stripe_create_refund')!;
    expect(policy).toMatchObject({ group: 'integration', level: 'ask', locked: true });
    // Even an ordinary write is locked on the real account, and a read still isn't.
    expect(
      context.tools.policies('gauge').find((p) => p.name === 'int_stripe_create_product'),
    ).toMatchObject({ level: 'ask', locked: true });
    expect(
      context.tools.policies('gauge').find((p) => p.name === 'int_stripe_list_products'),
    ).toMatchObject({ level: 'allow' });

    for (const attempt of [1, 2]) {
      const { conversation } = chat.start('gauge', `Refund ${attempt}`, null, project.id);
      await until(
        () => toolParts(context, conversation.id).some((p) => p.status === 'asking'),
        'it asks',
      );
      const [refund] = toolParts(context, conversation.id);
      expect(refund!.approval).toMatchObject({
        // Nowhere to remember an "always allow", so the window offers none.
        scope: null,
        reason:
          'It can spend money, publish, delete or contact people through Stripe (Surf Shop (live), live mode)',
        integration: { mode: 'live', risk: 'outbound' },
      });
      // Even if "always" were sent, nothing is remembered.
      chat.decide(conversation.id, refund!.id, { decision: 'always', pattern: '*' });
      await until(() => !chat.get(conversation.id).conversation.replying, 'the reply is done');
    }
    expect(context.tools.rules()).toEqual([]);

    // Denied, it isn't called at all.
    context.tools.setPolicy('gauge', 'int_stripe_create_refund', 'deny');
    const { conversation } = chat.start('gauge', 'Refund 3', null, project.id);
    await until(() => !chat.get(conversation.id).conversation.replying, 'the reply is done');
    expect(toolParts(context, conversation.id)[0]).toMatchObject({ status: 'denied' });
    expect(services.seen.filter((s) => s.url.endsWith('/v1/refunds'))).toHaveLength(2);
  });
});

describe('an integration of the user’s own', () => {
  const files = (id = 'shopadmin') => ({
    'manifest.yaml': `
id: ${id}
name: Shop admin
summary: The surf shop's own admin API, on the dev server.
hosts: ["localhost:4010"]
auth: { type: api_key, header: X-Admin-Key, format: "{secret}" }
openapi: openapi.yaml
operations:
  - { id: list_orders, op: "GET /orders", risk: read }
  - { id: cancel_order, op: "DELETE /orders/{id}", risk: outbound, test: write }
guide: guide.md
`,
    'openapi.yaml': `
openapi: 3.0.3
servers: [{ url: "http://localhost:4010" }]
paths:
  /orders:
    get: { summary: List orders. }
  /orders/{id}:
    delete: { summary: Cancel an order. }
`,
    'guide.md': 'Orders are numbered from 1000.\n',
  });

  function folder(contents: Record<string, string>): string {
    const dir = join(tempDir(), 'integration');
    mkdirSync(dir);
    for (const [name, text] of Object.entries(contents)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it('is added from a folder, and may call this computer', async () => {
    const services = fakeServices({
      'GET localhost:4010/orders': () => json([{ id: 1000 }]),
    });
    const { context, project, chat } = await setup(
      { 'forge chat': [[call('int_shopadmin_list_orders', {})], say('One order.')] },
      { crew: ['forge'], orchestrator: { integrationsFetch: services.fetch } },
    );
    expect(await context.integrations.addFromFolder(folder(files()))).toBe('shopadmin');
    const info = context.integrations.snapshot().integrations.find((i) => i.id === 'shopadmin')!;
    expect(info).toMatchObject({ source: 'local', hosts: ['localhost:4010'], version: null });
    expect(info.operations.map((o) => [o.tool, o.risk, o.testRisk])).toEqual([
      ['int_shopadmin_list_orders', 'read', 'read'],
      ['int_shopadmin_cancel_order', 'outbound', 'write'],
    ]);
    const connection = await context.integrations.connect({
      integrationId: 'shopadmin',
      secret: 'dev-admin-key',
      mode: 'test',
    });
    context.integrations.setProject(project.id, connection.id, ['forge']);
    const { conversation } = chat.start('forge', 'Any orders?', null, project.id);
    await until(() => !chat.get(conversation.id).conversation.replying, 'the reply is done');
    expect(toolParts(context, conversation.id)[0]!.result).toContain('1000');
    expect(services.seen.at(-1)!.url).toBe('http://localhost:4010/orders');

    // It can't take the place of one that ships with the app.
    await expect(context.integrations.addFromFolder(folder(files('stripe')))).rejects.toThrow(
      /Stripe ships with the app under the id stripe/,
    );
    await expect(context.integrations.addFromFolder(tempDir())).rejects.toThrow(
      /no manifest\.yaml in that folder/,
    );
    // Removing it takes its account, and its key, with it.
    await context.integrations.uninstall('shopadmin');
    expect(context.integrations.has('shopadmin')).toBe(false);
    expect(context.secrets.refs()).toEqual([]);
    expect(context.board.snapshot(project.id).integrations).toEqual([]);
  });
});
