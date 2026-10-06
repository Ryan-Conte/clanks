import type { GitHubDeviceCode, GitHubRepo, GitHubStatus, ProjectRepo } from '@clanks/core';
import { GitError, git } from '@clanks/workspace';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import type { SecretStore } from '../secrets';

/** A GitHub problem worded for the user. */
export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** The keychain entry for the GitHub token. */
export const GITHUB_TOKEN = 'github:token';
/** Who the token belongs to, so the window can say without asking GitHub. */
const GITHUB_USER = 'github.user';

const API = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface GitHubServiceOptions {
  secrets: SecretStore;
  /** Where who's signed in is kept: the app's internal settings. */
  store: { read(key: string): unknown; write(key: string, value: unknown): void };
  /**
   * The OAuth app that signing in with a code goes through. Without one, the user signs in with a
   * token they make on github.com.
   */
  clientId: string | null;
  fetch?: typeof fetch;
  /** Tests make polling instant. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
}

interface User {
  login: string;
  name: string | null;
}

interface RepoJson {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  html_url: string;
  pushed_at: string | null;
}

/**
 * The user's GitHub account: signing in, their repositories, making one, and cloning one for a
 * project. The token stays in the keychain and goes only to GitHub; a clone gets it through git's
 * environment, never its config, so it's never written to disk. Emits `change` when the sign-in
 * changes.
 */
export class GitHubService extends EventEmitter<{ change: [] }> {
  private device: { code: GitHubDeviceCode; controller: AbortController } | null = null;
  private error: string | null = null;

  constructor(private readonly options: GitHubServiceOptions) {
    super();
  }

  status(): GitHubStatus {
    const user = this.user();
    return {
      signedIn: this.options.secrets.has(GITHUB_TOKEN) && user !== null,
      login: user?.login ?? null,
      name: user?.name ?? null,
      deviceFlow: this.options.clientId !== null,
      device: this.device?.code ?? null,
      error: this.error,
    };
  }

  /** Signs in with a token the user made, once GitHub says whose it is. */
  async signInWithToken(token: string): Promise<GitHubStatus> {
    const user = await this.whoIs(token);
    this.save(token, user);
    return this.status();
  }

  /**
   * Starts signing in with a code: the user enters it on github.com, and the app picks up the token
   * once they have, in the background.
   */
  async startDeviceFlow(): Promise<GitHubDeviceCode> {
    const { clientId } = this.options;
    if (!clientId) throw new GitHubError('Signing in with a code needs a GitHub app; use a token');
    this.cancelDeviceFlow();
    const response = await this.post(DEVICE_CODE_URL, { client_id: clientId, scope: 'repo' });
    const body = (await response.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
      error_description?: string;
    };
    if (!body.device_code || !body.user_code || !body.verification_uri) {
      throw new GitHubError(
        `GitHub didn't start the sign-in${body.error_description ? `: ${body.error_description}` : ''}`,
      );
    }
    const code: GitHubDeviceCode = {
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresAt: new Date(this.now().getTime() + (body.expires_in ?? 900) * 1000),
    };
    const controller = new AbortController();
    this.device = { code, controller };
    this.error = null;
    this.emit('change');
    void this.poll(clientId, body.device_code, body.interval ?? 5, code, controller.signal);
    return code;
  }

  cancelDeviceFlow(): void {
    if (!this.device) return;
    this.device.controller.abort();
    this.device = null;
    this.emit('change');
  }

  signOut(): void {
    this.cancelDeviceFlow();
    this.options.secrets.delete(GITHUB_TOKEN);
    this.options.store.write(GITHUB_USER, null);
    this.error = null;
    this.emit('change');
  }

  /** The repositories the user can push to, most recently pushed first. */
  async repos(): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    for (let page = 1; page <= 5; page++) {
      const response = await this.api(
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
      );
      const list = (await response.json()) as RepoJson[];
      repos.push(...list.map(toRepo));
      if (list.length < 100) break;
    }
    return repos;
  }

  /** Makes a repository with a first commit, so there's a branch to work from. */
  async createRepo(input: {
    name: string;
    description: string;
    private: boolean;
  }): Promise<GitHubRepo> {
    const response = await this.api('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        private: input.private,
        auto_init: true,
      }),
    });
    return toRepo((await response.json()) as RepoJson);
  }

  /** Clones a repository into a folder that doesn't exist yet, or is empty. */
  async clone(fullName: string, into: string): Promise<ProjectRepo> {
    if (existsSync(into) && readdirSync(into).length > 0) {
      throw new GitHubError(`${into} isn't empty. Pick a new folder to clone into.`);
    }
    const token = this.token();
    const response = await this.api(`/repos/${fullName}`);
    const repo = toRepo((await response.json()) as RepoJson);
    try {
      await git(['clone', '--quiet', `https://github.com/${repo.fullName}.git`, into], {
        cwd: process.cwd(),
        env: authEnv(token),
      });
    } catch (error) {
      throw new GitHubError(
        `Couldn't clone ${repo.fullName}: ${error instanceof GitError ? error.stderr.split('\n').at(-1) || error.message : String(error)}`,
      );
    }
    return { fullName: repo.fullName, url: repo.url, private: repo.private };
  }

  private async poll(
    clientId: string,
    deviceCode: string,
    interval: number,
    code: GitHubDeviceCode,
    signal: AbortSignal,
  ): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    let wait = interval;
    try {
      while (!signal.aborted && this.now() < code.expiresAt) {
        await sleep(wait * 1000, signal);
        if (signal.aborted) return;
        const response = await this.post(ACCESS_TOKEN_URL, {
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        const body = (await response.json()) as {
          access_token?: string;
          error?: string;
          error_description?: string;
          interval?: number;
        };
        if (body.access_token) {
          const user = await this.whoIs(body.access_token);
          if (signal.aborted) return;
          this.device = null;
          this.save(body.access_token, user);
          return;
        }
        if (body.error === 'authorization_pending') continue;
        if (body.error === 'slow_down') {
          wait = body.interval ?? wait + 5;
          continue;
        }
        throw new GitHubError(
          body.error === 'access_denied'
            ? 'You cancelled the sign-in on GitHub'
            : body.error === 'expired_token'
              ? 'The code expired. Start again.'
              : `GitHub didn't sign you in: ${body.error_description ?? body.error ?? 'no reason given'}`,
        );
      }
      if (!signal.aborted) throw new GitHubError('The code expired. Start again.');
    } catch (error) {
      if (signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.device = null;
      this.emit('change');
    }
  }

  private save(token: string, user: User): void {
    this.options.secrets.set(GITHUB_TOKEN, token);
    this.options.store.write(GITHUB_USER, user);
    this.error = null;
    this.emit('change');
  }

  private user(): User | null {
    const value = this.options.store.read(GITHUB_USER) as Partial<User> | null | undefined;
    return value && typeof value.login === 'string'
      ? { login: value.login, name: typeof value.name === 'string' ? value.name : null }
      : null;
  }

  private token(): string {
    const token = this.options.secrets.get(GITHUB_TOKEN);
    if (!token) throw new GitHubError('Sign in to GitHub first');
    return token;
  }

  private async whoIs(token: string): Promise<User> {
    const response = await this.api('/user', {}, token);
    const body = (await response.json()) as { login: string; name: string | null };
    return { login: body.login, name: body.name };
  }

  private async api(path: string, init: RequestInit = {}, token = this.token()): Promise<Response> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${API}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'clanks',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      throw new GitHubError(
        `Couldn't reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      errors?: { message?: string }[];
    };
    const detail = body.errors?.[0]?.message ?? body.message ?? response.statusText;
    if (response.status === 401) {
      throw new GitHubError('GitHub turned the token down. Sign in again.');
    }
    throw new GitHubError(`GitHub said: ${detail}`);
  }

  private async post(url: string, body: Record<string, string>): Promise<Response> {
    try {
      return await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'clanks',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new GitHubError(
        `Couldn't reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/**
 * git's environment for talking to GitHub as the user: the token goes in a header set through
 * environment variables, which git reads for this one command and never saves.
 */
export function authEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function toRepo(json: RepoJson): GitHubRepo {
  return {
    fullName: json.full_name,
    name: json.name,
    owner: json.owner.login,
    description: json.description ?? '',
    private: json.private,
    defaultBranch: json.default_branch,
    url: json.html_url,
    pushedAt: json.pushed_at ? new Date(json.pushed_at) : null,
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
