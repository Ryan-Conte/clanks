import type { CloudProviderId, ProviderStatus } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useProviders } from '../../lib/crew';
import { useTRPC } from '../../lib/trpc';
import { Button, Dot, ErrorText, Panel, inputClass } from '../ui';

const KEY_HINTS: Record<CloudProviderId, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  google: 'AIza…',
  openrouter: 'sk-or-…',
};

function useRefreshProviders() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: trpc.providers.list.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.providers.models.queryKey() });
  };
}

/** Cloud models with the user's own keys. None is needed. */
export function CloudPanel() {
  const trpc = useTRPC();
  const status = useQuery(trpc.secrets.status.queryOptions());
  const cloud = useProviders().filter(
    (p): p is ProviderStatus & { id: CloudProviderId } =>
      p.kind !== 'builtin' && p.kind !== 'server',
  );
  return (
    <Panel
      title="Cloud models"
      description="Optional. With a key, any clank can run on a cloud model instead. Keys stay in your keychain and go only to their provider."
    >
      <ul className="flex flex-col divide-y divide-line">
        {cloud.map((provider) => (
          <CloudRow
            key={provider.id}
            provider={provider}
            keychain={status.data?.available ?? false}
          />
        ))}
      </ul>
    </Panel>
  );
}

function CloudRow({
  provider,
  keychain,
}: {
  provider: ProviderStatus & { id: CloudProviderId };
  keychain: boolean;
}) {
  const trpc = useTRPC();
  const refresh = useRefreshProviders();
  const [key, setKey] = useState('');
  const save = useMutation(
    trpc.providers.setKey.mutationOptions({
      onSuccess: () => {
        setKey('');
        refresh();
      },
    }),
  );
  const remove = useMutation(trpc.providers.removeKey.mutationOptions({ onSuccess: refresh }));
  // Listing the models is the check: it fails with the provider's reason if the key is wrong.
  const models = useQuery({
    ...trpc.providers.models.queryOptions(provider.id),
    enabled: provider.hasKey,
    staleTime: 5 * 60_000,
  });

  return (
    <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-2.5">
          <Dot tone={!provider.hasKey ? 'dim' : models.error ? 'rose' : 'mint'} />
          <span className="text-sm font-medium">{provider.name}</span>
          {provider.hasKey && (
            <span className="text-[13px] text-dim">
              {models.error
                ? 'The key didn’t work'
                : models.data
                  ? `${models.data.length} models`
                  : 'Checking the key…'}
            </span>
          )}
        </span>
        {provider.hasKey ? (
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(provider.id)}>
            Remove key
          </Button>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate({ id: provider.id, key: key.trim() });
            }}
          >
            <input
              type="password"
              aria-label={`${provider.name} API key`}
              className={`${inputClass} h-8 w-64 font-mono text-[13px]`}
              placeholder={
                keychain ? KEY_HINTS[provider.id] : 'No keychain, so keys can’t be saved'
              }
              disabled={!keychain}
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button size="sm" type="submit" disabled={!keychain || !key.trim() || save.isPending}>
              Save
            </Button>
          </form>
        )}
      </div>
      {models.error && <ErrorText>{models.error.message}</ErrorText>}
      {(save.error ?? remove.error) && (
        <ErrorText>{(save.error ?? remove.error)!.message}</ErrorText>
      )}
    </li>
  );
}

/** Model servers the user runs elsewhere: anything that speaks the OpenAI API. */
export function ServersPanel() {
  const trpc = useTRPC();
  const refresh = useRefreshProviders();
  const servers = useProviders().filter((p) => p.kind === 'server');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const add = useMutation(
    trpc.providers.addServer.mutationOptions({
      onSuccess: () => {
        setName('');
        setBaseUrl('');
        setApiKey('');
        refresh();
      },
    }),
  );
  const remove = useMutation(trpc.providers.removeServer.mutationOptions({ onSuccess: refresh }));

  return (
    <Panel
      title="Model servers"
      description="Optional. A server you already run, such as LM Studio, vLLM or Ollama, at its OpenAI-compatible address."
    >
      {servers.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {servers.map((server) => (
            <li key={server.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{server.name}</span>
                <span className="truncate font-mono text-[12px] text-dim">{server.baseUrl}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(server.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ name, baseUrl, ...(apiKey.trim() ? { apiKey } : {}) });
        }}
      >
        <div className="grid grid-cols-[10rem_1fr] gap-2">
          <input
            aria-label="Server name"
            className={inputClass}
            placeholder="LM Studio"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="Server address"
            className={`${inputClass} font-mono text-[13px]`}
            placeholder="http://localhost:1234/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            aria-label="Server API key"
            className={`${inputClass} flex-1 font-mono text-[13px]`}
            placeholder="API key, if it needs one"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button type="submit" disabled={!name.trim() || !baseUrl.trim() || add.isPending}>
            {add.isPending ? 'Checking…' : 'Add server'}
          </Button>
        </div>
      </form>
      {(add.error ?? remove.error) && <ErrorText>{(add.error ?? remove.error)!.message}</ErrorText>}
    </Panel>
  );
}
