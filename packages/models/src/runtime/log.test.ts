import { describe, expect, it } from 'vitest';
import { MIB } from '../fit';
import {
  type LoadReport,
  applyLogMessage,
  emptyReport,
  parseLogLine,
  summarizeReport,
} from './log';

function report(lines: string[]): LoadReport {
  const result = emptyReport();
  for (const line of lines) {
    const entry = parseLogLine(line);
    if (entry) applyLogMessage(result, entry.message);
  }
  return result;
}

const jsonl = (msg: string, level = 'info') =>
  JSON.stringify({ type: 'log', time: 1, level, msg: msg + '\n' });

// Lines as llama-server b11146 logs them with --log-jsonl --log-verbosity 4.
const fullOffload = [
  '0.00.000.713 I srv  llama_server: initializing ...',
  jsonl('load_tensors: offloaded 25/25 layers to GPU'),
  jsonl('load_tensors:   CPU_Mapped model buffer size =   257.66 MiB'),
  jsonl('load_tensors:      Vulkan0 model buffer size =   526.50 MiB'),
  jsonl('llama_context: Vulkan_Host  output buffer size =     1.89 MiB'),
  jsonl('llama_kv_cache:    Vulkan0 KV buffer size =    96.00 MiB'),
  jsonl(
    'llama_kv_cache: size =   96.00 MiB (  4096 cells,   6 layers,  2/2 seqs), K (f16):   48.00 MiB',
  ),
  jsonl('llama_memory_recurrent:    Vulkan0 RS buffer size =    38.53 MiB'),
  jsonl('sched_reserve:    Vulkan0 compute buffer size =    44.30 MiB'),
  jsonl('sched_reserve: Vulkan_Host compute buffer size =     8.02 MiB'),
  JSON.stringify({ type: 'fit_memory_breakdown', data: { unit: 'MiB', rows: [] } }),
];

describe('llama-server log', () => {
  it('reads where the model went and how much memory it took', () => {
    expect(summarizeReport(report(fullOffload))).toEqual({
      placement: 'gpu',
      layers: { gpu: 25, total: 25 },
      devices: ['Vulkan0'],
      memory: {
        gpuBytes: Math.round((526.5 + 96 + 38.53 + 44.3) * MIB),
        systemBytes: Math.round((257.66 + 1.89 + 8.02) * MIB),
      },
    });
  });

  it('sees a partial offload', () => {
    const lines = [
      jsonl('load_tensors: offloaded 10/49 layers to GPU'),
      jsonl('load_tensors:   CPU_Mapped model buffer size =  9000.00 MiB'),
      jsonl('load_tensors:        CUDA0 model buffer size =  3000.00 MiB'),
    ];
    expect(summarizeReport(report(lines)).placement).toBe('partial');
  });

  it('knows the CPU build\'s "offload" is still the CPU', () => {
    const lines = [
      jsonl('load_tensors: offloaded 7/7 layers to GPU'),
      jsonl('load_tensors:   CPU_Mapped model buffer size =    17.50 MiB'),
      jsonl('load_tensors:   CPU_REPACK model buffer size =     3.20 MiB'),
      jsonl('llama_kv_cache:        CPU KV buffer size =     2.00 MiB'),
    ];
    expect(summarizeReport(report(lines))).toMatchObject({
      placement: 'cpu',
      layers: null,
      devices: [],
    });
  });

  it('has nothing to say before the model loads', () => {
    expect(summarizeReport(emptyReport())).toEqual({
      placement: null,
      layers: null,
      memory: null,
      devices: [],
    });
  });

  it('keeps log levels, and plain lines as text', () => {
    expect(parseLogLine(jsonl('llama_model_load: error loading model', 'error'))).toEqual({
      level: 'error',
      message: 'llama_model_load: error loading model',
    });
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('{"type":"fit_memory_breakdown"}')).toBeNull();
  });
});
