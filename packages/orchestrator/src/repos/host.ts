import type { ProjectRepo, RepoHost } from '@clanks/core';

/** A pull request, or GitLab's merge request, as the app keeps track of it. */
export interface PullRequest {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  /** The commit at the tip of its branch. */
  head: string;
  /** Whether the host can merge it as it is. Null while the host is still working it out. */
  mergeable: boolean | null;
}

/** How the checks a host runs on a commit are doing. Null when it runs none. */
export type CheckState = 'pending' | 'passing' | 'failing' | null;

/**
 * What delivering a ticket's work needs from where the project's repository is hosted: cloning,
 * pushing the crew's branches, and the request to merge each one. GitHub and GitLab both do these.
 */
export interface RepoHostClient {
  readonly host: RepoHost;
  /** Whether the user is signed in, so the app can push and merge as them. */
  signedIn(): boolean;
  /** Clones a repository into a folder that doesn't exist yet, or is empty. */
  clone(fullName: string, into: string): Promise<ProjectRepo>;
  /** Pushes one of the crew's own `clanks/*` branches, never with force. */
  push(folder: string, branch: string): Promise<void>;
  fetch(folder: string, branch: string): Promise<void>;
  /** Opens a request to merge a branch, or finds the one already open for it. */
  openPullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequest>;
  pullRequest(repo: string, number: number): Promise<PullRequest>;
  /** Merges it, as the user who approved it. Resolves with the merge commit. */
  mergePullRequest(repo: string, number: number, title: string): Promise<string>;
  closePullRequest(repo: string, number: number): Promise<void>;
  checks(repo: string, sha: string): Promise<CheckState>;
}

/** Only the crew's own branches are ever pushed. */
export function isCrewBranch(branch: string): boolean {
  return /^clanks\/[\w.-]+$/.test(branch);
}

/**
 * git's environment for talking to a host as the user: the token goes in a header set through
 * environment variables, which git reads for this one command and never saves.
 */
export function gitAuthEnv(origin: string, user: string, token: string): Record<string, string> {
  const basic = Buffer.from(`${user}:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin.replace(/\/+$/, '')}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}
