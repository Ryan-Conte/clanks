import { spawn } from 'node:child_process';

/** git failed, with what it said. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  /** Where to run it. */
  cwd: string;
  /** For the shadow repositories checkpoints live in: their git folder and the tree they track. */
  gitDir?: string;
  workTree?: string;
  /** Extra environment, such as an author. */
  env?: Record<string, string>;
  input?: string | Buffer;
  signal?: AbortSignal;
  /** Exit codes that aren't failures, such as 1 for `git grep` finding nothing. */
  okCodes?: number[];
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

/**
 * Settings every call gets: paths printed as they are rather than quoted, no prompts for
 * credentials, and long paths on Windows.
 */
const BASE_CONFIG = ['-c', 'core.quotepath=false', '-c', 'core.longpaths=true'];

/** Runs git and collects its output. Throws a `GitError` unless it exits with an ok code. */
export function runGit(args: string[], options: GitOptions): Promise<GitResult> {
  const fullArgs = [
    ...BASE_CONFIG,
    ...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
    ...(options.workTree ? [`--work-tree=${options.workTree}`] : []),
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('git', fullArgs, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        ...options.env,
      },
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') reject(new GitError('git is not installed', '', null));
      else reject(error);
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(err).toString('utf8').trim();
      const exitCode = code ?? -1;
      if (exitCode === 0 || options.okCodes?.includes(exitCode)) {
        resolve({ stdout: Buffer.concat(out), stderr, exitCode });
      } else {
        const command = args.find((a) => !a.startsWith('-')) ?? 'git';
        reject(
          new GitError(
            `git ${command} failed: ${stderr.split('\n').at(-1) || `exit code ${exitCode}`}`,
            stderr,
            exitCode,
          ),
        );
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/** Runs git and returns what it printed, trimmed. */
export async function git(args: string[], options: GitOptions): Promise<string> {
  return (await runGit(args, options)).stdout.toString('utf8').trim();
}

let installed: Promise<string | null> | null = null;

/** git's version, such as `2.45.1`, or null when it isn't installed. Asked once. */
export function gitVersion(): Promise<string | null> {
  installed ??= git(['--version'], { cwd: process.cwd() }).then(
    (text) => /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? text,
    () => null,
  );
  return installed;
}
