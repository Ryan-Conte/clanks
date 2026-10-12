import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatBytes, formatTokens } from '../../lib/format';
import { type LibraryItem, useModels } from '../../lib/models';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText, Panel, Switch } from '../ui';
import { Capabilities, FitBadge } from './badges';

/** The models pulled to this machine. */
export function LibraryPanel({ onTry }: { onTry: (id: string) => void }) {
  const snapshot = useModels();
  const library = snapshot?.library ?? [];

  return (
    <Panel
      title="On this computer"
      description="Models you've downloaded. They run here, with no internet needed."
    >
      {library.length === 0 ? (
        <p className="text-sm text-dim">Nothing downloaded yet. Pick one below.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {library.map((item) => (
            <LibraryRow
              key={item.id}
              item={item}
              crew={snapshot?.crewModel === item.id}
              onTry={() => onTry(item.id)}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LibraryRow({
  item,
  crew,
  onTry,
}: {
  item: LibraryItem;
  crew: boolean;
  onTry: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const load = useMutation(trpc.models.load.mutationOptions());
  const unload = useMutation(trpc.models.unload.mutationOptions());
  const keep = useMutation(trpc.models.setKeepLoaded.mutationOptions());
  const remove = useMutation(trpc.models.remove.mutationOptions());
  const pull = useMutation(trpc.models.pull.mutationOptions());
  const useForCrew = useMutation(
    trpc.models.useForCrew.mutationOptions({
      onSuccess: (settings) => queryClient.setQueryData(trpc.settings.get.queryKey(), settings),
    }),
  );
  const error = [load, unload, keep, remove, pull, useForCrew].find((m) => m.error)?.error;

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{item.title}</span>
            <span className="font-mono text-[12px] text-dim">{item.id}</span>
            {crew && <Badge tone="lavender">Crew model</Badge>}
            {item.missing && <Badge tone="rose">Files missing</Badge>}
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-dim">
            {item.params && <span>{item.params}</span>}
            {item.quant && <span>{item.quant}</span>}
            <span>{formatBytes(item.size)}</span>
            <span>{formatTokens(item.facts.contextLength)} context</span>
            <Capabilities capabilities={item.capabilities} />
          </p>
        </div>
        <FitBadge fit={item.fit} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {item.missing ? (
          <Button size="sm" variant="primary" onClick={() => pull.mutate(item.id)}>
            Download again
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={onTry}>
              Try it
            </Button>
            {item.loaded ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={unload.isPending}
                onClick={() => unload.mutate(item.id)}
              >
                Unload
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={load.isPending}
                onClick={() => load.mutate(item.id)}
              >
                {load.isPending ? 'Loading…' : 'Load'}
              </Button>
            )}
            {!crew && (
              <Button size="sm" variant="ghost" onClick={() => useForCrew.mutate(item.id)}>
                Use for the crew
              </Button>
            )}
          </>
        )}
        <label className="ml-auto flex items-center gap-2 text-[13px] text-dim">
          Keep loaded
          <Switch
            label={`Keep ${item.title} loaded`}
            checked={item.keepLoaded}
            disabled={keep.isPending}
            onChange={(keepLoaded) => keep.mutate({ id: item.id, keepLoaded })}
          />
        </label>
        {confirming ? (
          <span className="flex items-center gap-1">
            <Button size="sm" variant="danger" onClick={() => remove.mutate(item.id)}>
              Remove {formatBytes(item.size)}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </div>
      {error && <ErrorText>{error.message}</ErrorText>}
    </li>
  );
}
