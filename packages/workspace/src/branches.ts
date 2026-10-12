import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GitError, git, runGit } from './git';
import { identity } from './repo';

/** The commit a branch, tag or commit names, or null when it names nothing. */
export async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  const out = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: repo,
    okCodes: [1],
  }).catch(() => '');
  return out || null;
}

/** The branch a folder has checked out, or null when its HEAD is detached. */
export async function currentBranch(folder: string): Promise<string | null> {
  const out = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: folder,
    okCodes: [1],
  }).catch(() => '');
  return out || null;
}

/** Whether `ancestor` is in `commit`'s history. */
export async function isAncestor(repo: string, ancestor: string, commit: string): Promise<boolean> {
  const result = await runGit(['merge-base', '--is-ancestor', ancestor, commit], {
    cwd: repo,
    okCodes: [1],
  });
  return result.exitCode === 0;
}

/** Where two lines of history last met. */
export async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  const out = await git(['merge-base', a, b], { cwd: repo, okCodes: [1] }).catch(() => '');
  return out || null;
}

/** The worktree a branch is checked out in, if any: the main checkout or another worktree. */
export async function worktreeOf(repo: string, branch: string): Promise<string | null> {
  const list = await git(['worktree', 'list', '--porcelain'], { cwd: repo });
  let path: string | null = null;
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
    else if (line.trim() === `branch refs/heads/${branch}` && path) return resolve(path);
  }
  return null;
}

/** What merging a branch did. */
export interface MergeResult {
  /** The commit the base branch is at now. */
  commit: string;
  /** It was in the base already, so nothing changed. */
  already: boolean;
}

/** A merge that couldn't happen, because the branches change the same lines. */
export class MergeConflictError extends Error {
  constructor(readonly files: string[]) {
    super(
      files.length > 0
        ? `It conflicts with the base in ${files.join(', ')}`
        : 'It conflicts with the base',
    );
    this.name = 'MergeConflictError';
  }
}

/** The base branch moved, or has changes in its checkout the merge would overwrite. */
export class MergeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeBlockedError';
  }
}

/**
 * Merges a branch into a base branch with a merge commit, without touching anyone's half-done
 * work. The merge is made in a scratch worktree. Then, where the base is checked out (the user's
 * own checkout, usually), it's fast-forwarded there, which git refuses if it would overwrite
 * changes the user hasn't committed; elsewhere the branch is moved, only if it hasn't moved since.
 */
export async function mergeBranch(options: {
  repoRoot: string;
  base: string;
  branch: string;
  message: string;
  /** Where the scratch worktree goes. */
  scratchDir: string;
}): Promise<MergeResult> {
  const { repoRoot, base, branch } = options;
  const baseTip = await resolveCommit(repoRoot, `refs/heads/${base}`);
  if (!baseTip) throw new MergeBlockedError(`There's no branch called ${base}`);
  const branchTip = await resolveCommit(repoRoot, `refs/heads/${branch}`);
  if (!branchTip) throw new MergeBlockedError(`There's no branch called ${branch}`);
  if (await isAncestor(repoRoot, branchTip, baseTip)) return { commit: baseTip, already: true };

  const env = await identity(repoRoot, { name: 'clanks', email: 'clanks@localhost' });
  const scratch = join(options.scratchDir, `merge-${randomUUID().slice(0, 8)}`);
  mkdirSync(options.scratchDir, { recursive: true });
  let merged: string;
  try {
    await git(['worktree', 'add', '--detach', scratch, baseTip], { cwd: repoRoot });
    const result = await runGit(
      ['merge', '--no-ff', '--no-edit', '-m', options.message, branchTip],
      {
        cwd: scratch,
        env,
        okCodes: [1],
      },
    );
    if (result.exitCode !== 0) {
      const files = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: scratch }).catch(
        () => '',
      );
      throw new MergeConflictError(files.split('\n').filter(Boolean));
    }
    merged = await git(['rev-parse', 'HEAD'], { cwd: scratch });
  } finally {
    await git(['merge', '--abort'], { cwd: scratch }).catch(() => {});
    await git(['worktree', 'remove', '--force', scratch], { cwd: repoRoot }).catch(() => {});
    await git(['worktree', 'prune'], { cwd: repoRoot }).catch(() => {});
  }

  const checkout = await worktreeOf(repoRoot, base);
  if (checkout) {
    try {
      await git(['merge', '--ff-only', '--quiet', merged], { cwd: checkout, env });
    } catch (error) {
      throw new MergeBlockedError(
        `Couldn't bring ${base} up to date in ${checkout}: ${error instanceof GitError ? error.stderr.split('\n').find((l) => l.trim()) || error.message : String(error)}. Commit or stash your own changes there, then approve again.`,
      );
    }
  } else {
    try {
      await git(['update-ref', `refs/heads/${base}`, merged, baseTip], { cwd: repoRoot });
    } catch {
      throw new MergeBlockedError(`${base} moved while merging. Approve again.`);
    }
  }
  return { commit: merged, already: false };
}

/**
 * Commits everything changed in a worktree, if anything is. Returns the commit at its tip either
 * way.
 */
export async function commitAll(
  worktree: string,
  message: string,
  author: { name: string; email: string } | null = null,
): Promise<{ head: string; committed: boolean }> {
  await git(['add', '-A'], { cwd: worktree });
  const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: worktree, okCodes: [1] });
  let committed = false;
  if (staged.exitCode === 1) {
    const env = {
      ...(await identity(worktree, { name: 'clanks', email: 'clanks@localhost' })),
      ...(author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email } : {}),
    };
    await git(['commit', '--no-verify', '--quiet', '-m', message], { cwd: worktree, env });
    committed = true;
  }
  return { head: await git(['rev-parse', 'HEAD'], { cwd: worktree }), committed };
}

/**
 * Merges a commit into a worktree's branch, leaving any conflicts in the files for whoever works
 * there to resolve and commit. Returns the files with conflicts.
 */
export async function mergeIntoWorktree(worktree: string, ref: string): Promise<string[]> {
  const env = await identity(worktree, { name: 'clanks', email: 'clanks@localhost' });
  const result = await runGit(['merge', '--no-edit', ref], { cwd: worktree, env, okCodes: [1] });
  if (result.exitCode === 0) return [];
  const files = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: worktree }).catch(
    () => '',
  );
  return files.split('\n').filter(Boolean);
}

/** Moves a worktree to a commit, as a checker's copy follows the maker's latest hand-in. */
export async function resetWorktree(worktree: string, commit: string): Promise<void> {
  await git(['merge', '--abort'], { cwd: worktree }).catch(() => {});
  await git(['reset', '--quiet', '--hard', commit], { cwd: worktree });
  // Files the checker made, such as screenshots, go; ignored ones, such as node_modules, stay.
  await git(['clean', '-fdq'], { cwd: worktree });
}
