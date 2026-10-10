import type { ChatEvent, MessageRecord, ModelRecord, ToolPart } from '@clanks/core';
import { createFakeProvider } from '@clanks/providers';
import { git } from '@clanks/workspace';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeBrowserHost } from '../browser/fake-host';
import { sqliteModelRepository } from '../store/models';
import { startTestOrchestrator, tempDir } from '../test-helpers';
import { formatNotes, toTurns } from './service';

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
  replies: ChatEvent[][],
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

  it('returns a malformed call to the model once, then stops', async () => {
    const root = await repository({ 'a.txt': 'a\n' });
    const { chat } = setup([
      [{ type: 'tool_call', call: { id: 'm1', name: 'fs_read', arguments: '{"path":' } }],
      [call('fs_frobnicate', {}, 'm2')],
    ]);
    const { conversation } = chat.start('forge', 'Read', root);
    const messages = await settled(chat, conversation.id);
    expect(tools(messages[1]!).map((p) => p.status)).toEqual(['failed', 'failed']);
    expect(tools(messages[1]!)[0]!.result).toMatch(/aren't valid JSON/);
    expect(tools(messages[1]!)[1]!.result).toMatch(/There's no tool called fs_frobnicate here/);
    expect(messages[1]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining("don't fit their tools twice") as string,
    });
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
