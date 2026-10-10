import type { ChatEvent, ChatRequest, ModelRecord } from '@clanks/core';
import { createFakeProvider } from '@clanks/providers';
import { git } from '@clanks/workspace';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DesignHost } from '../design/service';
import { sqliteModelRepository } from '../store/models';
import { startTestOrchestrator, tempDir } from '../test-helpers';

export const MODEL = 'tiny:1b';

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

export const SPEC = `# Surf shop: spec

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

export const call = (name: string, args: object): ChatEvent => ({
  type: 'tool_call',
  call: {
    id: `${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: JSON.stringify(args),
  },
});

export const say = (text: string): ChatEvent[] => [{ type: 'text', text }];

/** Which conversation a request is from, by what its system prompt says. */
export function who(request: ChatRequest): string {
  const system = request.messages[0]!.content;
  const name = /^You are (\w+)/.exec(system)?.[1] ?? '?';
  const mode = /Mode: (\w+)/.exec(system)?.[1] ?? '?';
  return `${name.toLowerCase()} ${mode}`;
}

export type Script = ChatEvent[][] | ((request: ChatRequest) => ChatEvent[]);

/**
 * Replays a script per conversation: each reply is picked by who's asking and how many times the
 * model has spoken in that conversation already, or by a function of the request.
 */
export function scripted(scripts: Record<string, Script>) {
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

export const gitEnv = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** A repository on `main` with one commit, as a project's workspace. */
export async function repository(): Promise<string> {
  const root = join(tempDir(), 'surf');
  mkdirSync(root);
  await git(['init', '--quiet', '-b', 'main'], { cwd: root });
  await git(['config', 'core.autocrlf', 'false'], { cwd: root });
  await git(['config', 'user.name', 'Test'], { cwd: root });
  await git(['config', 'user.email', 'test@example.com'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# Surf shop\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '--quiet', '-m', 'Start'], { cwd: root, env: gitEnv });
  return root;
}

/** An orchestrator with a pulled model that replays scripts, and a project on a fresh repo. */
export async function setup(
  scripts: Record<string, Script>,
  options: {
    crew?: string[];
    held?: boolean;
    githubFetch?: typeof fetch;
    /** Stands in for the app's hidden window, so designs can be measured and drawn. */
    designHost?: DesignHost;
  } = {},
) {
  const orchestrator = startTestOrchestrator({
    ...(options.githubFetch ? { githubFetch: options.githubFetch } : {}),
    ...(options.designHost ? { designHost: options.designHost } : {}),
  });
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
  const folder = await repository();
  const project = await context.projects.create({
    name: 'Surf shop',
    brief: 'A website that sells surf boards.',
    key: 'SURF',
    workspace: { kind: 'folder', path: folder },
    crew: options.crew ?? ['scribe', 'prism', 'forge', 'gauge'],
    model: null,
    models: {},
  });
  if (options.held) context.projects.update(project.id, { held: true });
  return {
    orchestrator,
    context,
    fake,
    project,
    folder,
    board: context.board,
    chat: context.chat,
  };
}

export async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting until ${what}`);
}

export const quiet = (context: { chat: { list(): { replying: boolean }[] } }) =>
  context.chat.list().every((c) => !c.replying);
