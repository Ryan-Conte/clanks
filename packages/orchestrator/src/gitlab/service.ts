import {
  DEFAULT_GITLAB_URL,
  type GitHubRepo,
  type GitLabStatus,
  type ProjectRepo,
} from '@clanks/core';
import { GitError, git } from '@clanks/workspace';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import {
  type CheckState,
  type PullRequest,
  type RepoHostClient,
  gitAuthEnv,
  isCrewBranch,
} from '../repos/host';
import type { SecretStore } from '../secrets';

/** A GitLab problem worded for the user. */
export class GitLabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitLabError';
  }
}

/** The keychain entry for the GitLab token. */
export const GITLAB_TOKEN = 'gitlab:token';
/** Who the token belongs to and which GitLab it's for, so the window can say without asking. */
const GITLAB_USER = 'gitlab.user';

export interface GitLabServiceOptions {
  secrets: SecretStore;
  /** Where who's signed in is kept: the app's internal settings. */
  store: { read(key: string): unknown; write(key: string, value: unknown): void };
  fetch?: typeof fetch;
}

interface User {
  login: string;
  name: string | null;
  baseUrl: string;
}

interface ProjectJson {
  path_with_namespace: string;
  name: string;
  namespace?: { full_path?: string };
  description: string | null;
  visibility?: string;
  default_branch: string | null;
  web_url: string;
  last_activity_at: string | null;
}

interface MergeRequestJson {
  iid: number;
  web_url: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  sha: string | null;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
}

/**
 * The user's GitLab account, on gitlab.com or a GitLab a team hosts: signing in with a token, their
 * projects, making one, cloning one, and the merge requests the crew's branches go through. The
 * token stays in the keychain and goes only to that GitLab; git gets it through its environment,
 * never its config. Emits `change` when the sign-in changes.
 */
export class GitLabService extends EventEmitter<{ change: [] }> implements RepoHostClient {
  readonly host = 'gitlab' as const;
  private error: string | null = null;

  constructor(private readonly options: GitLabServiceOptions) {
    super();
  }

  status(): GitLabStatus {
    const user = this.user();
    return {
      signedIn: this.options.secrets.has(GITLAB_TOKEN) && user !== null,
      login: user?.login ?? null,
      name: user?.name ?? null,
      baseUrl: user?.baseUrl ?? DEFAULT_GITLAB_URL,
      error: this.error,
    };
  }

  signedIn(): boolean {
    return this.status().signedIn;
  }

  /** Signs in with a token the user made, once that GitLab says whose it is. */
  async signIn(token: string, baseUrl = ''): Promise<GitLabStatus> {
    const base = (baseUrl.trim() || DEFAULT_GITLAB_URL).replace(/\/+$/, '');
    const response = await this.api('/user', {}, { token, base });
    const body = (await response.json()) as { username: string; name: string | null };
    this.options.secrets.set(GITLAB_TOKEN, token);
    this.options.store.write(GITLAB_USER, {
      login: body.username,
      name: body.name,
      baseUrl: base,
    } satisfies User);
    this.error = null;
    this.emit('change');
    return this.status();
  }

  signOut(): void {
    this.options.secrets.delete(GITLAB_TOKEN);
    this.options.store.write(GITLAB_USER, null);
    this.error = null;
    this.emit('change');
  }

  /** The projects the user can push to, most recently active first. */
  async repos(): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    for (let page = 1; page <= 5; page++) {
      const response = await this.api(
        `/projects?membership=true&min_access_level=30&archived=false&order_by=last_activity_at&per_page=100&page=${page}`,
      );
      const list = (await response.json()) as ProjectJson[];
      repos.push(...list.map(toRepo));
      if (list.length < 100) break;
    }
    return repos;
  }

  /** Makes a project with a first commit, so there's a branch to work from. */
  async createRepo(input: {
    name: string;
    description: string;
    private: boolean;
  }): Promise<GitHubRepo> {
    const response = await this.api('/projects', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        path: input.name,
        description: input.description,
        visibility: input.private ? 'private' : 'public',
        initialize_with_readme: true,
      }),
    });
    return toRepo((await response.json()) as ProjectJson);
  }

  async clone(fullName: string, into: string): Promise<ProjectRepo> {
    if (existsSync(into) && readdirSync(into).length > 0) {
      throw new GitLabError(`${into} isn't empty. Pick a new folder to clone into.`);
    }
    const response = await this.api(`/projects/${encodeURIComponent(fullName)}`);
    const repo = toRepo((await response.json()) as ProjectJson);
    try {
      await git(['clone', '--quiet', `${repo.url}.git`, into], {
        cwd: process.cwd(),
        env: this.authEnv(),
      });
    } catch (error) {
      throw new GitLabError(`Couldn't clone ${repo.fullName}: ${gitMessage(error, true)}`);
    }
    return { host: 'gitlab', fullName: repo.fullName, url: repo.url, private: repo.private };
  }

  async push(folder: string, branch: string): Promise<void> {
    if (!isCrewBranch(branch)) {
      throw new GitLabError(`Only the crew's own branches are pushed, not ${branch}`);
    }
    try {
      await git(['push', '--quiet', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
        cwd: folder,
        env: this.authEnv(),
      });
    } catch (error) {
      throw new GitLabError(`Couldn't push ${branch}: ${gitMessage(error)}`);
    }
  }

  async fetch(folder: string, branch: string): Promise<void> {
    try {
      await git(['fetch', '--quiet', 'origin', branch], { cwd: folder, env: this.authEnv() });
    } catch (error) {
      throw new GitLabError(`Couldn't fetch ${branch}: ${gitMessage(error)}`);
    }
  }

  async openPullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest> {
    const project = encodeURIComponent(input.repo);
    const open = await this.api(
      `/projects/${project}/merge_requests?state=opened&source_branch=${encodeURIComponent(input.head)}`,
    );
    const found = ((await open.json()) as MergeRequestJson[])[0];
    if (found) return toPull(found);
    const response = await this.api(`/projects/${project}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({
        source_branch: input.head,
        target_branch: input.base,
        title: input.title,
        description: input.body,
        remove_source_branch: false,
      }),
    });
    return toPull((await response.json()) as MergeRequestJson);
  }

  async pullRequest(repo: string, number: number): Promise<PullRequest> {
    const response = await this.api(
      `/projects/${encodeURIComponent(repo)}/merge_requests/${number}`,
    );
    return toPull((await response.json()) as MergeRequestJson);
  }

  async mergePullRequest(repo: string, number: number, title: string): Promise<string> {
    const response = await this.api(
      `/projects/${encodeURIComponent(repo)}/merge_requests/${number}/merge`,
      {
        method: 'PUT',
        body: JSON.stringify({ merge_commit_message: title, should_remove_source_branch: false }),
      },
    );
    const body = (await response.json()) as MergeRequestJson;
    const sha = body.merge_commit_sha ?? body.squash_commit_sha ?? body.sha;
    if (body.state !== 'merged' || !sha) {
      throw new GitLabError("GitLab didn't merge it: it isn't mergeable yet");
    }
    return sha;
  }

  async closePullRequest(repo: string, number: number): Promise<void> {
    await this.api(`/projects/${encodeURIComponent(repo)}/merge_requests/${number}`, {
      method: 'PUT',
      body: JSON.stringify({ state_event: 'close' }),
    });
  }

  /** How the newest pipeline on a commit is doing. */
  async checks(repo: string, sha: string): Promise<CheckState> {
    const response = await this.api(
      `/projects/${encodeURIComponent(repo)}/pipelines?sha=${encodeURIComponent(sha)}&per_page=1`,
    );
    const status = ((await response.json()) as { status: string }[])[0]?.status;
    if (!status || status === 'skipped') return null;
    if (status === 'success') return 'passing';
    if (status === 'failed' || status === 'canceled') return 'failing';
    return 'pending';
  }

  private user(): User | null {
    const value = this.options.store.read(GITLAB_USER) as Partial<User> | null | undefined;
    return value && typeof value.login === 'string'
      ? {
          login: value.login,
          name: typeof value.name === 'string' ? value.name : null,
          baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : DEFAULT_GITLAB_URL,
        }
      : null;
  }

  private token(): string {
    const token = this.options.secrets.get(GITLAB_TOKEN);
    if (!token) throw new GitLabError('Sign in to GitLab first');
    return token;
  }

  private authEnv(): Record<string, string> {
    const base = this.user()?.baseUrl ?? DEFAULT_GITLAB_URL;
    return gitAuthEnv(new URL(base).origin, 'oauth2', this.token());
  }

  private async api(
    path: string,
    init: RequestInit = {},
    as?: { token: string; base: string },
  ): Promise<Response> {
    const token = as?.token ?? this.token();
    const base = as?.base ?? this.user()?.baseUrl ?? DEFAULT_GITLAB_URL;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${base}/api/v4${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'clanks',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      throw new GitLabError(
        `Couldn't reach GitLab at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as {
      message?: unknown;
      error?: string;
      error_description?: string;
    };
    if (response.status === 401) {
      throw new GitLabError('GitLab turned the token down. Sign in again.');
    }
    if (response.status === 405 || response.status === 406 || response.status === 422) {
      const said = detailOf(body) || response.statusText;
      throw new GitLabError(
        /merge/i.test(path) && response.status !== 422
          ? `GitLab didn't merge it: ${response.status === 406 ? 'it has a conflict' : 'it is not mergeable yet'} (${said})`
          : `GitLab said: ${said}`,
      );
    }
    throw new GitLabError(`GitLab said: ${detailOf(body) || response.statusText}`);
  }
}

/** GitLab's error bodies say what's wrong as a string, a list, or a list per field. */
function detailOf(body: { message?: unknown; error?: string; error_description?: string }): string {
  const { message } = body;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  if (message && typeof message === 'object') {
    return Object.entries(message as Record<string, unknown>)
      .map(([field, said]) => `${field} ${Array.isArray(said) ? said.join(', ') : String(said)}`)
      .join('; ');
  }
  return body.error_description ?? body.error ?? '';
}

function gitMessage(error: unknown, last = false): string {
  if (!(error instanceof GitError)) return String(error);
  const lines = error.stderr.split('\n').filter((l) => l.trim());
  return (last ? lines.at(-1) : lines[0]) ?? error.message;
}

function toPull(json: MergeRequestJson): PullRequest {
  const status = json.detailed_merge_status ?? json.merge_status ?? '';
  return {
    number: json.iid,
    url: json.web_url,
    state: json.state === 'opened' || json.state === 'locked' ? 'open' : json.state,
    head: json.sha ?? '',
    mergeable:
      json.has_conflicts || status === 'cannot_be_merged' || status === 'conflict'
        ? false
        : status === 'can_be_merged' || status === 'mergeable'
          ? true
          : null,
  };
}

function toRepo(json: ProjectJson): GitHubRepo {
  const owner =
    json.namespace?.full_path ?? json.path_with_namespace.split('/').slice(0, -1).join('/');
  return {
    fullName: json.path_with_namespace,
    name: json.path_with_namespace.split('/').at(-1) ?? json.name,
    owner,
    description: json.description ?? '',
    private: json.visibility !== 'public',
    defaultBranch: json.default_branch ?? 'main',
    url: json.web_url,
    pushedAt: json.last_activity_at ? new Date(json.last_activity_at) : null,
  };
}
