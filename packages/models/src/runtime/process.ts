import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { RuntimeBuild } from './builds';

/**
 * Variables llama-server may need from the environment, and nothing else: no keys or tokens, and
 * no stray `LLAMA_ARG_*` settings that would change how clanks runs it.
 */
const PASSED_THROUGH = [
  'PATH',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  // Which GPUs to use, and where the Vulkan drivers are, when the user has set them.
  'CUDA_VISIBLE_DEVICES',
  'GGML_VK_VISIBLE_DEVICES',
  'HIP_VISIBLE_DEVICES',
  'VK_ICD_FILENAMES',
  'VK_DRIVER_FILES',
];

export function runtimeEnv(build: RuntimeBuild): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSED_THROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Linux builds load their libraries from beside the binary.
  if (process.platform === 'linux') {
    env.LD_LIBRARY_PATH = [build.dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  return env;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: null,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30_000);
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()));
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A port nothing is listening on right now, for the next llama-server. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No port')),
      );
    });
  });
}

/** The executable name of a running process, or null if it isn't running. */
export function processName(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      const match = /^"([^"]+)"/m.exec(out);
      return match?.[1] ?? null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
