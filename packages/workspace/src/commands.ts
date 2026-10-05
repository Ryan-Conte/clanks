import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { git } from './git';

/** The shell clanks' commands run in. */
export interface Shell {
  /** `bash`, `sh` or `cmd`, which the clank is told so it writes commands for it. */
  name: string;
  file: string;
  args(command: string): string[];
  /** cmd.exe parses its own command line, so Node must pass it as it is. */
  verbatim: boolean;
}

let detected: Promise<Shell> | null = null;

/**
 * bash where there is one. On Windows that's the bash that comes with Git for Windows, which
 * clanks needs anyway for worktrees, so commands are the same on every platform. cmd.exe otherwise.
 */
export function commandShell(): Promise<Shell> {
  detected ??= (async (): Promise<Shell> => {
    const bash = (file: string): Shell => ({
      name: 'bash',
      file,
      args: (command) => ['-c', command],
      verbatim: false,
    });
    if (process.platform !== 'win32') {
      if (existsSync('/bin/bash')) return bash('/bin/bash');
      return { name: 'sh', file: '/bin/sh', args: (command) => ['-c', command], verbatim: false };
    }
    try {
      // `<git>/mingw64/libexec/git-core` → `<git>/bin/bash.exe`
      const execPath = await git(['--exec-path'], { cwd: process.cwd() });
      const file = join(execPath, '..', '..', '..', 'bin', 'bash.exe');
      if (existsSync(file)) return bash(file);
    } catch {
      // No git: cmd it is.
    }
    return {
      name: 'cmd',
      file: process.env.ComSpec ?? 'cmd.exe',
      args: (command) => ['/d', '/s', '/c', `"${command}"`],
      verbatim: true,
    };
  })();
  return detected;
}

/** Variables that hold model providers' keys, or that would change how child programs start. */
const SCRUBBED = [
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^OPENROUTER_/,
  /^GEMINI_API_KEY$/,
  /^GOOGLE_API_KEY$/,
  /^HF_TOKEN$/,
  /^HUGGING_FACE_HUB_TOKEN$/,
  /^CLANKS_/,
  /^ELECTRON_/,
  /^VITE_DEV_SERVER/,
];

/** The app's environment without provider keys or clanks' own settings. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SCRUBBED.some((pattern) => pattern.test(key))) env[key] = value;
  }
  return env;
}

/**
 * The environment clanks' commands get: scrubbed, and set up so nothing waits for input that will
 * never come.
 */
export function commandEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...scrubbedEnv(),
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    ...extra,
  };
}

export interface CommandExit {
  exitCode: number | null;
  /** Why it ended: on its own, out of time, stopped by someone, or it never started. */
  reason: 'exited' | 'timeout' | 'stopped' | 'error';
  error: string | null;
}

export interface CommandHandle {
  pid: number | undefined;
  done: Promise<CommandExit>;
  /** Stops it and everything it started. */
  stop(): void;
}

export interface CommandOptions {
  command: string;
  cwd: string;
  shell: Shell;
  env?: NodeJS.ProcessEnv;
  /** Stops it after this long. */
  timeoutMs?: number;
  onOutput(text: string): void;
}

/**
 * Runs a command with its output piped, not in a terminal: what the model reads stays plain text,
 * and nothing can wait for keyboard input, since there isn't any.
 */
export function runCommand(options: CommandOptions): CommandHandle {
  const { shell } = options;
  const child = spawn(shell.file, shell.args(options.command), {
    cwd: options.cwd,
    env: options.env ?? commandEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: shell.verbatim,
    // Its own process group on macOS and Linux, so stopping it stops what it started.
    detached: process.platform !== 'win32',
  });
  let reason: CommandExit['reason'] = 'exited';
  const stop = (why: CommandExit['reason']) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    reason = why;
    if (child.pid !== undefined) killTree(child.pid);
  };
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')] as const;
  child.stdout.on('data', (chunk: Buffer) => options.onOutput(decoders[0].write(chunk)));
  child.stderr.on('data', (chunk: Buffer) => options.onOutput(decoders[1].write(chunk)));

  const timer =
    options.timeoutMs !== undefined ? setTimeout(() => stop('timeout'), options.timeoutMs) : null;
  const done = new Promise<CommandExit>((resolve) => {
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, reason: 'error', error: error.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const rest = decoders[0].end() + decoders[1].end();
      if (rest) options.onOutput(rest);
      resolve({ exitCode: code, reason, error: null });
    });
  });
  return { pid: child.pid, done, stop: () => stop('stopped') };
}

/** Stops a process and its children. */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on(
      'error',
      () => {},
    );
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000).unref();
}
