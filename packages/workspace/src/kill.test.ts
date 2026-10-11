import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { commandShell, runCommand, withJobsStopped } from './commands';
import { jobsReady } from './jobs';

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
  // On Windows the helper that makes jobs takes a moment to start, and the first commands after
  // that would run without one. In the app it starts with the orchestrator.
  beforeAll(async () => {
    await jobsReady(15_000);
  }, 20_000);

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

  it('stops a server three launchers down, as `npm run dev` starts one', async () => {
    const shell = await commandShell();
    const marker = `clanks-kill-${randomUUID().slice(0, 8)}`;
    const cwd = mkdtempSync(join(tmpdir(), 'clanks-kill-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
    // npm runs the script through a shell, the script's own launcher runs through another, and
    // the server starts a worker: stopping any launcher first must not strand what's under it.
    writeFileSync(
      join(cwd, 'chain.js'),
      [
        "const { spawn } = require('node:child_process');",
        'const depth = Number(process.argv[2]);',
        'if (depth > 0) {',
        "  spawn(`node chain.js ${depth - 1} ${process.argv[3]}`, { shell: true, stdio: 'inherit' });",
        '}',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const command = runCommand({
      command: `node chain.js 3 ${marker}`,
      cwd,
      shell,
      onOutput: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(running(marker)).toBe(4);
    command.stop();
    expect((await command.done).reason).toBe('stopped');
    expect(await gone(marker)).toBe(true);
  }, 40_000);

  it('stops a server started with `npm run`, which bash runs as a script of its own', async () => {
    const shell = await commandShell();
    const marker = `clanks-kill-${randomUUID().slice(0, 8)}`;
    const cwd = mkdtempSync(join(tmpdir(), 'clanks-kill-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
    // As a dev server is: npm's own script starts node, which starts a worker. Under Git's bash
    // on Windows the script is a new process with no parent Windows knows of.
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'kill', scripts: { dev: `node server.js ${marker}` } }),
    );
    writeFileSync(
      join(cwd, 'server.js'),
      [
        "const { spawn } = require('node:child_process');",
        "if (!process.argv[3]) spawn(process.execPath, [__filename, process.argv[2], 'worker'], { stdio: 'inherit' });",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const command = runCommand({ command: 'npm run dev', cwd, shell, onOutput: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(running(marker)).toBe(2);
    command.stop();
    expect((await command.done).reason).toBe('stopped');
    expect(await gone(marker)).toBe(true);
  }, 40_000);

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
