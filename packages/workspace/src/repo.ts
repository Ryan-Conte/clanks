import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { GitError, git, runGit } from './git';

export interface RepoInfo {
  /** The repository's top folder. */
  root: string;
  /** Where its objects live, shared by every worktree of it. */
  commonDir: string;
  /** The checked-out commit. Null for a repository with no commits. */
  head: string | null;
}

/** The git repository a folder is in, or null if it's in none. */
export async function repoInfo(folder: string): Promise<RepoInfo | null> {
  let top: string;
  try {
    top = await git(['rev-parse', '--show-toplevel'], { cwd: folder });
  } catch (error) {
    if (error instanceof GitError && error.exitCode !== null) return null;
    throw error;
  }
  const root = resolve(top);
  const commonDir = resolve(
    root,
    await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }),
  );
  let head: string | null = null;
  try {
    head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd: root });
  } catch {
    // No commits yet.
  }
  return { root, commonDir, head: head || null };
}

/** Makes a folder a repository with everything in it committed, for "Set up git". */
export async function initRepo(folder: string): Promise<void> {
  await git(['init'], { cwd: folder });
  await git(['add', '-A'], { cwd: folder });
  await git(['commit', '--allow-empty', '-m', 'Initial commit'], {
    cwd: folder,
    env: await identity(folder, { name: 'clanks', email: 'clanks@localhost' }),
  });
}

/**
 * The user's git identity, or a stand-in when they haven't set one, so committing never fails for
 * want of a name.
 */
export async function identity(
  cwd: string,
  fallback: { name: string; email: string },
): Promise<Record<string, string>> {
  const read = (key: string) => git(['config', key], { cwd, okCodes: [1] }).catch(() => '');
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  const env: Record<string, string> = {};
  if (!name)
    Object.assign(env, { GIT_AUTHOR_NAME: fallback.name, GIT_COMMITTER_NAME: fallback.name });
  if (!email) {
    Object.assign(env, { GIT_AUTHOR_EMAIL: fallback.email, GIT_COMMITTER_EMAIL: fallback.email });
  }
  return env;
}

/**
 * Makes a worktree of `repoRoot` at `path` on a new branch from `base`. If the branch is there
 * already, from an earlier worktree, it's checked out as it is.
 */
export async function addWorktree(options: {
  repoRoot: string;
  path: string;
  branch: string;
  base: string;
}): Promise<void> {
  const { repoRoot, path, branch, base } = options;
  mkdirSync(dirname(path), { recursive: true });
  // A worktree removed by hand leaves an entry behind that would block the path.
  await git(['worktree', 'prune'], { cwd: repoRoot });
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
    okCodes: [1],
  });
  await git(
    exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base],
    { cwd: repoRoot },
  );
}

/**
 * Removes a worktree. Work left in it is committed to its branch first, so nothing a clank did is
 * lost: the branch stays for the user to merge or delete.
 */
export async function removeWorktree(options: {
  repoRoot: string;
  path: string;
  message: string;
}): Promise<void> {
  const { repoRoot, path, message } = options;
  if (existsSync(path)) {
    try {
      await git(['add', '-A'], { cwd: path });
      const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: path, okCodes: [1] });
      if (staged.exitCode === 1) {
        await git(['commit', '--no-verify', '-m', message], {
          cwd: path,
          env: await identity(path, { name: 'clanks', email: 'clanks@localhost' }),
        });
      }
    } catch (error) {
      console.error(`Couldn't save the work left in ${path}`, error);
    }
  }
  try {
    await git(['worktree', 'remove', '--force', path], { cwd: repoRoot });
  } catch {
    // Already gone, or git doesn't know it: the folder still goes.
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  }
  await git(['worktree', 'prune'], { cwd: repoRoot }).catch(() => {});
}

/** Where a folder is within its repository, so its worktree copy can be found. */
export function subfolderOf(repoRoot: string, folder: string): string {
  return relative(repoRoot, resolve(folder));
}
