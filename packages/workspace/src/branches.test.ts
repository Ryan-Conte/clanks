import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  MergeBlockedError,
  MergeConflictError,
  commitAll,
  currentBranch,
  mergeBranch,
  mergeIntoWorktree,
  resetWorktree,
  resolveCommit,
  worktreeOf,
} from './branches';
import { git } from './git';
import { addWorktree } from './repo';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clanks-br-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const env = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function setup() {
  const dir = tempDir();
  const root = join(dir, 'repo');
  mkdirSync(root);
  await git(['init', '--quiet', '-b', 'main'], { cwd: root });
  await git(['config', 'core.autocrlf', 'false'], { cwd: root });
  await git(['config', 'user.name', 'Test'], { cwd: root });
  await git(['config', 'user.email', 'test@example.com'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'b.txt'), 'b\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '--quiet', '-m', 'Start'], { cwd: root, env });
  const start = (await resolveCommit(root, 'HEAD'))!;
  const branch = async (name: string, files: Record<string, string>) => {
    const path = join(dir, 'wt', name);
    await addWorktree({ repoRoot: root, path, branch: `clanks/${name}`, base: start });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
    await commitAll(path, `Work on ${name}`);
    return path;
  };
  return { dir, root, start, branch, scratchDir: join(dir, 'scratch') };
}

describe('merging a ticket branch', () => {
  it('merges into the checked-out base, bringing the user their files', async () => {
    const { root, branch, scratchDir } = await setup();
    await branch('SURF-1', { 'c.txt': 'new\n' });
    // The user has a change of their own in a file the merge doesn't touch.
    writeFileSync(join(root, 'b.txt'), 'mine\n');
    const result = await mergeBranch({
      repoRoot: root,
      base: 'main',
      branch: 'clanks/SURF-1',
      message: 'Merge SURF-1: Add c',
      scratchDir,
    });
    expect(result.already).toBe(false);
    expect(await resolveCommit(root, 'main')).toBe(result.commit);
    expect(readFileSync(join(root, 'c.txt'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('mine\n');
    expect(await git(['log', '-1', '--format=%s %P'], { cwd: root })).toMatch(
      /^Merge SURF-1: Add c \w+ \w+$/,
    );
    // Merging again changes nothing.
    expect(
      await mergeBranch({
        repoRoot: root,
        base: 'main',
        branch: 'clanks/SURF-1',
        message: 'x',
        scratchDir,
      }),
    ).toEqual({ commit: result.commit, already: true });
  });

  it('refuses a conflict, leaving the base as it was', async () => {
    const { root, start, branch, scratchDir } = await setup();
    await branch('SURF-1', { 'a.txt': 'one\nTWO\nthree\n' });
    await branch('SURF-2', { 'a.txt': 'one\n2\nthree\n' });
    await mergeBranch({
      repoRoot: root,
      base: 'main',
      branch: 'clanks/SURF-1',
      message: 'm1',
      scratchDir,
    });
    const before = await resolveCommit(root, 'main');
    expect(before).not.toBe(start);
    const conflict = mergeBranch({
      repoRoot: root,
      base: 'main',
      branch: 'clanks/SURF-2',
      message: 'm2',
      scratchDir,
    });
    await expect(conflict).rejects.toBeInstanceOf(MergeConflictError);
    await expect(conflict).rejects.toThrow('It conflicts with the base in a.txt');
    expect(await resolveCommit(root, 'main')).toBe(before);
    expect(await git(['worktree', 'list'], { cwd: root })).not.toContain('merge-');
  });

  it("won't overwrite the user's own changes, and moves a base nobody has checked out", async () => {
    const { root, branch, scratchDir } = await setup();
    await branch('SURF-1', { 'b.txt': 'theirs\n' });
    writeFileSync(join(root, 'b.txt'), 'mine\n');
    await expect(
      mergeBranch({
        repoRoot: root,
        base: 'main',
        branch: 'clanks/SURF-1',
        message: 'm',
        scratchDir,
      }),
    ).rejects.toBeInstanceOf(MergeBlockedError);
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('mine\n');

    // With the user on another branch, main moves without anyone's checkout changing.
    await git(['checkout', '--quiet', '-b', 'mine'], { cwd: root });
    expect(await currentBranch(root)).toBe('mine');
    expect(await worktreeOf(root, 'main')).toBeNull();
    const result = await mergeBranch({
      repoRoot: root,
      base: 'main',
      branch: 'clanks/SURF-1',
      message: 'm',
      scratchDir,
    });
    expect(await resolveCommit(root, 'main')).toBe(result.commit);
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('mine\n');
  });
});

describe('worktree helpers', () => {
  it('commit what was left, merge the base in with conflicts, and catch up', async () => {
    const { root, branch, scratchDir } = await setup();
    const one = await branch('SURF-1', { 'a.txt': 'one\nTWO\nthree\n' });
    const two = await branch('SURF-2', { 'a.txt': 'one\n2\nthree\n' });
    await mergeBranch({
      repoRoot: root,
      base: 'main',
      branch: 'clanks/SURF-1',
      message: 'm',
      scratchDir,
    });

    writeFileSync(join(two, 'd.txt'), 'left\n');
    const left = await commitAll(two, 'Work left', {
      name: 'Forge (clanks)',
      email: 'forge@clanks.local',
    });
    expect(left.committed).toBe(true);
    expect(await git(['log', '-1', '--format=%an'], { cwd: two })).toBe('Forge (clanks)');
    expect((await commitAll(two, 'Nothing')).committed).toBe(false);

    expect(await mergeIntoWorktree(two, 'main')).toEqual(['a.txt']);
    expect(readFileSync(join(two, 'a.txt'), 'utf8')).toContain('<<<<<<<');

    // A checker's copy follows the maker's branch, and drops what the checker made.
    writeFileSync(join(one, 'screenshot.png'), 'x');
    await resetWorktree(one, left.head);
    expect(await resolveCommit(one, 'HEAD')).toBe(left.head);
    expect(readFileSync(join(one, 'd.txt'), 'utf8')).toBe('left\n');
  });
});
