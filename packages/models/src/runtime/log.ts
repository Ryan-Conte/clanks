import type { LoadedModelStatus } from '@clanks/core';
import { MIB } from '../fit';

/** What llama-server reports about a model it loaded, from its own log. */
export interface LoadReport {
  layers: { gpu: number; total: number } | null;
  /** MiB by buffer type (`CUDA0`, `CPU_Mapped`, `Vulkan_Host`…): weights, caches and compute. */
  buffers: Record<string, number>;
  /** The same for the weights alone, which says where the model itself lives. */
  modelBuffers: Record<string, number>;
}

export function emptyReport(): LoadReport {
  return { layers: null, buffers: {}, modelBuffers: {} };
}

export interface LogEntry {
  level: string;
  message: string;
}

/**
 * One line of llama-server output. With `--log-jsonl` most lines are JSON; a few early ones
 * aren't, and are kept as plain text.
 */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const entry = JSON.parse(trimmed) as { type?: string; level?: string; msg?: string };
      if (entry.type !== 'log' || typeof entry.msg !== 'string') return null;
      return { level: entry.level ?? 'info', message: entry.msg.trimEnd() };
    } catch {
      // Not JSON after all; fall through.
    }
  }
  return { level: /\sE\s/.test(trimmed.slice(0, 20)) ? 'error' : 'info', message: trimmed };
}

const OFFLOADED = /offloaded (\d+)\/(\d+) layers to GPU/;
const BUFFER = /(\S+)\s+(model|KV|RS|compute|output) buffer size =\s*([\d.]+) MiB/;

export function applyLogMessage(report: LoadReport, message: string): void {
  const offloaded = OFFLOADED.exec(message);
  if (offloaded) {
    report.layers = { gpu: Number(offloaded[1]), total: Number(offloaded[2]) };
    return;
  }
  const buffer = BUFFER.exec(message);
  if (buffer) {
    const [, name, kind, mib] = buffer;
    report.buffers[name!] = (report.buffers[name!] ?? 0) + Number(mib);
    if (kind === 'model')
      report.modelBuffers[name!] = (report.modelBuffers[name!] ?? 0) + Number(mib);
  }
}

/** Host-side buffers live in system memory; the rest are on a GPU (or unified memory). */
function isSystemBuffer(name: string): boolean {
  return /^CPU/i.test(name) || /_Host$/i.test(name);
}

export function summarizeReport(
  report: LoadReport,
): Pick<LoadedModelStatus, 'placement' | 'layers' | 'memory' | 'devices'> {
  let gpuMiB = 0;
  let systemMiB = 0;
  for (const [name, mib] of Object.entries(report.buffers)) {
    if (isSystemBuffer(name)) systemMiB += mib;
    else gpuMiB += mib;
  }
  const gpuModel = Object.entries(report.modelBuffers)
    .filter(([name]) => !isSystemBuffer(name))
    .reduce((sum, [, mib]) => sum + mib, 0);
  const devices = [
    ...new Set(
      Object.keys(report.buffers)
        .filter((name) => !isSystemBuffer(name))
        .map((name) => name.replace(/_(Mapped|Split|REPACK)$/i, '')),
    ),
  ];
  // The CPU build counts the CPU as the device it "offloads" to, so the buffers decide.
  const placement: LoadedModelStatus['placement'] =
    Object.keys(report.buffers).length === 0
      ? null
      : gpuModel === 0
        ? 'cpu'
        : report.layers && report.layers.gpu < report.layers.total
          ? 'partial'
          : 'gpu';
  return {
    placement,
    layers: placement === 'cpu' ? null : report.layers,
    memory:
      Object.keys(report.buffers).length === 0
        ? null
        : { gpuBytes: Math.round(gpuMiB * MIB), systemBytes: Math.round(systemMiB * MIB) },
    devices: placement === 'cpu' ? [] : devices,
  };
}
