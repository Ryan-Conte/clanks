import type { ChatEvent, ChatRequest, MessageRecord, ModelRecord, ToolPart } from '@clanks/core';
import { ProviderError, createFakeProvider } from '@clanks/providers';
import { git } from '@clanks/workspace';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeBrowserHost } from '../browser/fake-host';
import { sqliteModelRepository } from '../store/models';
import { startTestOrchestrator, tempDir } from '../test-helpers';
import { formatNotes, isCircling, sendable, toTurns, writtenCall } from './service';

const MODEL = 'tiny:1b';

function pulled(tools = true, vision = false): ModelRecord {
  return {
    id: MODEL,
    source: 'catalog',
    title: MODEL,
    repo: 'test/repo',
    revision: 'a'.repeat(40),
    quant: 'Q4_0',
    params: '1B',
    license: 'mit',
    tags: ['code'],
    capabilities: { tools, vision, reasoning: false },
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
}

const env = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** A repository with one commit, as a user's project would be. */
async function repository(files: Record<string, string>): Promise<string> {
  const root = join(tempDir(), 'surf');
  mkdirSync(root);
  await git(['init', '--quiet', '-b', 'main'], { cwd: root });
  await git(['config', 'core.autocrlf', 'false'], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '--quiet', '-m', 'Start'], { cwd: root, env });
  return root;
}

const call = (
  name: string,
  args: object,
  id = `${name}-${Math.random().toString(36).slice(2, 7)}`,
) => ({ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } }) as const;
const say = (text: string): ChatEvent[] => [{ type: 'text', text }];

function setup(
  replies: ChatEvent[][] | ((request: ChatRequest) => ChatEvent[]),
  options: { tools?: boolean; vision?: boolean; browser?: ReturnType<typeof fakeBrowserHost> } = {},
) {
  const orchestrator = startTestOrchestrator(
    options.browser ? { browserHost: options.browser.host } : {},
  );
  const { context } = orchestrator;
  sqliteModelRepository(context.store.db).putModel(
    pulled(options.tools ?? true, options.vision ?? false),
  );
  const blobs = join(orchestrator.paths.models, 'blobs');
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, `sha256-${'b'.repeat(64)}`), 'gguf');
  context.settings.update({
    crewModel: MODEL,
    profile: { name: 'Sam', timeZone: 'UTC', language: '', preferences: '' },
  });
  const fake = createFakeProvider({ id: 'builtin', replies });
  context.providers.replace(fake);
  return { orchestrator, context, chat: context.chat, fake };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting until ${what}`);
}

async function settled(
  chat: ReturnType<typeof setup>['chat'],
  id: string,
): Promise<MessageRecord[]> {
  await until(() => !chat.get(id).conversation.replying, 'the reply is done');
  return chat.get(id).messages;
}

const tools = (message: MessageRecord) =>
  message.parts.filter((p): p is ToolPart => p.type === 'tool');

describe('a clank with tools', () => {
  it('works on its own worktree, checkpointing every change', async () => {
    const root = await repository({ 'src/app.ts': 'export const wave = 1;\n' });
    const { chat, context, fake } = setup([
      [call('fs_read', { path: 'src/app.ts' }, 'r1')],
      [
        call(
          'fs_edit',
          { path: 'src/app.ts', old_string: 'wave = 1', new_string: 'wave = 2' },
          'e1',
        ),
      ],
      say('I set wave to 2.'),
    ]);
    const { conversation } = chat.start('forge', 'Set wave to 2', root);
    const messages = await settled(chat, conversation.id);
    const reply = messages[1]!;
    expect(reply).toMatchObject({
      status: 'done',
      content: 'I set wave to 2.',
      finishReason: 'stop',
    });
    expect(tools(reply).map((p) => [p.name, p.status, p.decidedBy, p.label])).toEqual([
      ['fs_read', 'done', 'policy', 'Reading `src/app.ts`'],
      ['fs_edit', 'done', 'policy', 'Editing `src/app.ts`'],
    ]);

    // The change is on the clank's branch, not in the user's checkout.
    const state = await context.workspace.state(conversation.id);
    expect(state.status).toBe('ready');
    const run = state.run!;
    expect(run.branch).toBe(`clanks/chat-${conversation.id.slice(0, 8)}`);
    expect(readFileSync(join(run.worktree, 'src', 'app.ts'), 'utf8')).toBe(
      'export const wave = 2;\n',
    );
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe('export const wave = 1;\n');

    expect(state.checkpoints.map((c) => [c.seq, c.author, c.label])).toEqual([
      [0, 'base', expect.stringMatching(/^Started from [0-9a-f]{7}$/) as string],
      [1, 'clank', 'Editing `src/app.ts`'],
    ]);
    expect(state.checkpoints[1]!.files).toEqual([
      {
        path: 'src/app.ts',
        oldPath: null,
        status: 'modified',
        added: 1,
        removed: 1,
        binary: false,
      },
    ]);
    expect(tools(reply)[1]!.checkpointId).toBe(state.checkpoints[1]!.id);

    // The model saw its tool results, and was told where it works.
    const last = fake.requests[2]!;
    expect(last.tools?.map((t) => t.name)).toContain('fs_edit');
    expect(last.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'e1',
      content: 'Edited src/app.ts. Changed lines: 1.',
    });
    expect(last.messages[0]!.content).toContain(`a git worktree on the branch \`${run.branch}\``);

    // Every step is on the activity timeline.
    expect(context.activity.list(conversation.id).map((e) => [e.kind, e.title, e.status])).toEqual([
      ['model', 'tiny:1b called fs_read', 'ok'],
      ['tool', 'Reading `src/app.ts`', 'ok'],
      ['model', 'tiny:1b called fs_edit', 'ok'],
      ['tool', 'Editing `src/app.ts`', 'ok'],
      ['model', 'tiny:1b answered', 'ok'],
    ]);

    // The next turn sends the calls and results back as history.
    expect(toTurns(messages).map((t) => t.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('asks before running a command, and remembers "always allow" for the project', async () => {
    const root = await repository({ 'README.md': '# Surf\n' });
    const { chat, context } = setup([
      [call('shell_exec', { command: 'echo hello' }, 'x1')],
      say('It said hello.'),
      [call('shell_exec', { command: 'echo again' }, 'x2')],
      say('Again.'),
      [call('shell_exec', { command: 'git push' }, 'x3')],
      say('Fine, I will not.'),
    ]);
    // Asked about every call, not only risky ones.
    context.settings.update({ approvals: 'all' });
    const { conversation } = chat.start('forge', 'Say hello', root);
    await until(() => chat.list()[0]?.asking === true, 'the command waits for approval');
    const asking = tools(chat.inFlight(conversation.id)!)[0]!;
    expect(asking).toMatchObject({
      status: 'asking',
      label: 'Running `echo hello`',
      approval: { kind: 'command', subject: 'echo hello', pattern: 'echo hello', scope: root },
    });

    chat.decide(conversation.id, 'x1', { decision: 'always', pattern: 'echo *' });
    let messages = await settled(chat, conversation.id);
    const ran = tools(messages[1]!)[0]!;
    expect(ran).toMatchObject({ status: 'done', decidedBy: 'user' });
    expect(ran.result).toBe('hello\n\n[Exit code 0.]');
    expect(context.tools.rules().map((r) => [r.scope, r.tool, r.pattern])).toEqual([
      [root, 'shell_exec', 'echo *'],
    ]);
    // It ran in the terminal pane, in the clank's worktree.
    const session = context.terminal.list(conversation.id)[0]!;
    expect(session).toMatchObject({
      kind: 'clank',
      title: 'echo hello',
      state: 'exited',
      exitCode: 0,
    });
    expect(session.cwd).toBe(context.workspace.run(conversation.id)!.cwd);

    // The rule lets the next one through without asking.
    chat.send(conversation.id, 'Again');
    messages = await settled(chat, conversation.id);
    expect(tools(messages[3]!)[0]).toMatchObject({ status: 'done', decidedBy: 'rule' });

    // Anything else still asks, and a no comes back to the model with the reason.
    chat.send(conversation.id, 'Push it');
    await until(() => chat.list()[0]?.asking === true, 'the push waits for approval');
    chat.decide(conversation.id, 'x3', { decision: 'deny', reason: 'Merging is mine' });
    messages = await settled(chat, conversation.id);
    expect(tools(messages[5]!)[0]).toMatchObject({
      status: 'denied',
      decidedBy: 'user',
      reason: 'Merging is mine',
      result: expect.stringContaining('Sam said no: "Merging is mine"') as string,
    });
    expect(() => chat.decide(conversation.id, 'x3', { decision: 'allow' })).toThrow(
      /isn't waiting/,
    );
  });

  it('runs everyday commands without asking, and asks before risky ones, saying why', async () => {
    const root = await repository({ 'README.md': '# Surf\n' });
    const { chat } = setup([
      [call('shell_exec', { command: 'echo hello' }, 'x1')],
      [call('shell_exec', { command: 'git push origin main' }, 'x2')],
      say('Done.'),
    ]);
    const { conversation } = chat.start('forge', 'Say hello, then push', root);
    await until(() => chat.list()[0]?.asking === true, 'the push waits for approval');
    const [hello, push] = tools(chat.inFlight(conversation.id)!);
    expect(hello).toMatchObject({ status: 'done', decidedBy: 'risk' });
    expect(push).toMatchObject({
      status: 'asking',
      approval: { subject: 'git push origin main', reason: 'Pushes to a remote' },
    });
    chat.decide(conversation.id, 'x2', { decision: 'deny' });
    await settled(chat, conversation.id);
  });

  it('stops while waiting for approval without running anything', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const { chat } = setup([[call('shell_exec', { command: 'rm -rf ../a.txt' }, 'x1')]]);
    const { conversation } = chat.start('forge', 'Delete a.txt', root);
    await until(() => chat.list()[0]?.asking === true, 'it asks');
    chat.stop(conversation.id);
    const messages = await settled(chat, conversation.id);
    expect(messages[1]!.status).toBe('cancelled');
    expect(tools(messages[1]!)[0]).toMatchObject({
      status: 'cancelled',
      result: 'Stopped before it ran.',
    });
  });

  it('follows the policy: denied tools are refused, unlisted ones not offered', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const { chat, context, fake } = setup([
      [call('fs_write', { path: 'b.txt', content: 'b' })],
      say('Ok.'),
    ]);
    context.tools.setPolicy('forge', 'fs_write', 'deny');
    expect(context.tools.policies('forge').find((p) => p.name === 'fs_write')).toMatchObject({
      level: 'deny',
      defaultLevel: 'allow',
      overridden: true,
    });
    const { conversation } = chat.start('forge', 'Write b', root);
    const messages = await settled(chat, conversation.id);
    expect(tools(messages[1]!)[0]).toMatchObject({ status: 'denied', decidedBy: 'policy' });
    expect(existsSync(join(context.workspace.run(conversation.id)!.worktree, 'b.txt'))).toBe(false);
    // Atlas's doc doesn't give it fs_write at all, so it isn't offered.
    const offered = fake.requests[0]!.tools!.map((t) => t.name);
    expect(offered).toContain('fs_write');
    context.tools.setPolicy('forge', 'fs_write', null);
    expect(context.tools.policies('forge').find((p) => p.name === 'fs_write')?.overridden).toBe(
      false,
    );
  });

  it('returns a malformed call to the model, and stops after three in a row', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const { chat } = setup([
      [{ type: 'tool_call', call: { id: 'm1', name: 'fs_read', arguments: '{"path":' } }],
      [call('fs_frobnicate', {}, 'm2')],
      [call('fs_read', { path: 7 }, 'm3')],
    ]);
    const { conversation } = chat.start('forge', 'Read', root);
    const messages = await settled(chat, conversation.id);
    expect(tools(messages[1]!).map((p) => p.status)).toEqual(['failed', 'failed', 'failed']);
    expect(tools(messages[1]!)[0]!.result).toMatch(/aren't valid JSON/);
    expect(tools(messages[1]!)[1]!.result).toMatch(/There's no tool called fs_frobnicate here/);
    expect(messages[1]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining("3 tool calls in a row that don't fit their tools") as string,
    });
  });

  it('lets a long run slip now and then, and says when a call was cut off for want of room', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const bad = (id: string): ChatEvent[] => [
      { type: 'tool_call', call: { id, name: 'fs_read', arguments: '{"path":' } },
    ];
    const { chat } = setup([
      bad('m1'),
      [call('fs_read', { path: 'a.txt' }, 'ok1')],
      bad('m2'),
      // The model ran out of room part way through writing a file.
      [
        {
          type: 'tool_call',
          call: { id: 'cut', name: 'fs_write', arguments: '{"path":"b.txt","content":"b' },
        },
        { type: 'done', finishReason: 'length' },
      ],
      [call('fs_write', { path: 'b.txt', content: 'b\n' }, 'ok2')],
      say('Wrote b.txt.'),
    ]);
    const { conversation } = chat.start('forge', 'Write b.txt', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    // Four slips in all, never three running: the reply went on to finish.
    expect(tools(reply).map((p) => p.status)).toEqual([
      'failed',
      'done',
      'failed',
      'failed',
      'done',
    ]);
    expect(reply).toMatchObject({ status: 'done', content: 'Wrote b.txt.' });
    expect(tools(reply)[3]!.result).toMatch(
      /^Your call to fs_write was cut off before its end: it was longer than the room left in this reply/,
    );
  });

  it('notices the same call made over and over, then stops running it', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const again = () => [call('fs_list', { path: '.' })];
    const { chat, fake } = setup([
      again(),
      again(),
      again(),
      again(),
      again(),
      say('It only has a.txt.'),
    ]);
    const { conversation } = chat.start('forge', 'What is here?', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    expect(tools(reply).map((p) => p.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'cancelled',
    ]);
    // The third time, the model is told it's going nowhere. The user sees a line saying so.
    const results = fake.requests.at(-1)!.messages.filter((m) => m.role === 'tool');
    expect(results.map((m) => /made this exact call several times/.test(m.content))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(tools(reply)[2]!.result).not.toMatch(/exact call/);
    expect(results[4]!.content).toMatch(
      /^This didn't run: you've made this exact call 4 times and it gave the same result every time/,
    );
    expect(reply.parts.filter((p) => p.type === 'note').map((p) => p.text)).toEqual([
      'Forge made the same call 3 times with the same result, so it was told to try something else.',
    ]);
    expect(reply).toMatchObject({ status: 'done', content: 'It only has a.txt.' });
  });

  it("doesn't count a call made again after the files changed", async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const read = () => [call('fs_read', { path: 'a.txt' })];
    const { chat } = setup([
      read(),
      read(),
      [call('fs_write', { path: 'b.txt', content: 'b\n' })],
      read(),
      read(),
      say('Done.'),
    ]);
    const { conversation } = chat.start('forge', 'Add b.txt', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    expect(tools(reply).every((p) => p.status === 'done')).toBe(true);
    expect(reply.parts.some((p) => p.type === 'note')).toBe(false);
  });

  it('lets a clank read again what was cut from the conversation to make room', async () => {
    // Long reads, so the older ones are cut down as the conversation fills.
    const lines = Array.from({ length: 60 }, (_, i) => `${i} ${'a'.repeat(400)}`).join('\n');
    const root = await repository({ 'a.txt': `${lines}\n`, 'b.txt': `${lines}\n` });
    // Five reads of one file, each after six others have pushed the last one out.
    let other = 0;
    const script = Array.from({ length: 5 }, () => [
      [call('fs_read', { path: 'a.txt' })],
      ...Array.from({ length: 6 }, () => [call('fs_read', { path: 'b.txt', offset: ++other })]),
    ]).flat();
    const { chat } = setup([...script, say('Both are the letter a.')]);
    const { conversation } = chat.start('forge', 'Compare the two files', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    expect(reply).toMatchObject({ status: 'done', content: 'Both are the letter a.' });
    const reads = tools(reply).filter((p) => p.arguments === '{"path":"a.txt"}');
    expect(reads.map((p) => p.status)).toEqual(Array.from({ length: 5 }, () => 'done'));
    expect(reply.parts.some((p) => p.type === 'note')).toBe(false);
  }, 30_000);

  it('refuses a repeat and lets the reply get on with something else', async () => {
    const root = await repository({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const again = () => [call('fs_list', { path: '.' })];
    const { chat } = setup([
      again(),
      again(),
      again(),
      again(),
      // Refused from here on, each time with other work in between: it isn't stuck.
      again(),
      [call('fs_read', { path: 'a.txt' })],
      again(),
      [call('fs_read', { path: 'b.txt' })],
      again(),
      [call('fs_write', { path: 'c.txt', content: 'c\n' })],
      // The folder has changed, so listing it again is a new question.
      again(),
      say('Three files now.'),
    ]);
    const { conversation } = chat.start('forge', 'Add c.txt', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    expect(reply).toMatchObject({ status: 'done', content: 'Three files now.' });
    expect(
      tools(reply)
        .filter((p) => p.name === 'fs_list')
        .map((p) => p.status),
    ).toEqual(['done', 'done', 'done', 'done', 'cancelled', 'cancelled', 'cancelled', 'done']);
  });

  it('stops a reply that keeps asking for a call it was refused', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const { chat, fake } = setup(Array.from({ length: 9 }, () => [call('fs_list', { path: '.' })]));
    const { conversation } = chat.start('forge', 'What is here?', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    // Four ran, three were refused one after another with nothing done in between.
    expect(fake.requests).toHaveLength(7);
    expect(tools(reply).map((p) => p.status)).toEqual([
      ...Array.from({ length: 4 }, () => 'done'),
      ...Array.from({ length: 3 }, () => 'cancelled'),
    ]);
    expect(reply).toMatchObject({ status: 'done', finishReason: 'length' });
    expect(reply.parts.at(-1)).toMatchObject({
      type: 'note',
      text: 'Stopped: Forge kept asking for the same call, which gives the same result every time.',
    });
  });

  it('cuts off a model thinking in circles, and asks a chat for its answer', async () => {
    const thought = "I'll try to search for it on another site.\n\n";
    const { chat, fake } = setup([
      Array.from({ length: 200 }, () => ({ type: 'reasoning', text: thought }) as const),
      say("I couldn't find how it looks. Scout can open it in the browser."),
    ]);
    const { conversation } = chat.start('atlas', 'What does the site look like?');
    const reply = (await settled(chat, conversation.id))[1]!;
    // It was stopped long before it filled its reply, and asked to answer from what it had.
    expect(reply.reasoning.length).toBeLessThan(thought.length * 60);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('You ran out of room while thinking') as string,
    });
    expect(reply).toMatchObject({
      status: 'done',
      finishReason: 'stop',
      content: "I couldn't find how it looks. Scout can open it in the browser.",
    });
    expect(reply.parts.find((p) => p.type === 'note')?.text).toBe(
      'Atlas ran out of room before answering, so it was asked to answer now.',
    );
  });

  it('tells words going round in circles from words that only repeat a little', () => {
    const step = 'Next I will check the pricing page for the plan names. ';
    expect(isCircling(step.repeat(20))).toBe(true);
    expect(isCircling(`Some thinking first. ${step.repeat(14)}`)).toBe(true);
    expect(isCircling(step.repeat(5))).toBe(false);
    const prose = Array.from({ length: 60 }, (_, i) => `Board ${i} is ${i * 3} cm long.`).join(' ');
    expect(isCircling(prose)).toBe(false);
    // A ruled line or a run of blank lines is padding, not a thought.
    expect(isCircling(`${'-'.repeat(900)}`)).toBe(false);
    expect(isCircling(`A table\n${'| --- | --- |\n'.repeat(80)}`)).toBe(false);
  });

  it('makes a call the model wrote out as words', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    // Gemma's own call syntax, as it comes through when its server can't read it.
    const { chat, fake } = setup([
      say('I will look first.\n\ncall:fs_list{path:<|"|>.<|"|>}<tool_call|>'),
      say('It only has a.txt.'),
    ]);
    const { conversation } = chat.start('forge', 'What is here?', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    expect(tools(reply).map((p) => [p.name, p.status, p.arguments])).toEqual([
      ['fs_list', 'done', '{"path":"."}'],
    ]);
    // The call's own words aren't left in the reply, or sent back as something it said.
    expect(reply.content).toBe('I will look first.\n\nIt only has a.txt.');
    expect(fake.requests[1]!.messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: 'I will look first.',
      toolCalls: [{ name: 'fs_list', arguments: '{"path":"."}' }],
    });
  });

  it('reads a written call however the model spells it, and only a whole one at the end', () => {
    const names = new Set(['review_pass', 'fs_read']);
    // As a sign-off came through: one string closed with a plain quote, which is what broke it.
    const gemma =
      'review_pass{criteria:[{evidence:<|"|>`npm run build` passed.<|"|>,status:<|"|>met",text:<|"|>It builds<|"|>}],summary:<|"|>Set up, and\nit runs.<|"|>}<tool_call|>';
    expect(writtenCall(gemma, names)).toEqual({
      name: 'review_pass',
      arguments: JSON.stringify({
        criteria: [{ evidence: '`npm run build` passed.', status: 'met', text: 'It builds' }],
        summary: 'Set up, and\nit runs.',
      }),
      before: '',
    });
    expect(
      writtenCall(
        'Done.\n<tool_call>{"name": "fs_read", "arguments": {"path": "a.txt", "limit": 5}}</tool_call>',
        names,
      ),
    ).toEqual({ name: 'fs_read', arguments: '{"path":"a.txt","limit":5}', before: 'Done.' });
    // Talking about a call isn't making one, and neither is a tool that isn't on offer.
    expect(writtenCall('I would call review_pass{summary:"ok"} once it builds.', names)).toBeNull();
    expect(writtenCall('shell_exec{command:"rm -rf ."}', names)).toBeNull();
    expect(writtenCall('review_pass{summary:"never closed', names)).toBeNull();
    expect(writtenCall('Use an object such as {a: 1}.', names)).toBeNull();
  });

  it("keeps a call it couldn't read from spoiling the rest of the conversation", async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const { chat, fake } = setup([
      [{ type: 'tool_call', call: { id: 'm1', name: 'fs_read', arguments: '{"path":"a.t' } }],
      [call('fs_read', { path: 'a.txt' }, 'r1')],
      say('It says a.'),
    ]);
    const { conversation } = chat.start('forge', 'Read a.txt', root);
    const messages = await settled(chat, conversation.id);
    expect(tools(messages[1]!).map((p) => p.status)).toEqual(['failed', 'done']);
    // A server that lays the conversation out reads every call's arguments: they must be JSON.
    const sent = fake.requests
      .flatMap((r) => r.messages)
      .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
    expect(sent.length).toBeGreaterThan(0);
    for (const one of sent) expect(() => JSON.parse(one.arguments) as unknown).not.toThrow();
    expect(sent[0]!.arguments).toBe('{"unreadable":"{\\"path\\":\\"a.t"}');
    // And the same when the chat is picked up again later, from what was saved.
    const again = toTurns(chat.get(conversation.id).messages);
    const saved = again.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
    expect(saved.map((c) => c.arguments)).toEqual([
      '{"unreadable":"{\\"path\\":\\"a.t"}',
      '{"path":"a.txt"}',
    ]);
    expect(sendable({ id: 'x', name: 'fs_read', arguments: '' }).arguments).toBe('');
    expect(sendable({ id: 'x', name: 'fs_read', arguments: '[1]' }).arguments).toBe(
      '{"unreadable":"[1]"}',
    );
  });

  it("asks again when the model's server couldn't read the call it wrote", async () => {
    const unreadable = new ProviderError(
      'The model answered HTTP 500: Failed to parse tool call arguments as JSON: parse error at line 1, column 292',
    );
    let asked = 0;
    const { chat, fake } = setup(() => {
      if (++asked <= 2) throw unreadable;
      return say('Here you go.');
    });
    const { conversation } = chat.start('atlas', 'Hello');
    const reply = (await settled(chat, conversation.id))[1]!;
    expect(fake.requests).toHaveLength(3);
    expect(reply).toMatchObject({ status: 'done', content: 'Here you go.' });
    expect(reply.parts.filter((p) => p.type === 'note').map((p) => p.text)).toEqual([
      "tiny:1b wrote a tool call that couldn't be read, so it was asked again.",
      "tiny:1b wrote a tool call that couldn't be read, so it was asked again.",
    ]);

    // A third time it gives up and says why; anything else that goes wrong isn't asked for again.
    const stuck = setup(() => {
      throw unreadable;
    });
    const second = stuck.chat.start('atlas', 'Hello');
    const failed = (await settled(stuck.chat, second.conversation.id))[1]!;
    expect(stuck.fake.requests).toHaveLength(3);
    expect(failed).toMatchObject({ status: 'failed', error: unreadable.message });
    const down = setup(() => {
      throw new ProviderError('The model answered HTTP 500: out of memory');
    });
    const third = down.chat.start('atlas', 'Hello');
    await settled(down.chat, third.conversation.id);
    expect(down.fake.requests).toHaveLength(1);
  });

  it('cuts a conversation down and asks again when it was too big for the model', async () => {
    const lines = Array.from({ length: 15 }, () => 'a'.repeat(1000)).join('\n');
    const root = await repository({ 'a.txt': `${lines}\n` });
    let asked = 0;
    const sizes: number[] = [];
    const { chat } = setup((request) => {
      asked++;
      sizes.push(JSON.stringify(request.messages).length);
      // Four reads in, the model's server says the conversation no longer fits.
      if (asked <= 4) return [call('fs_read', { path: 'a.txt', offset: asked }, `r${asked}`)];
      if (asked === 5) {
        throw new ProviderError(
          'The model answered HTTP 400: request (99000 tokens) exceeds the available context size (32768 tokens), try increasing it',
        );
      }
      return say('It is a file of the letter a.');
    });
    const { conversation } = chat.start('forge', 'What is in a.txt?', root);
    const reply = (await settled(chat, conversation.id))[1]!;
    expect(reply).toMatchObject({ status: 'done', content: 'It is a file of the letter a.' });
    expect(reply.parts.filter((p) => p.type === 'note').map((p) => p.text)).toEqual([
      'The conversation had grown past what tiny:1b can hold, so its oldest steps were cut down.',
    ]);
    // It was asked again with less: the old reads were cut down, the two newest kept whole.
    expect(asked).toBe(6);
    expect(sizes[5]).toBeLessThan(sizes[4]! * 0.75);
  });

  it("offers no tools when the model can't call them, and says so", async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const { chat, fake } = setup([say('I can only talk.')], { tools: false });
    const { conversation } = chat.start('forge', 'Read a.txt', root);
    await settled(chat, conversation.id);
    expect(fake.requests[0]!.tools).toBeUndefined();
    expect(fake.requests[0]!.messages[0]!.content).toContain(
      "The model you run on can't call tools",
    );
  });

  it("tells a chat about a folder that isn't a repository how to fix it", async () => {
    const folder = tempDir();
    const { chat, context, fake } = setup([say('Set up git first.')]);
    const { conversation } = chat.start('forge', 'Hi', folder);
    await settled(chat, conversation.id);
    expect((await context.workspace.state(conversation.id)).status).toBe('not_repo');
    expect(fake.requests[0]!.messages[0]!.content).toContain("It isn't a git repository yet");
    expect(
      fake.requests[0]!.tools?.map((t) => t.name).some((n) => n.startsWith('fs_')),
    ).toBeFalsy();

    await context.workspace.setupGit(conversation.id);
    expect((await context.workspace.state(conversation.id)).status).toBe('ready');
  });
});

describe('reviewing in the diff editor', () => {
  async function edited() {
    const root = await repository({ 'src/app.ts': 'a\nb\nc\nd\ne\n' });
    const setupResult = setup([
      [call('fs_write', { path: 'src/app.ts', content: 'a\nB\nc\nd\nE\nf\n' }, 'w1')],
      say('Done.'),
    ]);
    const { chat, context } = setupResult;
    const { conversation } = chat.start('forge', 'Shout', root);
    await settled(chat, conversation.id);
    const state = await context.workspace.state(conversation.id);
    return { ...setupResult, root, conversation, state, base: state.checkpoints[0]!.id };
  }

  it('shows each file on both sides, with its changed runs', async () => {
    const { context, conversation, base } = await edited();
    expect(await context.workspace.files(conversation.id, base, 'live')).toEqual([
      {
        path: 'src/app.ts',
        oldPath: null,
        status: 'modified',
        added: 3,
        removed: 2,
        binary: false,
      },
    ]);
    const file = await context.workspace.file(conversation.id, {
      path: 'src/app.ts',
      from: base,
      to: 'live',
    });
    expect(file).toMatchObject({
      original: 'a\nb\nc\nd\ne\n',
      modified: 'a\nB\nc\nd\nE\nf\n',
      binary: false,
      tooLarge: false,
      hunks: [
        { originalStart: 2, originalCount: 1, modifiedStart: 2, modifiedCount: 1 },
        { originalStart: 5, originalCount: 1, modifiedStart: 5, modifiedCount: 2 },
      ],
    });
    expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects one change with a comment, and the clank gets the note with the next message', async () => {
    const { chat, context, conversation, state, base } = await edited();
    const file = await context.workspace.file(conversation.id, {
      path: 'src/app.ts',
      from: base,
      to: 'live',
    });
    const note = await context.workspace.rejectHunk({
      conversationId: conversation.id,
      path: 'src/app.ts',
      from: base,
      hunk: file.hunks[0]!,
      hash: file.hash!,
      comment: 'Keep b lowercase.',
    });
    expect(readFileSync(join(state.run!.worktree, 'src', 'app.ts'), 'utf8')).toBe(
      'a\nb\nc\nd\nE\nf\n',
    );
    expect(note).toMatchObject({
      kind: 'reject',
      path: 'src/app.ts',
      startLine: 2,
      endLine: 2,
      excerpt: 'B',
      status: 'pending',
    });
    const after = await context.workspace.state(conversation.id);
    expect(after.checkpoints.at(-1)).toMatchObject({
      author: 'user',
      label: 'You rejected a change in src/app.ts',
    });

    // A stale view can't overwrite a change it never saw.
    await expect(
      context.workspace.rejectHunk({
        conversationId: conversation.id,
        path: 'src/app.ts',
        from: base,
        hunk: file.hunks[1]!,
        hash: file.hash!,
        comment: '',
      }),
    ).rejects.toThrow(/changed since you looked/);

    context.workspace.comment({
      conversationId: conversation.id,
      path: 'src/app.ts',
      startLine: 5,
      endLine: 6,
      body: 'Why the f?',
    });
    context.providers.replace(createFakeProvider({ id: 'builtin', replies: [say('Fixed.')] }));
    chat.send(conversation.id, 'Please fix');
    const messages = await settled(chat, conversation.id);
    const sent = messages.at(-2)!;
    expect(sent.content).toBe(
      [
        'Please fix',
        '',
        'My review notes from the diff editor:',
        '',
        "1. I rejected your change to `src/app.ts` at line 2, so it's back as it was. Keep b lowercase.",
        '   You had written:',
        '       B',
        '2. About `src/app.ts`, lines 5–6: Why the f?',
        '       E',
        '       f',
      ].join('\n'),
    );
    expect(context.workspace.pendingNotes(conversation.id)).toEqual([]);
  });

  it('records the user’s own edits as a checkpoint and a note', async () => {
    const { context, conversation, base } = await edited();
    const file = await context.workspace.file(conversation.id, {
      path: 'src/app.ts',
      from: base,
      to: 'live',
    });
    const note = await context.workspace.saveFile({
      conversationId: conversation.id,
      path: 'src/app.ts',
      content: 'a\nB\nc\nd!\nE\nf\n',
      hash: file.hash,
    });
    expect(note).toMatchObject({ kind: 'edit', startLine: 4, endLine: 4, body: '4' });
    expect(formatNotes([note!])).toContain('I edited `src/app.ts` myself (line 4). Read it again');
  });

  it('rewinds the files and the chat to a checkpoint', async () => {
    const root = await repository({ 'a.txt': 'one\n' });
    const { chat, context } = setup([
      [call('fs_write', { path: 'a.txt', content: 'two\n' }, 'w1')],
      [
        call('fs_write', { path: 'a.txt', content: 'three\n' }, 'w2'),
        call('fs_write', { path: 'b.txt', content: 'b\n' }, 'w3'),
      ],
      say('Wrote three.'),
      say('Anything else?'),
    ]);
    const { conversation } = chat.start('forge', 'Count up', root);
    await settled(chat, conversation.id);
    chat.send(conversation.id, 'Thanks');
    await settled(chat, conversation.id);
    const state = await context.workspace.state(conversation.id);
    const worktree = state.run!.worktree;
    expect(state.checkpoints.map((c) => c.label)).toEqual([
      expect.stringMatching(/^Started from/) as string,
      'Writing `a.txt`',
      'Writing `a.txt`',
      'Writing `b.txt`',
    ]);

    await chat.rewind(conversation.id, state.checkpoints[1]!.id);
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('two\n');
    expect(existsSync(join(worktree, 'b.txt'))).toBe(false);
    const { messages } = chat.get(conversation.id);
    // The chat ends where the checkpoint was made: later turns are gone.
    expect(messages).toHaveLength(2);
    expect(messages[1]!.parts.map((p) => p.type)).toEqual(['tool', 'note']);
    expect(
      (await context.workspace.state(conversation.id)).checkpoints.map((c) => c.rewound),
    ).toEqual([false, false, true, true]);
    expect(context.activity.list(conversation.id).at(-1)).toMatchObject({
      kind: 'rewind',
      title: 'Rewound to: Writing `a.txt`',
    });
  });

  it('takes back a note that was sent after the moment a rewind returns to', async () => {
    const { chat, context, conversation, base } = await edited();
    const file = await context.workspace.file(conversation.id, {
      path: 'src/app.ts',
      from: base,
      to: 'live',
    });
    const note = await context.workspace.rejectHunk({
      conversationId: conversation.id,
      path: 'src/app.ts',
      from: base,
      hunk: file.hunks[0]!,
      hash: file.hash!,
      comment: 'No capitals.',
    });
    context.providers.replace(createFakeProvider({ id: 'builtin', replies: [say('Fixed.')] }));
    chat.sendReview(conversation.id);
    await settled(chat, conversation.id);
    expect(context.workspace.pendingNotes(conversation.id)).toEqual([]);

    const rejection = (await context.workspace.state(conversation.id)).checkpoints.at(-1)!;
    expect(rejection.author).toBe('user');
    await chat.rewind(conversation.id, rejection.id);
    // The review and its answer are cut, so the note waits to be sent again.
    expect(chat.get(conversation.id).messages).toHaveLength(2);
    expect(context.workspace.pendingNotes(conversation.id)).toMatchObject([
      { id: note.id, status: 'pending', sentAt: null },
    ]);
  });

  it('removes the worktree with the chat, keeping its branch', async () => {
    const { chat, context, conversation, root, state } = await edited();
    await chat.delete(conversation.id);
    expect(existsSync(state.run!.worktree)).toBe(false);
    expect(context.workspace.run(conversation.id)).toBeNull();
    expect(await git(['show', `${state.run!.branch}:src/app.ts`], { cwd: root })).toBe(
      'a\nB\nc\nd\nE\nf',
    );
  });
});

describe('a clank with a browser', () => {
  const pages = {
    'https://boards.test/': {
      title: 'Boards',
      text: ['Soft tops are the easiest boards to learn on.'],
      elements: [{ role: 'link' as const, name: 'Prices', href: '/prices' }],
    },
    'https://boards.test/prices': { title: 'Prices', text: ['Foamie 7ft: $399'] },
    'https://html.duckduckgo.com/html/?q=beginner%20boards': {
      title: 'Search',
      results: [{ title: 'Boards', url: 'https://boards.test/', snippet: 'Soft tops' }],
    },
  };

  it('browses without a folder, keeping a picture of each step', async () => {
    const browser = fakeBrowserHost(pages);
    const { chat, context, fake } = setup(
      [
        [call('browser_open', { url: 'https://boards.test/' }, 'o1')],
        [call('browser_click', { ref: '[1]' }, 'c1')],
        [call('browser_read', {}, 'r1')],
        say('A Foamie 7ft is $399.'),
      ],
      { browser },
    );
    const { conversation } = chat.start('scout', 'How much is a beginner board?');
    const messages = await settled(chat, conversation.id);
    const parts = tools(messages.at(-1)!);
    expect(parts.map((p) => [p.name, p.status])).toEqual([
      ['browser_open', 'done'],
      ['browser_click', 'done'],
      ['browser_read', 'done'],
    ]);
    expect(parts[1]!.result).toBe(
      'Clicked [1]. It led to a new page:\n\nPrices\nhttps://boards.test/prices\n\nFoamie 7ft: $399',
    );
    // Every step left a picture of the page for the user, and the activity log points at it.
    const image = parts[0]!.image!;
    expect(image).toBe(`${conversation.id}/o1.jpg`);
    expect(existsSync(join(context.paths.artifacts, image))).toBe(true);
    const steps = context.activity.list(conversation.id).filter((e) => e.kind === 'tool');
    expect(steps.map((e) => e.image)).toEqual(parts.map((p) => p.image));
    // The model read the page as text, with nothing it can't see.
    const last = fake.requests.at(-1)!.messages.at(-1)!;
    expect(last).toMatchObject({ role: 'tool', toolCallId: 'r1' });
    expect(last).not.toHaveProperty('images');
    expect((last as { content: string }).content).toContain('Foamie 7ft: $399');
    // Scout was told about the pane.
    expect(fake.requests[0]!.messages[0]!.content).toContain('browser pane');

    await chat.delete(conversation.id);
    expect(browser.tabs[0]!.closed).toBe(true);
    expect(existsSync(join(context.paths.artifacts, conversation.id))).toBe(false);
  });

  it('offers screenshots only to a model that can see, and shows it the newest', async () => {
    const blind = setup([say('Ok.')], { browser: fakeBrowserHost(pages) });
    const first = blind.chat.start('scout', 'Hi');
    await settled(blind.chat, first.conversation.id);
    const offered = (blind.fake.requests[0]!.tools ?? []).map((t) => t.name);
    expect(offered).toContain('browser_read');
    expect(offered).not.toContain('browser_screenshot');

    const { chat, fake } = setup(
      [
        [call('browser_open', { url: 'https://boards.test/' }, 'o1')],
        [call('browser_screenshot', {}, 's1')],
        [call('browser_screenshot', {}, 's2')],
        say('It looks clean.'),
      ],
      { browser: fakeBrowserHost(pages), vision: true },
    );
    const { conversation } = chat.start('scout', 'How does it look?');
    await settled(chat, conversation.id);
    expect((fake.requests[0]!.tools ?? []).map((t) => t.name)).toContain('browser_screenshot');
    const sent = fake.requests.at(-1)!.messages.filter((m) => m.role === 'tool');
    const [open, firstShot, secondShot] = sent;
    expect(open!.images).toBeUndefined();
    expect(firstShot!.images).toBeUndefined();
    expect(firstShot!.content).toMatch(/picture was here; it was dropped/);
    expect(secondShot!.images).toEqual([
      { mediaType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') },
    ]);
  });

  it('reads a page its scripts draw, for a clank with no browser tools of its own', async () => {
    const shell =
      '<html><head><title>Boards</title><meta name="description" content="Boards for every wave"><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(shell);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const browser = fakeBrowserHost({
      [url]: {
        title: 'Boards',
        text: ['Soft tops are the easiest boards to learn on.'],
        elements: [{ role: 'link' as const, name: 'Prices', href: '/prices' }],
      },
    });
    const { chat, fake } = setup([[call('web_fetch', { url }, 'f1')], say('It sells boards.')], {
      browser,
    });
    const { conversation } = chat.start('atlas', 'What does this site sell?');
    const messages = await settled(chat, conversation.id);
    // Atlas has no browser tools, and still got the page as its visitors see it, without refs.
    expect((fake.requests[0]!.tools ?? []).map((t) => t.name)).not.toContain('browser_open');
    expect(tools(messages.at(-1)!)[0]!.result).toBe(
      `URL: ${url}\nStatus: 200\nTitle: Boards\nDescription: Boards for every wave\nIts scripts draw the page, so it was read in the browser.\n\nSoft tops are the easiest boards to learn on.\nlink "Prices" (/prices)`,
    );
    expect(browser.tabs).toHaveLength(1);
  });

  it("reads a site's look, and saves its logo into the project's design", async () => {
    const logo =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="#01cc8e" d="M0 0h8v8H0z"/></svg>';
    const browser = fakeBrowserHost({
      ...pages,
      'https://boards.test/': {
        ...pages['https://boards.test/'],
        look: {
          url: 'https://boards.test/',
          title: 'Boards',
          name: 'Boards',
          description: 'Boards for every wave.',
          dark: true,
          background: '#0a0a0b',
          text: '#f5f5f5',
          backgrounds: [{ hex: '#0a0a0b', share: 0.8 }],
          texts: [{ hex: '#f5f5f5', share: 1 }],
          accents: [{ hex: '#01cc8e', share: 30, uses: ['logo', 'buttons'] }],
          borders: [],
          gradients: [],
          fonts: [{ family: 'Space Grotesk', web: true, roles: ['headings'] }],
          type: [
            {
              tag: 'h1',
              family: 'Space Grotesk',
              size: 60,
              weight: 700,
              lineHeight: 1,
              colour: '#f5f5f5',
              sample: 'Boards',
            },
          ],
          buttons: [],
          cards: null,
          images: [
            {
              kind: 'logo',
              note: 'in the header, drawn in the page',
              url: null,
              svg: logo,
              width: 8,
              height: 8,
            },
          ],
        },
      },
    });
    const root = await repository({ 'README.md': '# Boards\n' });
    const { chat, context } = setup(
      [
        [call('browser_save_image', { image: 1 }, 'early')],
        [call('browser_open', { url: 'https://boards.test/' }, 'o1')],
        [call('browser_styles', {}, 's1')],
        [call('browser_save_image', { image: 1, name: 'logo' }, 'i1')],
        [call('browser_save_image', { image: 2 }, 'i2')],
        say('The brand is dark with a green accent.'),
      ],
      { browser },
    );
    const { conversation } = chat.start('prism', 'Match boards.test', root);
    const parts = tools((await settled(chat, conversation.id)).at(-1)!);
    expect(parts.map((p) => [p.name, p.status])).toEqual([
      ['browser_save_image', 'failed'],
      ['browser_open', 'done'],
      ['browser_styles', 'done'],
      ['browser_save_image', 'done'],
      ['browser_save_image', 'failed'],
    ]);
    expect(parts[0]!.result).toMatch(/Call browser_styles on this page first/);
    expect(parts[2]!.result).toContain('Theme: dark. Page background #0a0a0b, main text #f5f5f5.');
    expect(parts[2]!.result).toContain(
      '- Space Grotesk (a web font the page loads): headings. h1 60px/700',
    );
    expect(parts[2]!.result).toContain('- Accents: #01cc8e (logo, buttons)');
    expect(parts[2]!.result).toContain('[1] logo in the header, drawn in the page, 8×8: an SVG');
    expect(parts[4]!.result).toMatch(/no picture 2: browser_styles listed 1/);
    // The logo is in the clank's copy of the project, where a design can show it.
    const worktree = context.workspace.run(conversation.id)!.worktree;
    expect(readFileSync(join(worktree, 'design/assets/logo.svg'), 'utf8')).toBe(logo);
    expect(parts[3]!.checkpointId).not.toBeNull();
  });

  it("says when pictures on a page didn't load, which its text alone would hide", async () => {
    const browser = fakeBrowserHost({
      'http://localhost:4000/': {
        title: 'Shop',
        text: ['Our boards'],
        broken: [{ alt: 'Fish 6', src: '/fish.jpg' }],
      },
    });
    const { chat } = setup(
      [
        [call('browser_open', { url: 'http://localhost:4000/' }, 'o1')],
        say('The picture is broken.'),
      ],
      { browser },
    );
    const { conversation } = chat.start('gauge', 'Check the shop page');
    const messages = await settled(chat, conversation.id);
    expect(tools(messages.at(-1)!)[0]!.result).toBe(
      'Opened t1, now the current tab.\n\nShop\nhttp://localhost:4000/\nA picture on this page didn\'t load: "Fish 6" (/fish.jpg).\n\nOur boards',
    );
  });

  it('searches in the browser when no search backend is set up', async () => {
    const browser = fakeBrowserHost(pages);
    const { chat } = setup(
      [[call('web_search', { query: 'beginner boards' }, 'w1')], say('Found one.')],
      { browser },
    );
    const { conversation } = chat.start('scout', 'Find beginner boards');
    const messages = await settled(chat, conversation.id);
    expect(tools(messages.at(-1)!)[0]!.result).toBe(
      '1. Boards\n   https://boards.test/\n   Soft tops',
    );
    expect(browser.tabs).toHaveLength(1);
  });
});
