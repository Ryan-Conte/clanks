import type { ToolContext, ToolSpec } from '@clanks/tools';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authorizeUrl, exchangeCode, pkcePair, refreshTokens } from './auth';
import { integrationsLayer } from './guide';
import {
  type DeclarativeIntegration,
  type IntegrationFiles,
  loadIntegration,
  mcpCommand,
} from './load';
import { GUIDE_FILE, MANIFEST_FILE, OPENAPI_FILE, detectMode, parseManifest } from './manifest';
import { type Credential, isPrivateAddress } from './request';
import { fakeApi, json } from './test/api';
import { type ToolConnection, integrationTools, parseArgs } from './tools';

const bundledDir = fileURLToPath(new URL('../../../integrations', import.meta.url));

function bundled(id: string): IntegrationFiles {
  const read = (file: string) => {
    const path = join(bundledDir, id, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  return { manifest: read(MANIFEST_FILE)!, openapi: read(OPENAPI_FILE), guide: read(GUIDE_FILE) };
}

function declarative(files: IntegrationFiles, allowLocal = false): DeclarativeIntegration {
  const integration = loadIntegration(files, { allowLocal });
  if (integration.kind !== 'declarative') throw new Error('Expected a declarative integration');
  return integration;
}

const KEY = 'sk_test_51HabcdefGHIJKLmnopQRSTuv';

function connection(overrides: Partial<ToolConnection> = {}): ToolConnection {
  const credential: Credential = { kind: 'api_key', secret: KEY };
  return {
    id: 'c1',
    label: 'Surf shop',
    mode: 'test',
    settings: {},
    hosts: ['api.stripe.com'],
    allowLocal: false,
    credential: () => Promise.resolve(credential),
    ...overrides,
  };
}

function context(): ToolContext {
  return {
    workspace: null,
    shell: null,
    web: { fetch, search: null },
    browser: null,
    board: null,
    context: null,
    design: null,
    signal: new AbortController().signal,
    clank: { id: 'gauge', name: 'Gauge' },
    maxChars: 8000,
  };
}

function tool(tools: ToolSpec<Record<string, unknown>>[], name: string) {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`No tool called ${name}`);
  return found;
}

const call = (spec: ToolSpec<Record<string, unknown>>, raw: unknown) =>
  spec.run(spec.parse(raw), context());

/** A small made-up service, for what the shipped integrations don't exercise. */
const widgets = (
  extra = '',
  operations = '  - { id: list_widgets, op: "GET /widgets", risk: read }',
) => ({
  manifest: `
id: widgets
name: Widgets
summary: A made-up service.
hosts: [api.widgets.example]
auth: { type: api_key, header: X-Api-Key, format: "{secret}" }
${extra}
operations:
${operations}
`,
  openapi: `
openapi: 3.0.3
servers: [{ url: "https://api.widgets.example/v2" }]
paths:
  /widgets:
    get:
      summary: List widgets.
      parameters:
        - { name: colour, in: query, schema: { type: string, enum: [red, blue] } }
        - { name: tags, in: query, schema: { type: array, items: { type: string } } }
        - { name: X-Trace, in: header, schema: { type: string } }
    post:
      summary: Make a widget.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Widget" }
  /widgets/{id}:
    get:
      summary: One widget.
    delete:
      summary: Delete a widget.
  /media:
    post:
      summary: Upload a picture.
      requestBody:
        content:
          application/json:
            schema: { type: object, properties: { url: { type: string } } }
  /posts:
    post:
      summary: Publish a post.
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                text: { type: string }
                media_ids: { type: array, items: { type: string } }
components:
  schemas:
    Widget:
      type: object
      required: [name]
      properties:
        id: { type: string, readOnly: true }
        name: { type: string, description: "What it's called." }
        size: { type: integer }
        parent: { $ref: "#/components/schemas/Widget" }
`,
});

describe('manifests', () => {
  it('reads every integration that ships with the app', () => {
    const ids = readdirSync(bundledDir).filter((id) =>
      existsSync(join(bundledDir, id, MANIFEST_FILE)),
    );
    expect(ids.length).toBeGreaterThanOrEqual(5);
    for (const id of ids) {
      const integration = loadIntegration(bundled(id));
      expect(integration.manifest.id, id).toBe(id);
      expect(integration.guide, `${id} has a guide`).not.toBe('');
      if (integration.kind !== 'declarative') continue;
      for (const operation of integration.operations) {
        expect(operation.tool.length, operation.tool).toBeLessThanOrEqual(64);
        expect(operation.summary, operation.tool).not.toBe('');
      }
      // Something to prove a credential works, and a read to do it with.
      expect(integration.manifest.check, `${id} has a check`).toBeDefined();
    }
  });

  it('refuses hosts on this computer and bare addresses, unless the user wrote it themselves', () => {
    const local = widgets().manifest.replace('api.widgets.example', 'localhost:4010');
    expect(() => parseManifest(local)).toThrow(/on this computer/);
    expect(() => parseManifest(local.replace('localhost:4010', '10.0.0.5'))).toThrow(
      /on this computer or an address/,
    );
    expect(parseManifest(local, { allowLocal: true }).hosts).toEqual(['localhost:4010']);
    expect(() => parseManifest(local.replace('localhost:4010', 'not a host'))).toThrow(
      /isn't a host name/,
    );
  });

  it('refuses an API that is somewhere other than its declared hosts', () => {
    const files = widgets();
    expect(() =>
      loadIntegration({
        ...files,
        openapi: files.openapi.replace('api.widgets.example/v2', 'evil.example/v2'),
      }),
    ).toThrow(/evil\.example, which isn't one of the hosts/);
    expect(() =>
      loadIntegration({
        ...files,
        openapi: files.openapi.replace('https://api.widgets', 'http://api.widgets'),
      }),
    ).toThrow(/must be an https/);
  });

  it('says what is wrong with an operation', () => {
    const bad = (operations: string) => () => loadIntegration(widgets('', operations));
    expect(bad('  - { id: nope, op: "GET /missing", risk: read }')).toThrow(/no GET \/missing/);
    expect(
      bad(
        '  - { id: a, op: "GET /widgets", risk: read }\n  - { id: a, op: "POST /widgets", risk: write }',
      ),
    ).toThrow(/Two operations are called a/);
    expect(bad('  - { id: make, op: "POST /widgets", risk: write, verify: make }')).toThrow(
      /must be one of its read operations/,
    );
    expect(bad('  - { id: list, op: "GET /widgets", risk: read, test: write }')).toThrow(
      /can't be higher/,
    );
    expect(() => loadIntegration(widgets('headers: { Cookie: "a=b" }'))).toThrow(/Cookie header/);
    expect(() => loadIntegration({ ...widgets(), guide: 'word '.repeat(400) })).toThrow(
      /keep it under 300/,
    );
  });

  it('tells a test key from a live one by how it starts', () => {
    const { auth } = declarative(bundled('stripe')).manifest;
    expect(detectMode(auth, KEY)).toBe('test');
    expect(detectMode(auth, 'rk_test_abc')).toBe('test');
    expect(detectMode(auth, 'sk_live_abc')).toBe('live');
    expect(detectMode(auth, 'whatever')).toBeNull();
  });
});

describe('tools from operations', () => {
  it('names them, and leaves headers and read-only fields out of their arguments', () => {
    const integration = declarative(
      widgets(
        '',
        '  - { id: list_widgets, op: "GET /widgets", risk: read }\n  - { id: make_widget, op: "POST /widgets", risk: write }',
      ),
    );
    const tools = integrationTools(integration, connection({ hosts: ['api.widgets.example'] }), {
      fetch,
    });
    expect(tools.map((t) => t.name)).toEqual([
      'int_widgets_list_widgets',
      'int_widgets_make_widget',
    ]);
    const list = tool(tools, 'int_widgets_list_widgets').parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(list.properties)).toEqual(['colour', 'tags']);
    const make = tool(tools, 'int_widgets_make_widget').parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    // The body's fields sit beside the other arguments; a schema that refers to itself is cut off.
    expect(Object.keys(make.properties)).toEqual(['name', 'size', 'parent']);
    expect(make.required).toEqual(['name']);
    expect(make.properties.parent).toEqual({});
  });

  it('reads from Stripe as the connection, and never shows the key', async () => {
    const api = fakeApi({
      'api.stripe.com': (request) =>
        json({
          object: 'list',
          has_more: false,
          // A service echoing the key back, and a field that holds a secret of its own.
          data: [
            {
              id: 'prod_1',
              name: 'Longboard',
              echo: request.headers.authorization,
              client_secret: 'pi_1_secret_x',
            },
          ],
        }),
    });
    const tools = integrationTools(declarative(bundled('stripe')), connection(), api);
    const list = tool(tools, 'int_stripe_list_products');
    expect(list.risk!({}, { worktree: null, browserUrl: null }).level).toBe('low');
    expect(list.locked).toBeUndefined();

    const result = await call(list, { limit: '3', active: 'true' });
    expect(result.error).toBeUndefined();
    const [request] = api.seen;
    expect(request!.method).toBe('GET');
    expect(request!.url.toString()).toBe('https://api.stripe.com/v1/products?limit=3&active=true');
    expect(request!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(result.content).toContain('Stripe (Surf shop, test mode) answered 200');
    expect(result.content).toContain('Longboard');
    expect(result.content).not.toContain(KEY);
    expect(result.content).toContain('[redacted]');
    expect(result.content).toContain('"client_secret": "[hidden]"');
  });

  it('writes nested fields the way a form-encoded API takes them', async () => {
    const api = fakeApi({ 'api.stripe.com': () => json({ id: 'prod_2' }) });
    const tools = integrationTools(declarative(bundled('stripe')), connection(), api);
    const create = tool(tools, 'int_stripe_create_product');
    const args = create.parse({
      name: 'Wax & co',
      // A small model writes an object as JSON in a string.
      default_price_data: '{"currency":"aud","unit_amount":1500}',
      images: ['https://example.com/a.png', 'https://example.com/b.png'],
      metadata: { sku: 'W-1' },
    });
    await create.run(args, context());
    const [request] = api.seen;
    expect(request!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(request!.body))).toEqual({
      name: 'Wax & co',
      'default_price_data[currency]': 'aud',
      'default_price_data[unit_amount]': '1500',
      'images[0]': 'https://example.com/a.png',
      'images[1]': 'https://example.com/b.png',
      'metadata[sku]': 'W-1',
    });
    // What the approval shows is the request, without the key.
    const approval = create.approval(args);
    expect(approval.subject).toContain('POST https://api.stripe.com/v1/products');
    expect(approval.subject).toContain('default_price_data[unit_amount] = 1500');
    expect(approval.subject).not.toContain(KEY);
    expect(approval.integration).toEqual({
      name: 'Stripe',
      account: 'Surf shop',
      mode: 'test',
      host: 'api.stripe.com',
      risk: 'write',
    });
  });

  it('asks about writes, and every time about anything outbound or live', () => {
    const stripe = declarative(bundled('stripe'));
    const risk = (spec: ToolSpec<Record<string, unknown>>) =>
      spec.risk!({}, { worktree: null, browserUrl: null });

    const test = integrationTools(stripe, connection(), { fetch });
    expect(risk(tool(test, 'int_stripe_create_product'))).toEqual({
      level: 'high',
      reason: 'It changes data in Stripe (Surf shop, test mode)',
    });
    expect(tool(test, 'int_stripe_create_product').locked).toBeUndefined();
    // A test charge moves no money, so it's a write there: it asks, and can be always allowed.
    expect(tool(test, 'int_stripe_confirm_payment_intent').locked).toBeUndefined();
    expect(tool(test, 'int_stripe_create_refund').approval({}).integration!.risk).toBe('write');

    const live = integrationTools(stripe, connection({ mode: 'live' }), { fetch });
    expect(tool(live, 'int_stripe_list_products').locked).toBeUndefined();
    expect(tool(live, 'int_stripe_create_refund').locked).toBe(true);
    expect(risk(tool(live, 'int_stripe_create_refund')).reason).toMatch(/spend money/);
    // On a live account even an ordinary write asks every time.
    expect(tool(live, 'int_stripe_create_product').locked).toBe(true);
    expect(risk(tool(live, 'int_stripe_create_product')).reason).toMatch(
      /live Stripe account, where every change asks/,
    );
  });

  it("escapes what goes in a path, so an argument can't reach another one", async () => {
    const api = fakeApi({ 'api.stripe.com': () => json({ id: 'pi_1' }) });
    const tools = integrationTools(declarative(bundled('stripe')), connection(), api);
    const get = tool(tools, 'int_stripe_get_payment_intent');
    await call(get, { intent: '../customers?limit=100#' });
    expect(api.seen[0]!.url.pathname).toBe('/v1/payment_intents/..%2Fcustomers%3Flimit%3D100%23');
    await expect(call(get, { intent: '..' })).rejects.toThrow(/can't be "\.\."/);
    expect(() => get.parse({})).toThrow(/`intent` is required/);
    expect(() => get.parse({ intent: 'pi_1', nope: 1 })).toThrow(
      /no argument called `nope`. This tool takes: intent/,
    );
  });

  it('says why the service turned a call down', async () => {
    const api = fakeApi({
      'api.stripe.com': (request) =>
        request.url.pathname.endsWith('/refunds')
          ? json({ error: { message: 'Charge ch_1 has already been refunded.' } }, 400)
          : json({ error: { message: 'Invalid API Key provided: sk_test_***' } }, 401),
    });
    const tools = integrationTools(declarative(bundled('stripe')), connection(), api);
    const refund = await call(tool(tools, 'int_stripe_create_refund'), { charge: 'ch_1' });
    expect(refund.error).toBe(true);
    expect(refund.content).toBe(
      'Stripe (Surf shop, test mode) turned POST /v1/refunds down (400): Charge ch_1 has already been refunded..',
    );
    const denied = await call(tool(tools, 'int_stripe_get_balance'), {});
    expect(denied.content).toMatch(/\(401\): Invalid API Key provided/);
    expect(denied.content).toMatch(/may have been revoked/);
  });

  it('warns that a change that got no answer may have happened, and how to check', async () => {
    const tools = integrationTools(declarative(bundled('stripe')), connection(), fakeApi({}));
    await expect(call(tool(tools, 'int_stripe_create_refund'), { charge: 'ch_1' })).rejects.toThrow(
      /Couldn't reach api\.stripe\.com: getaddrinfo ENOTFOUND\. It may or may not have gone through: check with int_stripe_list_refunds/,
    );
    await expect(call(tool(tools, 'int_stripe_list_refunds'), {})).rejects.toThrow(
      /^Couldn't reach api\.stripe\.com: getaddrinfo ENOTFOUND\.$/,
    );
  });
});

describe('hosts', () => {
  const twoHosts = () =>
    declarative({
      ...widgets(),
      manifest: widgets().manifest.replace(
        'hosts: [api.widgets.example]',
        'hosts: [api.widgets.example, files.widgets.example]',
      ),
    });

  it('never follows a redirect to a host the integration does not declare', async () => {
    const api = fakeApi({
      'api.widgets.example': () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    });
    const tools = integrationTools(
      twoHosts(),
      connection({ hosts: ['api.widgets.example', 'files.widgets.example'] }),
      api,
    );
    await expect(call(tool(tools, 'int_widgets_list_widgets'), {})).rejects.toThrow(
      /evil\.example isn't one of the hosts this integration declares/,
    );
    expect(api.seen.map((r) => r.url.host)).toEqual(['api.widgets.example']);
  });

  it('follows one to a declared host, without the credential', async () => {
    const api = fakeApi({
      'api.widgets.example': () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://files.widgets.example/list.json' },
        }),
      'files.widgets.example': () => json([{ id: 'w1' }]),
    });
    const tools = integrationTools(
      twoHosts(),
      connection({ hosts: ['api.widgets.example', 'files.widgets.example'] }),
      api,
    );
    const result = await call(tool(tools, 'int_widgets_list_widgets'), { tags: ['a', 'b'] });
    expect(result.content).toContain('w1');
    expect(api.seen[0]!.url.search).toBe('?tags=a&tags=b');
    expect(api.seen[0]!.headers['x-api-key']).toBe(KEY);
    expect(api.seen[1]!.headers['x-api-key']).toBeUndefined();
  });

  it('keeps a credential from hosts added since the account was connected', async () => {
    const api = fakeApi({ 'api.widgets.example': () => json([]) });
    // The connection was made when the integration only called another host.
    const tools = integrationTools(
      twoHosts(),
      connection({ hosts: ['files.widgets.example'] }),
      api,
    );
    await expect(call(tool(tools, 'int_widgets_list_widgets'), {})).rejects.toThrow(
      /api\.widgets\.example isn't one of the hosts/,
    );
    expect(api.seen).toEqual([]);
  });

  it("won't call a public name that points at this computer or the local network", async () => {
    const api = fakeApi({ 'api.widgets.example': () => json([{ id: 'w1' }]) });
    const tools = (address: string) =>
      integrationTools(declarative(widgets()), connection({ hosts: ['api.widgets.example'] }), {
        ...api,
        lookup: () => Promise.resolve([address]),
      });
    for (const address of [
      '127.0.0.1',
      '10.0.0.8',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:10.1.2.3',
    ]) {
      await expect(
        call(tool(tools(address), 'int_widgets_list_widgets'), {}),
        address,
      ).rejects.toThrow(/api\.widgets\.example points at this computer or the local network/);
    }
    expect(api.seen).toEqual([]);
    expect(
      (await call(tool(tools('93.184.216.34'), 'int_widgets_list_widgets'), {})).content,
    ).toContain('w1');
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('calls this computer only for an integration the user wrote', async () => {
    const files = widgets();
    const local = {
      manifest: files.manifest.replace('api.widgets.example', 'localhost:4010'),
      openapi: files.openapi.replace('https://api.widgets.example/v2', 'http://localhost:4010'),
    };
    expect(() => loadIntegration(local)).toThrow(/on this computer/);
    const api = fakeApi({ 'localhost:4010': () => json([{ id: 'w1' }]) });
    const tools = integrationTools(
      declarative(local, true),
      connection({ hosts: ['localhost:4010'], allowLocal: true }),
      // Its own computer is where it's meant to go, whatever the name resolves to.
      { ...api, lookup: () => Promise.resolve(['127.0.0.1']) },
    );
    expect((await call(tool(tools, 'int_widgets_list_widgets'), {})).content).toContain('w1');
    // The same manifest, were it to come from a marketplace, would be refused at the request too.
    const strict = integrationTools(
      declarative(local, true),
      connection({ hosts: ['localhost:4010'] }),
      api,
    );
    await expect(call(tool(strict, 'int_widgets_list_widgets'), {})).rejects.toThrow(
      /only call https addresses/,
    );
  });
});

describe('other ways of signing', () => {
  it('sends a key in the query, basic auth, and static headers', async () => {
    const api = fakeApi({ 'api.widgets.example': () => json([]) });
    const query = declarative(widgets('headers: { X-Version: "2" }'));
    query.manifest.auth = { type: 'api_key', in: 'query', name: 'key', format: '{secret}' };
    await call(
      tool(
        integrationTools(query, connection({ hosts: ['api.widgets.example'] }), api),
        'int_widgets_list_widgets',
      ),
      {},
    );
    expect(api.seen[0]!.url.searchParams.get('key')).toBe(KEY);
    expect(api.seen[0]!.headers['x-version']).toBe('2');

    const basic = declarative(widgets());
    basic.manifest.auth = { type: 'basic' };
    await call(
      tool(
        integrationTools(
          basic,
          connection({
            hosts: ['api.widgets.example'],
            credential: () =>
              Promise.resolve({ kind: 'basic', username: 'sam', password: 'hunter22' }),
          }),
          api,
        ),
        'int_widgets_list_widgets',
      ),
      {},
    );
    expect(api.seen[1]!.headers.authorization).toBe(
      `Basic ${Buffer.from('sam:hunter22').toString('base64')}`,
    );
  });

  it('signs in with OAuth and PKCE, and renews a token', async () => {
    const integration = declarative(bundled('google_analytics'));
    const { auth } = integration.manifest;
    if (auth.type !== 'oauth2') throw new Error('Expected OAuth');
    const pair = pkcePair();
    const url = new URL(
      authorizeUrl(auth, {
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:51234/callback',
        state: 'abc',
        challenge: pair.challenge,
      }),
    );
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:51234/callback');
    expect(url.searchParams.get('scope')).toContain('analytics.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    // The token endpoint is one of the hosts shown before installing.
    expect(integration.hosts).toContain('oauth2.googleapis.com');

    const now = () => new Date('2026-10-11T00:00:00Z');
    const api = fakeApi({
      'oauth2.googleapis.com': (request) => {
        const form = new URLSearchParams(request.body);
        if (form.get('grant_type') === 'authorization_code') {
          return form.get('code_verifier') === pair.verifier
            ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'a b' })
            : json({ error: 'invalid_grant', error_description: 'Bad verifier' }, 400);
        }
        return json({ access_token: 'at-2', expires_in: 3600 });
      },
    });
    const options = { fetch: api.fetch, signal: new AbortController().signal, now };
    const first = await exchangeCode(
      auth,
      {
        clientId: 'client-1',
        clientSecret: '',
        redirectUri: 'http://127.0.0.1:51234/callback',
        code: 'code-1',
        verifier: pair.verifier,
      },
      options,
    );
    expect(first).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: new Date('2026-10-11T01:00:00Z'),
      scopes: ['a', 'b'],
    });
    await expect(
      exchangeCode(
        auth,
        { clientId: 'client-1', clientSecret: '', redirectUri: 'x', code: 'c', verifier: 'wrong' },
        options,
      ),
    ).rejects.toThrow(/didn't give a token: Bad verifier/);
    const renewed = await refreshTokens(
      auth,
      { clientId: 'client-1', clientSecret: 's', refreshToken: 'rt-1' },
      options,
    );
    expect(renewed.accessToken).toBe('at-2');
    expect(renewed.refreshToken).toBeNull();
  });
});

describe('sequences and services that answer 200 to a failure', () => {
  const sequence = `  - id: post_picture
    risk: outbound
    summary: Publish a post with a picture.
    input:
      text: { type: string, required: true, description: The post. }
      picture: { type: string, required: true }
    steps:
      - call: "POST /media"
        with: { url: "{picture}" }
        save: { media_id: id }
      - call: "POST /posts"
        with: { text: "{text}", media_ids: ["{media_id}"] }`;

  it('runs the steps in order, each with what the one before returned', async () => {
    const api = fakeApi({
      'api.widgets.example': (request) =>
        request.url.pathname.endsWith('/media')
          ? json({ id: 'm_9' })
          : json({ id: 'p_1', ok: true }),
    });
    const tools = integrationTools(
      declarative(widgets('', sequence)),
      connection({ hosts: ['api.widgets.example'] }),
      api,
    );
    const post = tool(tools, 'int_widgets_post_picture');
    expect(post.locked).toBe(true);
    expect(post.approval({ text: 'Hi', picture: 'https://x/y.png' }).subject).toBe(
      [
        '1. POST https://api.widgets.example/v2/media',
        '{\n  "url": "https://x/y.png"\n}',
        '2. POST https://api.widgets.example/v2/posts',
        '{\n  "text": "Hi",\n  "media_ids": [\n    "{media_id}"\n  ]\n}',
      ].join('\n'),
    );
    const result = await call(post, { text: 'Hi', picture: 'https://x/y.png' });
    expect(result.content).toContain('p_1');
    expect(api.seen.map((r) => JSON.parse(r.body) as unknown)).toEqual([
      { url: 'https://x/y.png' },
      { text: 'Hi', media_ids: ['m_9'] },
    ]);
  });

  it('says which steps already happened when a later one fails', async () => {
    const api = fakeApi({
      'api.widgets.example': (request) =>
        request.url.pathname.endsWith('/media')
          ? json({ id: 'm_9' })
          : json({ message: 'Too long' }, 422),
    });
    const tools = integrationTools(
      declarative(widgets('', sequence)),
      connection({ hosts: ['api.widgets.example'] }),
      api,
    );
    const result = await call(tool(tools, 'int_widgets_post_picture'), {
      text: 'Hi',
      picture: 'p',
    });
    expect(result.error).toBe(true);
    expect(result.content).toMatch(
      /turned POST \/posts down \(422\): Too long\. These already went through and weren't undone: POST \/media\.$/,
    );
  });

  it('refuses a sequence that uses a value nothing provides', () => {
    expect(() => loadIntegration(widgets('', sequence.replace('{media_id}', '{nothing}')))).toThrow(
      /step 2 uses \{nothing\}/,
    );
  });

  it('reads a failure out of a 200 when the manifest says where it is', async () => {
    const api = fakeApi({
      'slack.com': () => json({ ok: false, error: 'channel_not_found' }),
    });
    const tools = integrationTools(
      declarative(bundled('slack')),
      connection({ hosts: ['slack.com'] }),
      api,
    );
    const result = await call(tool(tools, 'int_slack_list_messages'), { channel: 'C0' });
    expect(result.error).toBe(true);
    expect(result.content).toContain('(200): channel_not_found');
  });
});

describe('arguments from small models', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      on: { type: 'boolean' },
      name: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      kind: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['name'],
  };

  it('reads them however they are written', () => {
    expect(
      parseArgs(schema, {
        count: { value: '3' },
        on: 'TRUE',
        name: 42,
        tags: 'one',
        kind: 'a',
      }),
    ).toEqual({ count: 3, on: true, name: '42', tags: ['one'], kind: 'a' });
    expect(parseArgs(schema, '{"name":"x","tags":"[\\"a\\",\\"b\\"]"}')).toEqual({
      name: 'x',
      tags: ['a', 'b'],
    });
    // Empty values are left out rather than sent.
    expect(parseArgs(schema, { name: 'x', count: null, kind: '' })).toEqual({ name: 'x' });
  });

  it('says what is wrong with one that does not fit', () => {
    expect(() => parseArgs(schema, { name: 'x', count: 'many' })).toThrow(
      /`count` must be a number/,
    );
    expect(() => parseArgs(schema, { name: 'x', count: 1.5 })).toThrow(/whole number/);
    expect(() => parseArgs(schema, { name: 'x', kind: 'c' })).toThrow(/must be one of: a, b/);
    expect(() => parseArgs(schema, {})).toThrow(/`name` is required/);
    expect(() => parseArgs(schema, [1])).toThrow(/JSON object/);
  });
});

describe('MCP integrations and the prompt', () => {
  const mcp = `
id: files
kind: mcp
name: Files
summary: Reads a folder.
hosts: []
server:
  npm: "@modelcontextprotocol/server-filesystem"
  version: 2025.8.21
  integrity: sha512-${'A'.repeat(86)}==
  args: [/data]
  env:
    - { name: API_TOKEN, label: Token }
`;

  it('runs a server pinned to one exact version, on this computer or in Docker', () => {
    const integration = loadIntegration({ manifest: mcp });
    if (integration.kind !== 'mcp') throw new Error('Expected MCP');
    expect(mcpCommand(integration.manifest, { docker: false })).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2025.8.21', '/data'],
    });
    expect(mcpCommand(integration.manifest, { docker: true })).toEqual({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        '-e',
        'API_TOKEN',
        'node:22-bookworm-slim',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem@2025.8.21',
        '/data',
      ],
    });
    expect(() => loadIntegration({ manifest: mcp.replace('2025.8.21', '^2025.8.0') })).toThrow(
      /Pin an exact version/,
    );
  });

  it('tells a clank which account it acts as, and in which mode', () => {
    expect(integrationsLayer([])).toBeNull();
    const layer = integrationsLayer([
      {
        name: 'Stripe',
        account: 'Surf shop',
        mode: 'test',
        tools: ['int_stripe_list_products'],
        guide: 'Amounts are in cents.',
      },
    ])!;
    expect(layer).toContain('### Stripe: test mode');
    expect(layer).toContain('Account: Surf shop. Tools: `int_stripe_list_products`.');
    expect(layer).toContain('Amounts are in cents.');
    expect(layer).toContain('{{user.name}}');
  });
});
