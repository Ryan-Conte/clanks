import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** A path a clank asked for that it may not use, with the reason in plain words. */
export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The real path of the nearest part of `path` that exists, so links can't lead outside. */
function realOfExisting(path: string): string {
  let current = path;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...rest);
}

/**
 * Resolves a path a clank gave, relative to `cwd`, and checks it stays inside `root` once links
 * are followed. Nothing inside a `.git` folder or file is allowed: that's git's, not the clank's.
 */
export function resolveInside(root: string, cwd: string, path: string): string {
  const cleaned = path.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) throw new PathError('The path is empty');
  const full = resolve(cwd, cleaned);
  if (!inside(root, full)) {
    throw new PathError(`${cleaned} is outside the workspace. Use a path inside it.`);
  }
  const realRoot = realpathSync.native(root);
  if (!inside(realRoot, realOfExisting(full))) {
    throw new PathError(`${cleaned} leads outside the workspace through a link`);
  }
  const segments = relative(root, full).split(sep);
  if (segments.some((s) => (caseInsensitive ? s.toLowerCase() : s) === '.git')) {
    throw new PathError("Files inside .git are git's own. Use the git tools instead.");
  }
  return full;
}

/** A path relative to the worktree, with forward slashes, as git and the diff editor show it. */
export function toRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}
