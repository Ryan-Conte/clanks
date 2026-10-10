import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { commandShell, runCommand, withJobsStopped } from './commands';

/** Processes whose command line has a marker in it. */
function running(marker: string): number {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${marker}' -and $_.Name -eq 'node.exe' }).Count`,
      ],
      { encoding: 'utf8' },
    );
    return Number(out.trim());
  }
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').length;
  } catch {
    return 0;
  }
}

async function gone(marker: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (running(marker) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

describe('stopping commands', () => {
  it('stops a server and everything under it, as shell_start runs them', async () => {
    const shell = await commandShell();
    const marker = `clanks-kill-${randomUUID().slice(0, 8)}`;
    const cwd = mkdtempSync(join(tmpdir(), 'clanks-kill-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
    const command = runCommand({
      command: `node -e "setInterval(() => {}, 1000)" ${marker}`,
      cwd,
      shell,
      onOutput: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(running(marker)).toBe(1);
    command.stop();
    expect((await command.done).reason).toBe('stopped');
    expect(await gone(marker)).toBe(true);
  }, 30_000);

  it('stops a server started through a launcher, as npx starts one through cmd', async () => {
    const shell = await commandShell();
    const marker = `clanks-kill-${randomUUID().slice(0, 8)}`;
    const cwd = mkdtempSync(join(tmpdir(), 'clanks-kill-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
    // Like npx: a node process that starts the server through a shell, and waits on it.
    const inner = `node -e "setInterval(() => {}, 1000)" ${marker}`;
    const launcher = `node -e "require('child_process').spawn('${inner.replace(/"/g, '\\"')}', { shell: true, stdio: 'inherit' }); setInterval(() => {}, 1000)"`;
    const command = runCommand({ command: launcher, cwd, shell, onOutput: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // The launcher and the server it started both name the marker.
    expect(running(marker)).toBe(2);
    command.stop();
    expect((await command.done).reason).toBe('stopped');
    expect(await gone(marker)).toBe(true);
  }, 30_000);

  it('stops what a finished command left in the background, launcher and all', async () => {
    const shell = await commandShell();
    if (shell.name === 'cmd') return;
    const marker = `clanks-kill-${randomUUID().slice(0, 8)}`;
    const cwd = mkdtempSync(join(tmpdir(), 'clanks-kill-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
    const inner = `node -e "setInterval(() => {}, 1000)" ${marker}`;
    const launcher = `node -e "require('child_process').spawn('${inner.replace(/"/g, '\\"')}', { shell: true, stdio: 'inherit' }); setInterval(() => {}, 1000)"`;
    const command = runCommand({
      command: withJobsStopped(`${launcher} &\nsleep 2\necho started`, shell),
      cwd,
      shell,
      onOutput: () => {},
    });
    expect((await command.done).reason).toBe('exited');
    expect(await gone(marker)).toBe(true);
  }, 30_000);
});
