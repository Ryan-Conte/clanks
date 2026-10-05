import type { FitEstimate, LoadedModelStatus, ModelCapabilities } from '@clanks/core';
import { formatBytes, formatTokens } from '../../lib/format';
import { Badge, Dot, type Tone } from '../ui';

const FIT: Record<FitEstimate['verdict'], [Tone, string]> = {
  gpu: ['mint', 'Fits on GPU'],
  partial: ['amber', 'Partly on GPU'],
  cpu: ['dim', 'Runs on CPU'],
  too_large: ['rose', 'Too large'],
};

/** Where a model would run on this machine, from the estimate. */
export function FitBadge({ fit }: { fit: FitEstimate | null }) {
  if (!fit) return null;
  const [tone, label] = FIT[fit.verdict];
  return (
    <span
      title={`Needs about ${formatBytes(fit.needBytes)} with ${formatTokens(fit.context)} of context`}
    >
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

export function Capabilities({ capabilities }: { capabilities: ModelCapabilities }) {
  const names = [
    capabilities.tools && 'tools',
    capabilities.vision && 'vision',
    capabilities.reasoning && 'thinking',
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <span
          key={name as string}
          className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-dim"
        >
          {name}
        </span>
      ))}
    </span>
  );
}

const STATE: Record<LoadedModelStatus['state'], [Tone, string, boolean]> = {
  loading: ['lavender', 'Loading', true],
  ready: ['mint', 'Ready', false],
  restarting: ['amber', 'Restarting', true],
  failed: ['rose', 'Failed', false],
};

export function LoadedState({
  state,
  inUse,
}: {
  state: LoadedModelStatus['state'];
  inUse: number;
}) {
  const [tone, label, live] = STATE[state];
  const busy = state === 'ready' && inUse > 0;
  return (
    <Badge tone={tone}>
      <Dot tone={tone} live={live || busy} />
      {busy ? 'Working' : label}
    </Badge>
  );
}
