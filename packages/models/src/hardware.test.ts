import { describe, expect, it } from 'vitest';
import { GIB, MIB } from './fit';
import { type ProbeOptions, type Runner, parseDeviceList, probeHardware } from './hardware';
import type { RuntimeBuild } from './runtime/builds';

const build = (backend: RuntimeBuild['backend']): RuntimeBuild => ({
  backend,
  source: backend === 'cuda' ? 'downloaded' : 'bundled',
  dir: `/llama/${backend}`,
  command: `/llama/${backend}/llama-server`,
  args: [],
});

const auto: ProbeOptions['overrides'] = {
  backend: 'auto',
  gpuBudgetMiB: null,
  systemBudgetMiB: null,
};
const memory = { totalBytes: 32 * GIB, freeBytes: 16 * GIB };

/** Answers `--list-devices` per build, and `nvidia-smi -L` if given. */
function runner(lists: Partial<Record<string, string | null>>, nvidiaSmi?: string): Runner {
  return (command) => {
    if (command === 'nvidia-smi') {
      return Promise.resolve(
        nvidiaSmi
          ? { code: 0, stdout: nvidiaSmi, stderr: '' }
          : { code: null, stdout: '', stderr: 'ENOENT' },
      );
    }
    const backend = command.split('/')[2]!;
    const output = lists[backend];
    return Promise.resolve(
      output === null || output === undefined
        ? {
            code: 3221225781,
            stdout: '',
            stderr: 'error while loading shared libraries: libvulkan.so.1',
          }
        : { code: 0, stdout: output, stderr: '0.00.000.759 I srv  llama_server: initializing ...' },
    );
  };
}

const RTX = (prefix: string) =>
  `Available devices:\n  ${prefix}0: NVIDIA GeForce RTX 4090 (24356 MiB, 23567 MiB free)\n`;
const NONE = 'Available devices:\n  (none)\n';

describe('parseDeviceList', () => {
  it('reads each backend’s devices', () => {
    expect(parseDeviceList(RTX('Vulkan'))).toEqual([
      {
        id: 'Vulkan0',
        name: 'NVIDIA GeForce RTX 4090',
        backend: 'vulkan',
        totalBytes: 24356 * MIB,
        freeBytes: 23567 * MIB,
      },
    ]);
    expect(parseDeviceList('  MTL0: Apple M3 Max (98304 MiB, 98303 MiB free)')[0]?.backend).toBe(
      'metal',
    );
    expect(parseDeviceList(NONE)).toEqual([]);
  });
});

describe('probeHardware', () => {
  it('prefers CUDA when it is installed and sees the GPU', async () => {
    const { hardware, build: chosen } = await probeHardware({
      builds: [build('cpu'), build('vulkan'), build('cuda')],
      overrides: auto,
      memory,
      platform: 'win32',
      arch: 'x64',
      run: runner({ cpu: NONE, vulkan: RTX('Vulkan'), cuda: RTX('CUDA') }),
    });
    expect(chosen?.backend).toBe('cuda');
    expect(hardware.backend).toBe('cuda');
    expect(hardware.gpus.map((g) => g.id)).toEqual(['CUDA0']);
    expect(hardware.nvidia).toBe(true);
    // Free VRAM less a 1 GiB margin; three quarters of system memory.
    expect(hardware.budget).toEqual({ gpuBytes: 23567 * MIB - GIB, systemBytes: 24 * GIB });
    expect(hardware.problems).toEqual([]);
  });

  it('uses Vulkan without CUDA, and knows CUDA would help', async () => {
    const { hardware } = await probeHardware({
      builds: [build('cpu'), build('vulkan')],
      overrides: auto,
      memory,
      platform: 'linux',
      arch: 'x64',
      run: runner({ cpu: NONE, vulkan: RTX('Vulkan') }),
    });
    expect(hardware.backend).toBe('vulkan');
    expect(hardware.nvidia).toBe(true);
  });

  it('falls back to the CPU when the Vulkan build cannot start', async () => {
    const { hardware } = await probeHardware({
      builds: [build('cpu'), build('vulkan')],
      overrides: auto,
      memory,
      platform: 'linux',
      arch: 'x64',
      run: runner({ cpu: NONE, vulkan: null }, 'GPU 0: NVIDIA GeForce GTX 1060 (UUID: GPU-1)'),
    });
    expect(hardware.backend).toBe('cpu');
    expect(hardware.gpus).toEqual([]);
    expect(hardware.budget.gpuBytes).toBe(0);
    expect(hardware.problems[0]).toMatch(/vulkan build didn't start: .*libvulkan/);
    // nvidia-smi still found the card, so the CUDA download is worth offering.
    expect(hardware.nvidia).toBe(true);
  });

  it('ignores Intel integrated graphics', async () => {
    const { hardware } = await probeHardware({
      builds: [build('cpu'), build('vulkan')],
      overrides: auto,
      memory,
      platform: 'win32',
      arch: 'x64',
      run: runner({
        cpu: NONE,
        vulkan: '  Vulkan0: Intel(R) UHD Graphics 770 (16287 MiB, 16000 MiB free)',
      }),
    });
    expect(hardware.backend).toBe('cpu');
    expect(hardware.nvidia).toBe(false);
  });

  it('budgets unified memory on Apple Silicon as GPU memory only', async () => {
    const { hardware } = await probeHardware({
      builds: [build('metal')],
      overrides: auto,
      memory: { totalBytes: 36 * GIB, freeBytes: 20 * GIB },
      platform: 'darwin',
      arch: 'arm64',
      run: runner({ metal: '  MTL0: Apple M3 Pro (27648 MiB, 27647 MiB free)' }),
    });
    expect(hardware.memory.unified).toBe(true);
    expect(hardware.backend).toBe('metal');
    expect(hardware.budget).toEqual({ gpuBytes: 27648 * MIB - GIB, systemBytes: 0 });
  });

  it('honours the backend and budget overrides', async () => {
    const { hardware } = await probeHardware({
      builds: [build('cpu'), build('vulkan'), build('cuda')],
      overrides: { backend: 'vulkan', gpuBudgetMiB: 8000, systemBudgetMiB: 4000 },
      memory,
      platform: 'win32',
      arch: 'x64',
      run: runner({ cpu: NONE, vulkan: RTX('Vulkan'), cuda: RTX('CUDA') }),
    });
    expect(hardware.backend).toBe('vulkan');
    expect(hardware.budget).toEqual({ gpuBytes: 8000 * MIB, systemBytes: 4000 * MIB });
  });
});
