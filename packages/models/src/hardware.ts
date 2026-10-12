import type { GpuDevice, HardwareInfo, RuntimeBackend } from '@clanks/core';
import { cpus, freemem, totalmem } from 'node:os';
import { GIB, MIB } from './fit';
import type { RuntimeBuild } from './runtime/builds';
import { type CommandResult, runCommand, runtimeEnv } from './runtime/process';

const DEVICE_LINE = /^\s*([A-Za-z]+\d+):\s+(.+?)\s+\((\d+) MiB,\s*(\d+) MiB free\)\s*$/;
const BACKEND_BY_PREFIX: Record<string, RuntimeBackend> = {
  CUDA: 'cuda',
  Vulkan: 'vulkan',
  MTL: 'metal',
};

/** Parses `llama-server --list-devices`. */
export function parseDeviceList(output: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DEVICE_LINE.exec(line);
    if (!match) continue;
    const [, id, name, total, free] = match;
    const backend = BACKEND_BY_PREFIX[id!.replace(/\d+$/, '')];
    if (!backend) continue;
    devices.push({
      id: id!,
      name: name!,
      backend,
      totalBytes: Number(total) * MIB,
      freeBytes: Number(free) * MIB,
    });
  }
  return devices;
}

/**
 * Intel's integrated graphics show up through Vulkan, but share system memory and run models
 * slower than the CPU does. Arc cards are real GPUs.
 */
function isWeakIntegrated(device: GpuDevice): boolean {
  return /intel/i.test(device.name) && !/\barc\b/i.test(device.name);
}

export type Runner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export interface ProbeOptions {
  builds: RuntimeBuild[];
  overrides: {
    backend: 'auto' | RuntimeBackend;
    gpuBudgetMiB: number | null;
    systemBudgetMiB: number | null;
  };
  platform?: string;
  arch?: string;
  memory?: { totalBytes: number; freeBytes: number };
  run?: Runner;
}

export interface ProbeResult {
  hardware: HardwareInfo;
  /** The build to run models on, or null if this machine has none. */
  build: RuntimeBuild | null;
}

/** GPU memory to leave free, as llama.cpp's own fitting does. */
const GPU_RESERVE = 1 * GIB;
/** Share of system memory models may use; the OS and other apps need the rest. */
const SYSTEM_SHARE = 0.75;

/**
 * Asks each llama.cpp build which devices it can see, picks the one to run models on, and sets
 * the memory budget from what it found.
 */
export async function probeHardware(options: ProbeOptions): Promise<ProbeResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.run ?? runCommand;
  const problems: string[] = [];

  const listed = await Promise.all(
    options.builds.map(async (build) => {
      const result = await run(build.command, [...build.args, '--list-devices'], {
        cwd: build.dir,
        env: runtimeEnv(build),
        timeoutMs: 30_000,
      });
      if (result.code !== 0) {
        const reason =
          (result.stderr || result.stdout).trim().split(/\r?\n/).at(-1) || `exit ${result.code}`;
        problems.push(`The ${build.backend} build didn't start: ${reason}`);
        return { build, devices: [] as GpuDevice[], ok: false };
      }
      const devices = parseDeviceList(result.stdout + '\n' + result.stderr).filter(
        (d) => d.backend === build.backend && !isWeakIntegrated(d),
      );
      return { build, devices, ok: true };
    }),
  );

  const nvidia =
    listed.some((l) => l.devices.some((d) => /nvidia/i.test(d.name))) ||
    (await hasNvidiaSmi(run, platform));

  const usable = listed.filter((l) => l.ok);
  const byBackend = (backend: RuntimeBackend) => usable.find((l) => l.build.backend === backend);
  let chosen: (typeof listed)[number] | undefined;
  if (options.overrides.backend !== 'auto') chosen = byBackend(options.overrides.backend);
  if (!chosen) {
    chosen =
      (['cuda', 'metal', 'vulkan'] as const)
        .map(byBackend)
        .find((l) => l !== undefined && l.devices.length > 0) ?? byBackend('cpu');
  }
  // Any build will do as a last resort; it still runs on the CPU.
  chosen ??= usable[0];

  const unified = platform === 'darwin' && arch === 'arm64';
  const totalBytes = options.memory?.totalBytes ?? totalmem();
  const freeBytes = options.memory?.freeBytes ?? freemem();
  const gpus = chosen?.devices ?? [];
  const gpuBytes =
    options.overrides.gpuBudgetMiB !== null
      ? options.overrides.gpuBudgetMiB * MIB
      : gpus.reduce(
          (sum, d) => sum + Math.max(0, (unified ? d.totalBytes : d.freeBytes) - GPU_RESERVE),
          0,
        );
  const systemBytes =
    options.overrides.systemBudgetMiB !== null
      ? options.overrides.systemBudgetMiB * MIB
      : unified && gpus.length > 0
        ? 0
        : Math.floor(totalBytes * SYSTEM_SHARE);

  const cpuList = cpus();
  return {
    build: chosen?.build ?? null,
    hardware: {
      platform,
      arch,
      cpu: { model: cpuList[0]?.model.trim() ?? 'Unknown CPU', threads: cpuList.length },
      memory: { totalBytes, freeBytes, unified },
      gpus,
      nvidia,
      backend: chosen?.build.backend ?? 'cpu',
      budget: { gpuBytes, systemBytes },
      problems,
      probedAt: new Date(),
    },
  };
}

/** The NVIDIA driver installs nvidia-smi, so it finds a card even when no build can see it. */
async function hasNvidiaSmi(run: Runner, platform: string): Promise<boolean> {
  if (platform === 'darwin') return false;
  const result = await run('nvidia-smi', ['-L'], { timeoutMs: 10_000 });
  return result.code === 0 && /GPU \d+:/.test(result.stdout);
}
