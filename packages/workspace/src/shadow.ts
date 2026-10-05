import type { ChangedFile, FileChangeStatus } from '@clanks/core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type GitOptions, git, runGit } from './git';

/** Settings that make the shadow repository store files byte for byte and stay out of the way. */
const SHADOW_CONFIG: [string, string][] = [
  ['core.bare', 'false'],
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['core.filemode', 'false'],
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['gc.auto', '0'],
  ['commit.gpgsign', 'false'],
  ['user.name', 'clanks'],
  ['user.email', 'clanks@localhost'],
];

const REF = 'refs/heads/checkpoints';

/**
 * Checkpoints for one worktree, as commits in a git folder of their own in the app data folder. It
 * shares the user's objects through git's alternates, so unchanged files cost nothing, and never
 * touches the user's repository, its history or its refs.
 */
export class ShadowRepo {
  constructor(
    /** The shadow git folder. */
    readonly gitDir: string,
    /** The worktree it takes snapshots of. */
    readonly workTree: string,
  ) {}

  private options(extra: Partial<GitOptions> = {}): GitOptions {
    return { cwd: this.workTree, gitDir: this.gitDir, workTree: this.workTree, ...extra };
  }

  exists(): boolean {
    return existsSync(join(this.gitDir, 'HEAD'));
  }

  /**
   * Creates the shadow repository and its first checkpoint: the worktree as it is, which starts as
   * `base`. `objects` is the user's repository's object folder, borrowed rather than copied.
   */
  async init(base: string, objects: string, exclude = ''): Promise<string> {
    mkdirSync(this.gitDir, { recursive: true });
    await git(['init', '--bare', '--quiet', this.gitDir], { cwd: this.workTree });
    for (const [key, value] of SHADOW_CONFIG) {
      await git(['config', key, value], { cwd: this.workTree, gitDir: this.gitDir });
    }
    mkdirSync(join(this.gitDir, 'objects', 'info'), { recursive: true });
    writeFileSync(join(this.gitDir, 'objects', 'info', 'alternates'), `${objects}\n`);
    // What the user's repository ignores without a .gitignore, the checkpoints ignore too.
    mkdirSync(join(this.gitDir, 'info'), { recursive: true });
    writeFileSync(join(this.gitDir, 'info', 'exclude'), exclude);
    // Start the index from the base commit so the first snapshot only hashes what differs.
    await git(['read-tree', base], this.options());
    const snapshot = await this.snapshot('Base', { force: true });
    return snapshot!;
  }

  /** The latest checkpoint's commit. */
  async head(): Promise<string | null> {
    const sha = await git(
      ['rev-parse', '--verify', '--quiet', REF],
      this.options({ okCodes: [1] }),
    );
    return sha || null;
  }

  /** The worktree's tree as it is right now, written to the shadow repository. */
  async tree(): Promise<string> {
    await git(['add', '-A', '--ignore-errors', '--', '.'], this.options());
    return git(['write-tree'], this.options());
  }

  /**
   * Records the worktree as a checkpoint. Null when nothing changed since the last one, unless
   * `force` makes one anyway.
   */
  async snapshot(message: string, { force = false } = {}): Promise<string | null> {
    const tree = await this.tree();
    const parent = await this.head();
    if (parent && !force) {
      const parentTree = await git(['rev-parse', `${parent}^{tree}`], this.options());
      if (parentTree === tree) return null;
    }
    const commit = await git(
      ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
      this.options(),
    );
    await git(['update-ref', REF, commit], this.options());
    return commit;
  }

  /** What changed between two commits or trees. */
  async changes(from: string, to: string): Promise<ChangedFile[]> {
    const [numstat, status] = await Promise.all([
      runGit(['diff', '--numstat', '-z', '-M', '--no-color', from, to], this.options()),
      runGit(['diff', '--name-status', '-z', '-M', '--no-color', from, to], this.options()),
    ]);
    const counts = parseNumstat(numstat.stdout.toString('utf8'));
    return parseNameStatus(status.stdout.toString('utf8')).map((file) => {
      const count = counts.get(file.path);
      return {
        ...file,
        added: count?.added ?? 0,
        removed: count?.removed ?? 0,
        binary: count?.binary ?? false,
      };
    });
  }

  /** A file's bytes at a commit or tree, or null if it isn't there. */
  async read(treeish: string, path: string): Promise<Buffer | null> {
    const result = await runGit(
      ['cat-file', 'blob', `${treeish}:${path}`],
      this.options({ okCodes: [128] }),
    );
    return result.exitCode === 0 ? result.stdout : null;
  }

  /** A file's size at a commit or tree, without reading it. */
  async size(treeish: string, path: string): Promise<number | null> {
    const result = await runGit(
      ['cat-file', '-s', `${treeish}:${path}`],
      this.options({ okCodes: [128] }),
    );
    return result.exitCode === 0 ? Number(result.stdout.toString('utf8').trim()) : null;
  }

  /**
   * Puts the worktree back as it was at a checkpoint: changed files are restored and files made
   * since are removed. Files git ignores are left alone.
   */
  async restore(commit: string): Promise<void> {
    await this.tree();
    await git(['read-tree', '-u', '--reset', commit], this.options());
  }

  /** Points the latest checkpoint back at an earlier one, after a rewind. */
  async resetTo(commit: string): Promise<void> {
    await git(['update-ref', REF, commit], this.options());
  }
}

function parseNumstat(
  text: string,
): Map<string, { added: number; removed: number; binary: boolean }> {
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  const fields = text.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (!field) continue;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (!match) continue;
    let path = match[3]!;
    // A rename lists an empty path, then the old and new paths as fields of their own.
    if (path === '') {
      i += 2;
      path = fields[i] ?? '';
    }
    counts.set(path, {
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
      binary: match[1] === '-',
    });
  }
  return counts;
}

function parseNameStatus(text: string): Omit<ChangedFile, 'added' | 'removed' | 'binary'>[] {
  const fields = text.split('\0');
  const files: Omit<ChangedFile, 'added' | 'removed' | 'binary'>[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[++i] ?? '';
      const path = fields[++i] ?? '';
      files.push({ path, oldPath, status: letter === 'R' ? 'renamed' : 'added' });
    } else {
      const path = fields[++i] ?? '';
      const status: FileChangeStatus =
        letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
      files.push({ path, oldPath: null, status });
    }
  }
  return files;
}
