import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { formatBytes, formatDuration, formatRate, formatTokens } from '../../lib/format';
import { BACKEND_NAMES, type LoadedItem, useModels } from '../../lib/models';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText, Panel } from '../ui';
import { LoadedState } from './badges';

/** The models in memory right now, where they ended up and how fast they are. */
export function LoadedPanel() {
  const trpc = useTRPC();
  const snapshot = useModels();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const loaded = snapshot?.runtime.loaded ?? [];
  const idle = settings.data?.modelIdleMinutes ?? 10;

  return (
    <Panel
      title="Running now"
      description={`Models load when something uses them and unload after ${idle} minutes idle.`}
    >
      {loaded.length === 0 ? (
        <p className="text-sm text-dim">Nothing is loaded.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {loaded.map((item) => (
            <LoadedRow key={item.modelId} item={item} title={titleOf(item.modelId)} />
          ))}
        </ul>
      )}
    </Panel>
  );

  function titleOf(id: string) {
    return snapshot?.library.find((m) => m.id === id)?.title ?? id;
  }
}

function LoadedRow({ item, title }: { item: LoadedItem; title: string }) {
  const trpc = useTRPC();
  const unload = useMutation(trpc.models.unload.mutationOptions());
  const now = useNow(item.idleUnloadAt !== null);

  return (
    <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <LoadedState state={item.state} inUse={item.inUse} />
          <span className="truncate font-medium">{title}</span>
          <span className="truncate font-mono text-[12px] text-dim">{item.modelId}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={unload.isPending}
          onClick={() => unload.mutate(item.modelId)}
        >
          Unload
        </Button>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-dim">
        <span>{placement(item)}</span>
        {item.memory && (
          <span>
            {item.memory.gpuBytes > 0 && `${formatBytes(item.memory.gpuBytes)} GPU`}
            {item.memory.gpuBytes > 0 && item.memory.systemBytes > 0 && ' · '}
            {item.memory.systemBytes > 0 && `${formatBytes(item.memory.systemBytes)} RAM`}
          </span>
        )}
        <span>
          {formatTokens(item.context)} context · {item.slots} {item.slots === 1 ? 'slot' : 'slots'}
        </span>
        {item.tokensPerSecond !== null && (
          <span className="text-white/80">{formatRate(item.tokensPerSecond)}</span>
        )}
        <span>
          {item.inUse > 0
            ? `In use by ${item.inUse}`
            : item.keepLoaded
              ? 'Kept loaded'
              : item.idleUnloadAt
                ? `Unloads in ${formatDuration((+item.idleUnloadAt - now) / 1000)}`
                : ''}
        </span>
        {item.restarts > 0 && <span>Restarted {item.restarts}×</span>}
      </p>
      {item.error && <ErrorText>{item.error}</ErrorText>}
      {unload.error && <ErrorText>{unload.error.message}</ErrorText>}
    </li>
  );
}

function placement(item: LoadedItem): string {
  const backend = BACKEND_NAMES[item.backend];
  switch (item.placement) {
    case 'gpu':
      return `On the GPU (${item.devices.join(', ') || backend})`;
    case 'partial':
      return item.layers
        ? `Partly on the GPU: ${item.layers.gpu} of ${item.layers.total} layers`
        : 'Partly on the GPU';
    case 'cpu':
      return 'On the CPU';
    default:
      return `Starting on ${backend}…`;
  }
}

/** The current time, ticking every few seconds while something counts down. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}
