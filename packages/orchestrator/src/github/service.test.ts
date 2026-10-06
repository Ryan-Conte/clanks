import { git } from '@clanks/workspace';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startTestOrchestrator, tempDir } from '../test-helpers';
import { GITHUB_TOKEN, authEnv } from './service';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stands in for github.com and its API, answering each address from a table. */
function fakeGitHub(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fake = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${url}`.startsWith(k));
    if (!key) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
      );
    }
    const answer = routes[key]!(call);
    return Promise.resolve(
      answer instanceof Response ? answer : new Response(JSON.stringify(answer)),
    );
  };
  return { fetch: fake, calls };
}

const user = () => ({ login: 'sam', name: 'Sam Surfer' });
const repo = (name: string) => ({
  full_name: `sam/${name}`,
  name,
  owner: { login: 'sam' },
  description: null,
  private: true,
  default_branch: 'main',
  html_url: `https://github.com/sam/${name}`,
  pushed_at: '2026-10-01T00:00:00Z',
});

describe('GitHub', () => {
  it('signs in with a token, which stays in the keychain', async () => {
    const github = fakeGitHub({
      'GET https://api.github.com/user/repos': () => [repo('surf-shop'), repo('blog')],
      'GET https://api.github.com/user': user,
      'POST https://api.github.com/user/repos': (call) =>
        repo((call.body as { name: string }).name),
    });
    const { context } = startTestOrchestrator({ githubFetch: github.fetch });
    expect(context.github.status()).toMatchObject({ signedIn: false, deviceFlow: false });

    const status = await context.github.signInWithToken(TOKEN);
    expect(status).toMatchObject({ signedIn: true, login: 'sam', name: 'Sam Surfer' });
    expect(context.secrets.get(GITHUB_TOKEN)).toBe(TOKEN);
    expect(github.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const repos = await context.github.repos();
    expect(repos.map((r) => [r.fullName, r.private, r.defaultBranch])).toEqual([
      ['sam/surf-shop', true, 'main'],
      ['sam/blog', true, 'main'],
    ]);
    const made = await context.github.createRepo({
      name: 'quiver',
      description: '',
      private: true,
    });
    expect(made.fullName).toBe('sam/quiver');
    expect(github.calls.at(-1)!.body).toMatchObject({ name: 'quiver', auto_init: true });

    context.github.signOut();
    expect(context.github.status().signedIn).toBe(false);
    expect(context.secrets.has(GITHUB_TOKEN)).toBe(false);
  });

  it('says when GitHub turns a token down', async () => {
    const github = fakeGitHub({
      'GET https://api.github.com/user': () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
    });
    const { context } = startTestOrchestrator({ githubFetch: github.fetch });
    await expect(context.github.signInWithToken(TOKEN)).rejects.toThrow(
      'GitHub turned the token down',
    );
    expect(context.secrets.has(GITHUB_TOKEN)).toBe(false);
  });

  it('signs in with a code, waiting while the user enters it', async () => {
    let polls = 0;
    const github = fakeGitHub({
      'POST https://github.com/login/device/code': () => ({
        device_code: 'dev-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }),
      'POST https://github.com/login/oauth/access_token': () => {
        polls++;
        if (polls === 1) return { error: 'authorization_pending' };
        if (polls === 2) return { error: 'slow_down', interval: 10 };
        return { access_token: TOKEN };
      },
      'GET https://api.github.com/user': user,
    });
    const { context } = startTestOrchestrator({
      githubFetch: github.fetch,
      githubClientId: 'Iv1.test',
      githubSleep: () => Promise.resolve(),
    });
    expect(context.github.status().deviceFlow).toBe(true);
    const code = await context.github.startDeviceFlow();
    expect(code).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    });
    for (let i = 0; i < 100 && !context.github.status().signedIn; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(context.github.status()).toMatchObject({ signedIn: true, login: 'sam', device: null });
    expect(polls).toBe(3);
    expect(github.calls[0]!.body).toEqual({ client_id: 'Iv1.test', scope: 'repo' });
  });

  it('passes the token to git without writing it down', () => {
    const env = authEnv(TOKEN);
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.split(' ').at(-1)!, 'base64').toString()).toBe(
      `x-access-token:${TOKEN}`,
    );
  });

  it("won't clone into a folder that has things in it", async () => {
    const github = fakeGitHub({ 'GET https://api.github.com/user': user });
    const { context } = startTestOrchestrator({ githubFetch: github.fetch });
    await context.github.signInWithToken(TOKEN);
    const into = tempDir();
    writeFileSync(join(into, 'notes.txt'), 'mine');
    await expect(context.github.clone('sam/surf-shop', into)).rejects.toThrow("isn't empty");
  });
});

describe('projects', () => {
  it('make a folder that is not a repository into one, so the crew can work on copies', async () => {
    const { context } = startTestOrchestrator();
    const folder = join(tempDir(), 'zine');
    mkdirSync(folder);
    writeFileSync(join(folder, 'idea.md'), '# A zine\n');
    expect((await context.projects.checkFolder(folder)).status).toBe('not_repo');
    expect((await context.projects.checkFolder(join(folder, 'nope'))).status).toBe('missing');

    const project = await context.projects.create({
      name: 'Zine',
      brief: '',
      key: 'ZINE',
      workspace: { kind: 'folder', path: folder },
      crew: ['quill', 'atlas'],
      model: null,
      models: { quill: { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
    });
    expect(existsSync(join(folder, '.git'))).toBe(true);
    expect(await git(['log', '--format=%s'], { cwd: folder })).toBe('Initial commit');
    expect(await git(['ls-files'], { cwd: folder })).toBe('idea.md');
    expect(context.projects.members(project.id)).toEqual([
      { clankId: 'atlas', model: null },
      { clankId: 'quill', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } },
    ]);
    expect(context.projects.modelFor(project.id, 'quill')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
    });
    expect(context.projects.modelFor(project.id, 'atlas')).toBeNull();
    expect(context.board.summaries()).toMatchObject([
      { name: 'Zine', key: 'ZINE', counts: { backlog: 0 }, needsYou: 0, working: 0 },
    ]);
  });
});
