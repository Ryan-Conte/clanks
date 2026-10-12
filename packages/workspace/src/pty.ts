import { existsSync } from 'node:fs';

export interface PtyHandle {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** The user's usual shell: PowerShell on Windows, `$SHELL` elsewhere. */
export function userShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  const shell = process.env.SHELL;
  if (shell && existsSync(shell)) return { file: shell, args: ['-l'] };
  return { file: existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: [] };
}

/**
 * Starts an interactive terminal, for the user's own shell in a worktree. The native module loads
 * on first use, so a platform without it loses only this, not the app.
 */
export async function openPty(options: {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}): Promise<PtyHandle> {
  const { spawn } = await import('@lydell/node-pty');
  const term = spawn(options.file, options.args, {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  });
  term.onData((data) => options.onData(data));
  term.onExit(({ exitCode }) => options.onExit(exitCode));
  return {
    pid: term.pid,
    write: (data) => term.write(data),
    resize: (cols, rows) => {
      try {
        term.resize(Math.max(2, cols), Math.max(1, rows));
      } catch {
        // It exited.
      }
    },
    kill: () => {
      try {
        term.kill();
      } catch {
        // Already gone.
      }
    },
  };
}
