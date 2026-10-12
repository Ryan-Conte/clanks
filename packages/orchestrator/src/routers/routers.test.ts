import type { ChatLiveEvent } from '@clanks/core';
import { createFakeProvider } from '@clanks/providers';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createAppCaller } from '../router';
import { crewFolder, startTestOrchestrator } from '../test-helpers';

/** An OpenAI-style model server on 127.0.0.1 that lists one model. */
async function modelServer() {
  const http = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'local-qwen', max_model_len: 8192 }] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`;
}

function setup() {
  const orchestrator = startTestOrchestrator();
  const fake = createFakeProvider({
    id: 'builtin',
    replies: () => [
      { type: 'text', text: 'Hi ' },
      { type: 'text', text: 'there.' },
    ],
  });
  orchestrator.context.providers.replace(fake);
  return { orchestrator, caller: createAppCaller(orchestrator.context), fake };
}

describe('chat router', () => {
  it('streams a reply live, catching a late window up first', async () => {
    const { orchestrator, caller } = setup();
    const { context } = orchestrator;
    context.crew.updateProfile('atlas', { model: { provider: 'server-x', model: 'm' } });
    // Atlas's server isn't set up, so starting fails before anything is saved.
    await expect(caller.chat.start({ clankId: 'atlas', text: 'Hi' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/isn't set up/) as string,
    });
    expect(await caller.chat.list()).toEqual([]);
    await expect(caller.chat.start({ clankId: 'nobody', text: 'Hi' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('lets a window watch a reply being written', async () => {
    const { orchestrator, caller } = setup();
    const { context } = orchestrator;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    context.providers.replace({
      ...createFakeProvider({ id: 'builtin', replies: [] }),
      async *stream() {
        yield { type: 'text', text: 'Fibreglass ' };
        await gate;
        yield { type: 'text', text: 'or foam.' };
        yield { type: 'done', finishReason: 'stop' };
      },
    });
    // The crew's model has to be pulled; skip that by giving Scout a configured server model.
    const server = await modelServer();
    const added = await caller.providers.addServer({ name: 'Lab', baseUrl: server });
    await caller.crew.update({
      id: 'scout',
      patch: { model: { provider: added.id, model: 'local-qwen' } },
    });
    context.providers.replace({ ...context.providers.get('builtin'), id: added.id });

    const { conversation, reply } = await caller.chat.start({ clankId: 'scout', text: 'Boards?' });
    for (let i = 0; i < 50 && context.chat.inFlight(conversation.id)?.content === ''; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const controller = new AbortController();
    const live = (
      await createAppCaller(context, { signal: controller.signal }).chat.live(conversation.id)
    )[Symbol.asyncIterator]();
    // A window that subscribes late is caught up on the reply so far.
    expect((await live.next()).value).toMatchObject({
      type: 'message',
      message: { id: reply.id, content: 'Fibreglass ', status: 'streaming' },
    });
    release();
    const events: ChatLiveEvent[] = [];
    while (events.at(-1)?.type !== 'message')
      events.push((await live.next()).value as ChatLiveEvent);
    expect(events[0]).toEqual({
      type: 'delta',
      messageId: reply.id,
      round: 0,
      text: 'or foam.',
      reasoning: '',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'message',
      message: { id: reply.id, status: 'done', content: 'Fibreglass or foam.' },
    });
    controller.abort();
    await live.return?.();
  });
});

describe('crew router', () => {
  it('lists the crew and edits a doc, refusing one that would not work', async () => {
    const { caller } = setup();
    expect((await caller.crew.list()).map((c) => c.name)).toEqual([
      'Atlas',
      'Scribe',
      'Prism',
      'Forge',
      'Gauge',
      'Scout',
      'Quill',
      'Buzz',
    ]);
    await expect(
      caller.crew.saveDoc({ id: 'forge', text: 'No frontmatter' }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/frontmatter/) as string,
    });
    const forge = readFileSync(join(crewFolder, 'forge.md'), 'utf8');
    await caller.crew.saveDoc({ id: 'forge', text: forge.replace('Engineer', 'Builder') });
    expect((await caller.crew.list()).find((c) => c.id === 'forge')).toMatchObject({
      role: 'Builder',
      doc: 'edited',
    });
    expect(await caller.crew.doc('forge')).toMatchObject({ edited: true, bundled: forge });
    await caller.crew.resetDoc('forge');
    expect((await caller.crew.doc('forge')).edited).toBe(false);
  });

  it('only gives a clank a model it can run on', async () => {
    const { caller } = setup();
    await expect(
      caller.crew.update({
        id: 'gauge',
        patch: { model: { provider: 'builtin', model: 'tiny:1b' } },
      }),
    ).rejects.toMatchObject({ message: "tiny:1b isn't pulled" });
    await expect(
      caller.crew.update({ id: 'gauge', patch: { model: { provider: 'openai', model: 'gpt-5' } } }),
    ).rejects.toMatchObject({ message: "OpenAI isn't set up yet" });
    await caller.providers.setKey({ id: 'openai', key: 'sk-test' });
    expect(
      await caller.crew.update({
        id: 'gauge',
        patch: { name: 'Gage', avatar: 'cyan', model: { provider: 'openai', model: 'gpt-5' } },
      }),
    ).toMatchObject({
      name: 'Gage',
      avatar: 'cyan',
      model: { provider: 'openai', model: 'gpt-5' },
    });
  });
});

describe('providers router', () => {
  it('saves keys without ever handing them back', async () => {
    const { orchestrator, caller } = setup();
    await caller.providers.setKey({ id: 'anthropic', key: ' sk-ant-secret ' });
    expect(orchestrator.context.secrets.get('provider:anthropic')).toBe('sk-ant-secret');
    const anthropic = (await caller.providers.list()).find((p) => p.id === 'anthropic');
    expect(anthropic).toEqual({
      id: 'anthropic',
      kind: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      hasKey: true,
      configured: true,
    });
    expect(JSON.stringify(await caller.providers.list())).not.toContain('sk-ant-secret');
    await caller.providers.removeKey('anthropic');
    expect((await caller.providers.list()).find((p) => p.id === 'anthropic')?.hasKey).toBe(false);
  });

  it('adds a model server once it answers, and lists its models', async () => {
    const { caller } = setup();
    const url = await modelServer();
    await expect(
      caller.providers.addServer({ name: 'Broken', baseUrl: url.replace('/v1', '/nope') }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/HTTP 404/) as string,
    });

    const added = await caller.providers.addServer({
      name: 'LM Studio',
      baseUrl: `${url}/`,
      apiKey: 'lm',
    });
    expect(added).toMatchObject({
      id: 'server-lm-studio',
      kind: 'server',
      baseUrl: url,
      hasKey: true,
    });
    expect(await caller.providers.models(added.id)).toEqual([
      { id: 'local-qwen', title: 'local-qwen', contextWindow: 8192 },
    ]);
    // Another with the same name gets its own id.
    expect((await caller.providers.addServer({ name: 'LM Studio', baseUrl: url })).id).toBe(
      'server-lm-studio-2',
    );

    await caller.crew.update({
      id: 'buzz',
      patch: { model: { provider: added.id, model: 'local-qwen' } },
    });
    await caller.providers.removeServer(added.id);
    expect((await caller.crew.list()).find((c) => c.id === 'buzz')?.model).toBeNull();
    expect((await caller.providers.list()).map((p) => p.id)).not.toContain(added.id);
  });

  it("explains a cloud provider that can't be used yet", async () => {
    const { caller } = setup();
    await expect(caller.providers.models('google')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Add your Google API key in Settings to use its models',
    });
  });
});
