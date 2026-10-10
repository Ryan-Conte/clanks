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
  /** It left something running that held its output open, which was stopped. */
  lingered?: boolean;
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
  let grace: NodeJS.Timeout | null = null;
  const done = new Promise<CommandExit>((resolve) => {
    let settled = false;
    const finish = (exit: CommandExit) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      const rest = decoders[0].end() + decoders[1].end();
      if (rest) options.onOutput(rest);
      resolve(exit);
    };
    child.on('error', (error) => finish({ exitCode: null, reason: 'error', error: error.message }));
    child.on('close', (code) => finish({ exitCode: code, reason, error: null, lingered: false }));
    // Something it started, such as a server put in the background with `&`, can hold its output
    // open after it exits. It's done when it exits; what it left behind is stopped.
    child.on('exit', (code) => {
      if (settled) return;
      grace = setTimeout(
        () => {
          if (settled) return;
          child.stdout.destroy();
          child.stderr.destroy();
          if (child.pid !== undefined) killTree(child.pid);
          finish({ exitCode: code, reason, error: null, lingered: true });
        },
        reason === 'exited' ? EXIT_GRACE_MS : 0,
      );
    });
  });
  return { pid: child.pid, done, stop: () => stop('stopped') };
}

/**
 * A command that stops what it put in the background when it ends, such as a server started with
 * `&` before a test, so nothing it started outlives it or keeps a port. For bash and sh; cmd has no
 * background jobs to stop. In Git's bash on Windows a job is a stand-in for the Windows program it
 * runs, so the program's whole process tree is stopped, through the job's Windows process id.
 */
export function withJobsStopped(
  command: string,
  shell: Pick<Shell, 'name'>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (shell.name === 'cmd') return command;
  const stop =
    platform === 'win32'
      ? 'for p in $(jobs -p); do taskkill //F //T //PID $(cat /proc/$p/winpid) >/dev/null 2>&1; done'
      : 'kill $(jobs -p) 2>/dev/null';
  return `trap '${stop}' EXIT\n${command}`;
}

/** How long output may go on after a command exits, from what it started, before it's cut off. */
const EXIT_GRACE_MS = 1500;

/**
 * Stops a process and everything it started. On Windows a process tree can come apart, as Git's
 * bash launcher does when it's killed, so the processes are also found from the process table,
 * where an orphan still names the parent it was started by. That runs as a process of its own, so
 * it finishes even when the app is quitting.
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    const quiet = { windowsHide: true, stdio: 'ignore' as const, detached: true };
    spawn('taskkill', ['/f', '/t', '/pid', String(pid)], quiet)
      .on('error', () => {})
      .unref();
    spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', treeKillScript(pid)],
      quiet,
    )
      .on('error', () => {})
      .unref();
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

/** PowerShell that stops a Windows process and its descendants, found from the process table. */
export function treeKillScript(root: number): string {
  return [
    `$found = [System.Collections.Generic.List[int]]::new(); $found.Add(${root})`,
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId',
    'for ($i = 0; $i -lt $found.Count; $i++) { foreach ($p in $all) { if ($p.ParentProcessId -eq $found[$i] -and -not $found.Contains([int]$p.ProcessId)) { $found.Add([int]$p.ProcessId) } } }',
    'foreach ($id in $found) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
  ].join('; ');
}
