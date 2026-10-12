import { git } from '@clanks/workspace';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitEnv } from '../board/test-kit';
import { gitAuthEnv } from '../repos/host';
import { startTestOrchestrator, tempDir } from '../test-helpers';
import { GITLAB_TOKEN } from './service';

const TOKEN = 'glpat-abcdefghijklmnopqrst';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stands in for a GitLab's API, answering each address from a table. */
function fakeGitLab(routes: Record<string, (call: Call) => unknown>) {
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
        new Response(JSON.stringify({ message: '404 Not found' }), { status: 404 }),
      );
    }
    const answer = routes[key]!(call);
    return Promise.resolve(
      answer instanceof Response ? answer : new Response(JSON.stringify(answer)),
    );
  };
  return { fetch: fake, calls };
}

const API = 'https://gitlab.com/api/v4';
const user = () => ({ username: 'sam', name: 'Sam Surfer' });
const project = (path: string, visibility = 'private') => ({
  path_with_namespace: path,
  name: path.split('/').at(-1),
  namespace: { full_path: path.split('/').slice(0, -1).join('/') },
  description: null,
  visibility,
  default_branch: 'main',
  web_url: `https://gitlab.com/${path}`,
  last_activity_at: '2026-10-01T00:00:00Z',
});
const mergeRequest = (extra: Record<string, unknown> = {}) => ({
  iid: 7,
  web_url: 'https://gitlab.com/surf/shop/-/merge_requests/7',
  state: 'opened',
  sha: 'a'.repeat(40),
  detailed_merge_status: 'mergeable',
  ...extra,
});

describe('GitLab', () => {
  it('signs in with a token, which stays in the keychain, and lists what the user can push to', async () => {
    const gitlab = fakeGitLab({
      [`GET ${API}/user`]: user,
      [`GET ${API}/projects?`]: () => [project('surf/shop'), project('surf/team/blog', 'public')],
      [`POST ${API}/projects`]: (call) => project(`sam/${(call.body as { name: string }).name}`),
    });
    const { context } = startTestOrchestrator({ gitlabFetch: gitlab.fetch });
    expect(context.gitlab.status()).toMatchObject({
      signedIn: false,
      baseUrl: 'https://gitlab.com',
    });
    await expect(context.gitlab.repos()).rejects.toThrow('Sign in to GitLab first');

    const status = await context.gitlab.signIn(TOKEN);
    expect(status).toMatchObject({ signedIn: true, login: 'sam', name: 'Sam Surfer' });
    expect(context.secrets.get(GITLAB_TOKEN)).toBe(TOKEN);
    expect(gitlab.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const repos = await context.gitlab.repos();
    expect(repos.map((r) => [r.fullName, r.name, r.owner, r.private])).toEqual([
      ['surf/shop', 'shop', 'surf', true],
      ['surf/team/blog', 'blog', 'surf/team', false],
    ]);
    expect(gitlab.calls.at(-1)!.url).toContain('membership=true&min_access_level=30');

    const made = await context.gitlab.createRepo({
      name: 'boards',
      description: '',
      private: true,
    });
    expect(made.fullName).toBe('sam/boards');
    expect(gitlab.calls.at(-1)!.body).toMatchObject({
      name: 'boards',
      visibility: 'private',
      initialize_with_readme: true,
    });

    context.gitlab.signOut();
    expect(context.gitlab.status().signedIn).toBe(false);
    expect(context.secrets.has(GITLAB_TOKEN)).toBe(false);
  });

  it('signs in to a GitLab a team hosts, and says when the token is turned down', async () => {
    const gitlab = fakeGitLab({
      'GET https://git.example.com/api/v4/user': user,
      [`GET ${API}/user`]: () =>
        new Response(JSON.stringify({ message: '401 Unauthorized' }), { status: 401 }),
    });
    const { context } = startTestOrchestrator({ gitlabFetch: gitlab.fetch });
    await expect(context.gitlab.signIn(TOKEN)).rejects.toThrow(
      'GitLab turned the token down. Sign in again.',
    );
    expect(context.gitlab.status().signedIn).toBe(false);
    const status = await context.gitlab.signIn(TOKEN, 'https://git.example.com/');
    expect(status).toMatchObject({ signedIn: true, baseUrl: 'https://git.example.com' });
  });

  it('opens a merge request for a branch, or finds the one already open', async () => {
    let open: unknown[] = [];
    const gitlab = fakeGitLab({
      [`GET ${API}/user`]: user,
      [`GET ${API}/projects/surf%2Fshop/merge_requests?state=opened`]: () => open,
      [`POST ${API}/projects/surf%2Fshop/merge_requests`]: () => mergeRequest(),
    });
    const { context } = startTestOrchestrator({ gitlabFetch: gitlab.fetch });
    await context.gitlab.signIn(TOKEN);
    const input = {
      repo: 'surf/shop',
      head: 'clanks/SURF-1',
      base: 'main',
      title: 'SURF-1: List boards',
      body: 'Made by the crew.',
    };
    expect(await context.gitlab.openPullRequest(input)).toEqual({
      number: 7,
      url: 'https://gitlab.com/surf/shop/-/merge_requests/7',
      state: 'open',
      head: 'a'.repeat(40),
      mergeable: true,
    });
    expect(gitlab.calls.at(-1)!.body).toEqual({
      source_branch: 'clanks/SURF-1',
      target_branch: 'main',
      title: 'SURF-1: List boards',
      description: 'Made by the crew.',
      remove_source_branch: false,
    });
    open = [mergeRequest({ has_conflicts: true })];
    const posts = gitlab.calls.filter((c) => c.method === 'POST').length;
    expect(await context.gitlab.openPullRequest(input)).toMatchObject({
      number: 7,
      mergeable: false,
    });
    expect(gitlab.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);
  });

  it('merges, closes and reads the pipeline of a merge request', async () => {
    let pipeline: { status: string }[] = [];
    let mergeable = true;
    const gitlab = fakeGitLab({
      [`GET ${API}/user`]: user,
      [`PUT ${API}/projects/surf%2Fshop/merge_requests/7/merge`]: () =>
        mergeable
          ? mergeRequest({ state: 'merged', merge_commit_sha: 'b'.repeat(40) })
          : new Response(JSON.stringify({ message: 'Branch cannot be merged' }), { status: 406 }),
      [`PUT ${API}/projects/surf%2Fshop/merge_requests/7`]: () => mergeRequest({ state: 'closed' }),
      [`GET ${API}/projects/surf%2Fshop/merge_requests/7`]: () => mergeRequest({ state: 'merged' }),
      [`GET ${API}/projects/surf%2Fshop/pipelines`]: () => pipeline,
    });
    const { context } = startTestOrchestrator({ gitlabFetch: gitlab.fetch });
    await context.gitlab.signIn(TOKEN);
    expect(await context.gitlab.mergePullRequest('surf/shop', 7, 'Merge SURF-1')).toBe(
      'b'.repeat(40),
    );
    expect(gitlab.calls.at(-1)!.body).toEqual({
      merge_commit_message: 'Merge SURF-1',
      should_remove_source_branch: false,
    });
    mergeable = false;
    await expect(context.gitlab.mergePullRequest('surf/shop', 7, 'x')).rejects.toThrow(
      "GitLab didn't merge it: it has a conflict (Branch cannot be merged)",
    );
    expect((await context.gitlab.pullRequest('surf/shop', 7)).state).toBe('merged');
    await context.gitlab.closePullRequest('surf/shop', 7);
    expect(gitlab.calls.at(-1)!.body).toEqual({ state_event: 'close' });

    const checks = () => context.gitlab.checks('surf/shop', 'a'.repeat(40));
    expect(await checks()).toBeNull();
    pipeline = [{ status: 'running' }];
    expect(await checks()).toBe('pending');
    pipeline = [{ status: 'success' }];
    expect(await checks()).toBe('passing');
    pipeline = [{ status: 'failed' }];
    expect(await checks()).toBe('failing');
  });

  it('clones a project for a workspace, and pushes only the crew’s own branches', async () => {
    // A bare repository on disk stands in for the one on gitlab.com.
    const remote = join(tempDir(), 'shop.git');
    const seed = join(tempDir(), 'seed');
    mkdirSync(seed);
    await git(['init', '--quiet', '-b', 'main'], { cwd: seed });
    writeFileSync(join(seed, 'README.md'), '# Shop\n');
    await git(['add', '-A'], { cwd: seed });
    await git(['commit', '--quiet', '-m', 'Start'], { cwd: seed, env: gitEnv });
    await git(['clone', '--quiet', '--bare', seed, remote], { cwd: seed });
    const gitlab = fakeGitLab({
      [`GET ${API}/user`]: user,
      [`GET ${API}/projects/surf%2Fshop`]: () => ({
        ...project('surf/shop'),
        // `.git` is added to it, which is how the stand-in on disk is named.
        web_url: remote.replace(/\\/g, '/').replace(/\.git$/, ''),
      }),
    });
    const { context } = startTestOrchestrator({ gitlabFetch: gitlab.fetch });
    await context.gitlab.signIn(TOKEN);
    const into = join(tempDir(), 'clone');
    const cloned = await context.gitlab.clone('surf/shop', into);
    expect(cloned).toMatchObject({ host: 'gitlab', fullName: 'surf/shop', private: true });
    expect(existsSync(join(into, 'README.md'))).toBe(true);

    await git(['branch', 'clanks/SURF-1'], { cwd: into });
    await context.gitlab.push(into, 'clanks/SURF-1');
    expect(await git(['branch', '--list', 'clanks/SURF-1'], { cwd: remote })).toContain(
      'clanks/SURF-1',
    );
    await expect(context.gitlab.push(into, 'main')).rejects.toThrow(
      "Only the crew's own branches are pushed, not main",
    );
    await context.gitlab.fetch(into, 'main');
  });

  it('gives git the token for one command, as a header for that host only', () => {
    expect(gitAuthEnv('https://git.example.com/', 'oauth2', TOKEN)).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://git.example.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')}`,
    });
  });
});
