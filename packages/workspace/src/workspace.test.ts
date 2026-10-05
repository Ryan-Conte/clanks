import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { commandShell, runCommand } from './commands';
import { git } from './git';
import { changedRanges, computeHunks, excerptOf, revertHunk } from './hunks';
import { PathError, resolveInside } from './paths';
import { addWorktree, initRepo, removeWorktree, repoInfo } from './repo';
import { ShadowRepo } from './shadow';
import { headTail, plainOutput } from './text';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clanks-ws-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

const env = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function repo(files: Record<string, string>, autocrlf = 'false'): Promise<string> {
  const dir = join(tempDir(), 'repo');
  mkdirSync(dir);
  await git(['init', '--quiet', '-b', 'main'], { cwd: dir });
  // Git for Windows turns this on for everyone; tests say which they mean.
  await git(['config', 'core.autocrlf', autocrlf], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await git(['add', '-A'], { cwd: dir });
  await git(['commit', '--quiet', '-m', 'Start'], { cwd: dir, env });
  return dir;
}

describe('worktrees', () => {
  it('finds the repository a folder is in', async () => {
    const root = await repo({ 'src/a.ts': 'a\n' });
    const info = await repoInfo(join(root, 'src'));
    expect(info?.root).toBe(root);
    expect(info?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(await repoInfo(tempDir())).toBeNull();
  });

  it('works on a branch of its own and keeps what was left when removed', async () => {
    const root = await repo({ 'a.txt': 'one\n' });
    const { head } = (await repoInfo(root))!;
    const path = join(tempDir(), 'wt');
    await addWorktree({ repoRoot: root, path, branch: 'clanks/chat-1', base: head! });
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('one\n');
    writeFileSync(join(path, 'b.txt'), 'two\n');

    await removeWorktree({ repoRoot: root, path, message: 'Left over' });
    expect(existsSync(path)).toBe(false);
    // The user's checkout is untouched, and the branch kept the work.
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(await git(['show', 'clanks/chat-1:b.txt'], { cwd: root })).toBe('two');

    // Coming back to the chat checks the branch out again rather than failing.
    await addWorktree({ repoRoot: root, path, branch: 'clanks/chat-1', base: head! });
    expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('two\n');
  });

  it('sets up git in a plain folder', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'notes.md'), 'hi\n');
    await initRepo(dir);
    const info = await repoInfo(dir);
    expect(info?.head).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('checkpoints', () => {
  async function setup() {
    const root = await repo({ 'a.txt': 'one\ntwo\n', '.gitignore': 'build/\n' });
    const info = (await repoInfo(root))!;
    const path = join(tempDir(), 'wt');
    await addWorktree({ repoRoot: root, path, branch: 'clanks/chat-2', base: info.head! });
    const shadow = new ShadowRepo(join(tempDir(), 'shadow.git'), path);
    const base = await shadow.init(info.head!, join(info.commonDir, 'objects'));
    return { root, path, shadow, base };
  }

  it('records changes byte for byte, and only when something changed', async () => {
    const { path, shadow, base } = await setup();
    expect(await shadow.snapshot('Nothing')).toBeNull();

    writeFileSync(join(path, 'a.txt'), 'one\r\nTWO\r\nthree\r\n');
    writeFileSync(join(path, 'new.txt'), 'new\n');
    mkdirSync(join(path, 'build'));
    writeFileSync(join(path, 'build', 'out.js'), 'ignored');
    const first = await shadow.snapshot('Edited');
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    const changes = await shadow.changes(base, first!);
    expect(changes).toEqual([
      { path: 'a.txt', oldPath: null, status: 'modified', added: 3, removed: 2, binary: false },
      { path: 'new.txt', oldPath: null, status: 'added', added: 1, removed: 0, binary: false },
    ]);
    expect((await shadow.read(first!, 'a.txt'))?.toString()).toBe('one\r\nTWO\r\nthree\r\n');
    expect(await shadow.read(base, 'new.txt')).toBeNull();
  });

  it('rewinds the worktree to a checkpoint', async () => {
    const { path, shadow, base } = await setup();
    writeFileSync(join(path, 'a.txt'), 'changed\n');
    writeFileSync(join(path, 'later.txt'), 'later\n');
    await shadow.snapshot('Changed');
    writeFileSync(join(path, 'unsaved.txt'), 'made after the last checkpoint\n');

    await shadow.restore(base);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(existsSync(join(path, 'later.txt'))).toBe(false);
    expect(existsSync(join(path, 'unsaved.txt'))).toBe(false);
    // The worktree's own git still works.
    expect(await git(['status', '--porcelain'], { cwd: path })).toBe('');
  });

  it('starts from the checkout as it is, line endings and all', async () => {
    const root = await repo({ 'a.txt': 'one\ntwo\n' }, 'true');
    const info = (await repoInfo(root))!;
    const path = join(tempDir(), 'wt');
    await addWorktree({ repoRoot: root, path, branch: 'clanks/crlf', base: info.head! });
    const shadow = new ShadowRepo(join(tempDir(), 'shadow.git'), path);
    const base = await shadow.init(info.head!, join(info.commonDir, 'objects'));
    expect(await shadow.snapshot('Nothing yet')).toBeNull();
    expect(await shadow.changes(base, await shadow.tree())).toEqual([]);
  });

  it("never touches the user's repository", async () => {
    const { root, path, shadow } = await setup();
    const before = await git(['for-each-ref'], { cwd: root });
    writeFileSync(join(path, 'a.txt'), 'x\n');
    await shadow.snapshot('Edited');
    expect(await git(['for-each-ref'], { cwd: root })).toBe(before);
    expect(await git(['status', '--porcelain'], { cwd: root })).toBe('');
  });
});

describe('hunks', () => {
  const original = 'a\nb\nc\nd\ne\n';

  it('finds changed, added and removed runs', () => {
    expect(computeHunks(original, 'a\nB\nc\nd\ne\n')).toEqual([
      { originalStart: 2, originalCount: 1, modifiedStart: 2, modifiedCount: 1 },
    ]);
    expect(computeHunks(original, 'a\nb\nnew\nc\nd\ne\n')).toEqual([
      { originalStart: 2, originalCount: 0, modifiedStart: 3, modifiedCount: 1 },
    ]);
    expect(computeHunks(original, 'b\nc\nd\ne\n')).toEqual([
      { originalStart: 1, originalCount: 1, modifiedStart: 0, modifiedCount: 0 },
    ]);
  });

  it('puts one run back and leaves the others', () => {
    const modified = 'top\na\nB\nc\ne\nend';
    const hunks = computeHunks(original, modified);
    expect(hunks).toHaveLength(4);
    expect(revertHunk(original, modified, hunks[0]!)).toBe('a\nB\nc\ne\nend');
    expect(revertHunk(original, modified, hunks[1]!)).toBe('top\na\nb\nc\ne\nend');
    expect(revertHunk(original, modified, hunks[2]!)).toBe('top\na\nB\nc\nd\ne\nend');
    // The last line had no newline; now a line follows it, so it gets one.
    expect(revertHunk(original, modified, hunks[3]!)).toBe('top\na\nB\nc\ne\n');
    let all = modified;
    for (const hunk of [...hunks].reverse()) all = revertHunk(original, all, hunk);
    expect(all).toBe(original);
  });

  it('keeps Windows line endings', () => {
    const before = 'one\r\ntwo\r\n';
    const after = 'one\r\nTWO\r\nthree\r\n';
    const [hunk] = computeHunks(before, after);
    expect(revertHunk(before, after, hunk!)).toBe(before);
  });

  it('says which lines an edit changed', () => {
    expect(changedRanges(original, 'a\nB\nC\nd\ne\nf\n')).toEqual([
      { start: 2, end: 3 },
      { start: 6, end: 6 },
    ]);
    expect(changedRanges(original, 'a\ne\n')).toEqual([{ start: 1, end: 1 }]);
    expect(excerptOf('1\n2\n3\n4\n', 2, 3)).toBe('2\n3');
  });
});

describe('paths', () => {
  it('keeps clanks inside the workspace', () => {
    const root = tempDir();
    mkdirSync(join(root, 'src'));
    expect(resolveInside(root, root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'));
    expect(resolveInside(root, join(root, 'src'), '../b.ts')).toBe(join(root, 'b.ts'));
    expect(() => resolveInside(root, root, '../outside.txt')).toThrow(PathError);
    expect(() => resolveInside(root, root, join(tmpdir(), 'x'))).toThrow(PathError);
    expect(() => resolveInside(root, root, '.git/config')).toThrow(/git's own/);
  });

  it("doesn't follow a link out", () => {
    const root = tempDir();
    const outside = tempDir();
    try {
      symlinkSync(outside, join(root, 'escape'), 'junction');
    } catch {
      return; // No permission to make links here.
    }
    expect(() => resolveInside(root, root, 'escape/secret.txt')).toThrow(/link/);
  });
});

describe('commands', () => {
  it('runs a command and reports its output and exit code', async () => {
    const shell = await commandShell();
    let output = '';
    const command = runCommand({
      command: 'echo hello && exit 3',
      cwd: tempDir(),
      shell,
      onOutput: (text) => (output += text),
    });
    expect(await command.done).toEqual({ exitCode: 3, reason: 'exited', error: null });
    expect(output.trim()).toBe('hello');
  });

  it('stops a command that runs too long', async () => {
    const shell = await commandShell();
    const sleep = shell.name === 'cmd' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const command = runCommand({
      command: sleep,
      cwd: tempDir(),
      shell,
      timeoutMs: 300,
      onOutput: () => {},
    });
    const exit = await command.done;
    expect(exit.reason).toBe('timeout');
  });
});

describe('text', () => {
  it('turns terminal output into plain text', () => {
    expect(plainOutput('\u001b[32mok\u001b[0m\r\n 10%\r 50%\r100%\ndone')).toBe('ok\n100%\ndone');
  });

  it('keeps the start and end of long output', () => {
    const text = `${'a'.repeat(100)}\n${'b'.repeat(100)}\n${'c'.repeat(100)}`;
    const cut = headTail(text, 100);
    expect(cut.startsWith('a'.repeat(40))).toBe(true);
    expect(cut.endsWith('c'.repeat(60))).toBe(true);
    expect(cut).toMatch(/characters, about \d+ lines, cut/);
  });
});
