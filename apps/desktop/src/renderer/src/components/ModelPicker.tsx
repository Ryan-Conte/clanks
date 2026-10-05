import type { ModelChoice } from '@clanks/core';
import { useQueries } from '@tanstack/react-query';
import { useProviders } from '../lib/crew';
import { useModels } from '../lib/models';
import { useTRPC } from '../lib/trpc';
import { inputClass } from './ui';

const key = (choice: ModelChoice) => `${choice.provider}\n${choice.model}`;

/**
 * Picks a clank's model: the crew's, one pulled to this machine, or one at a provider that's set
 * up. Cloud and server lists are fetched when this shows.
 */
export function ModelPicker(props: {
  value: ModelChoice | null;
  onChange: (choice: ModelChoice | null) => void;
  disabled?: boolean;
}) {
  const trpc = useTRPC();
  const snapshot = useModels();
  const providers = useProviders().filter((p) => p.kind !== 'builtin' && p.configured);
  const lists = useQueries({
    queries: providers.map((p) => ({
      ...trpc.providers.models.queryOptions(p.id),
      staleTime: 5 * 60_000,
    })),
  });
  const local = (snapshot?.library ?? []).filter((m) => !m.missing);
  const value = props.value ? key(props.value) : '';
  const listed = new Set([
    ...local.map((m) => key({ provider: 'builtin', model: m.id })),
    ...providers.flatMap((p, i) =>
      (lists[i]?.data ?? []).map((m) => key({ provider: p.id, model: m.id })),
    ),
  ]);

  return (
    <select
      aria-label="Model"
      className={`${inputClass} w-full font-mono text-[13px]`}
      value={value}
      disabled={props.disabled}
      onChange={(e) => {
        const [provider, model] = e.target.value.split('\n');
        props.onChange(provider && model ? { provider, model } : null);
      }}
    >
      <option value="">
        The crew's model{snapshot?.crewModel ? ` (${snapshot.crewModel})` : ', none yet'}
      </option>
      {/* A choice whose list hasn't loaded, or that's gone from it, still shows. */}
      {props.value && !listed.has(value) && (
        <option value={value}>
          {props.value.model} ({props.value.provider})
        </option>
      )}
      {local.length > 0 && (
        <optgroup label="On this machine">
          {local.map((m) => (
            <option key={m.id} value={key({ provider: 'builtin', model: m.id })}>
              {m.id}
            </option>
          ))}
        </optgroup>
      )}
      {providers.map((p, i) => {
        const list = lists[i];
        return (
          <optgroup key={p.id} label={p.name}>
            {list?.error ? (
              <option disabled>Couldn't list models: {list.error.message}</option>
            ) : !list?.data ? (
              <option disabled>Loading…</option>
            ) : list.data.length === 0 ? (
              <option disabled>No models there yet</option>
            ) : (
              list.data.map((m) => (
                <option key={m.id} value={key({ provider: p.id, model: m.id })}>
                  {m.title === m.id ? m.id : `${m.title} (${m.id})`}
                </option>
              ))
            )}
          </optgroup>
        );
      })}
    </select>
  );
}
