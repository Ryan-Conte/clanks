import { spawn } from 'node:child_process';

/** Whether Docker is here to run commands in. */
export interface DockerStatus {
  /** The `docker` command exists. */
  installed: boolean;
  /** Its engine answers, so containers can start. */
  running: boolean;
  version: string | null;
  /** Why it can't be used, worded for the user. */
  problem: string | null;
}

/** Where a run's commands go in its container. */
export interface Sandbox {
  container: string;
  /** The folder commands start in, inside the container. */
  workdir: string;
}

/** Runs `docker` and collects what it says. Never throws for a non-zero exit. */
export function docker(
  args: string[],
  options: { timeoutMs?: number; file?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(options.file ?? 'docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: error.message, missing: error.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), missing: false });
    });
  });
}

/** Whether Docker is installed and its engine is running. */
export async function dockerStatus(file?: string): Promise<DockerStatus> {
  const result = await docker(['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 10_000,
    ...(file ? { file } : {}),
  });
  if (result.missing) {
    return { installed: false, running: false, version: null, problem: "Docker isn't installed" };
  }
  if (result.code !== 0 || !result.stdout) {
    return {
      installed: true,
      running: false,
      version: null,
      problem:
        "Docker is installed, but its engine isn't running. Start Docker Desktop, or the docker service.",
    };
  }
  return { installed: true, running: true, version: result.stdout, problem: null };
}

/**
 * What `docker run` takes to start a run's container: its worktree mounted at `/work` and nothing
 * else from this computer, no network unless the project allows it, and a process that keeps it
 * up for commands to run in.
 */
export function containerArgs(options: {
  name: string;
  worktree: string;
  image: string;
  network: boolean;
}): string[] {
  return [
    'run',
    '--detach',
    '--init',
    '--name',
    options.name,
    '--label',
    'clanks=run',
    '--label',
    `clanks.config=${configLabel(options)}`,
    '--volume',
    `${options.worktree}:/work`,
    '--workdir',
    '/work',
    ...(options.network ? [] : ['--network', 'none']),
    '--env',
    'CI=1',
    options.image,
    'sleep',
    'infinity',
  ];
}

/** A run's container, started if it isn't. Returns its name. */
export async function ensureContainer(options: {
  name: string;
  worktree: string;
  image: string;
  network: boolean;
}): Promise<void> {
  const state = await docker(
    [
      'inspect',
      '--format',
      '{{.State.Running}} {{index .Config.Labels "clanks.config"}}',
      options.name,
    ],
    { timeoutMs: 15_000 },
  );
  if (state.missing) throw new Error("Docker isn't installed");
  const [running, label] = state.stdout.split(' ');
  if (state.code === 0 && label !== configLabel(options)) {
    // The project's sandbox settings changed since it started: start it afresh.
    await docker(['rm', '--force', options.name]);
  } else if (state.code === 0) {
    if (running === 'true') return;
    const started = await docker(['start', options.name], { timeoutMs: 60_000 });
    if (started.code === 0) return;
    await docker(['rm', '--force', options.name]);
  }
  const run = await docker(containerArgs(options), { timeoutMs: 10 * 60_000 });
  if (run.code !== 0) {
    throw new Error(
      `Docker couldn't start a container from ${options.image}: ${lastLine(run.stderr)}`,
    );
  }
}

export async function removeContainer(name: string): Promise<void> {
  await docker(['rm', '--force', name], { timeoutMs: 30_000 });
}

/** What a container was started with, so a change to the settings starts a fresh one. */
function configLabel(options: { image: string; network: boolean }): string {
  return `${options.image}|${options.network ? 'net' : 'nonet'}`;
}

/** A container name for a run: `clanks-` and a slug of its id. */
export function containerName(runId: string): string {
  return `clanks-${runId.replace(/[^\w-]/g, '').slice(0, 40)}`;
}

/** `docker exec` arguments for a command that can later be stopped by its marker. */
export function markedExecArgs(sandbox: Sandbox, command: string, marker: string): string[] {
  return [
    'exec',
    '--workdir',
    sandbox.workdir,
    sandbox.container,
    'setsid',
    'bash',
    '-lc',
    command,
    marker,
  ];
}

/** Stops a command started with a marker, and everything it started, inside its container. */
export async function stopMarked(sandbox: Sandbox, marker: string): Promise<void> {
  const script = `for p in $(pgrep -f ${marker}); do kill -TERM -- -$p 2>/dev/null || kill -TERM $p 2>/dev/null; done`;
  await docker(['exec', sandbox.container, 'sh', '-c', script], { timeoutMs: 15_000 });
}

function lastLine(text: string): string {
  return text.split('\n').filter(Boolean).at(-1) ?? 'no reason given';
}
