import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '../../lib/trpc';
import { CopyButton } from '../chat/Markdown';
import { ErrorText, Panel, Toggle, inputClass } from '../ui';

const ENDPOINTS = [
  '/v1/models',
  '/v1/chat/completions',
  '/api/tags',
  '/api/chat',
  '/api/generate',
  '/api/pull',
  '/api/ps',
];

/** Serves the pulled models to other apps on this machine. Off unless the user turns it on. */
export function LocalApiPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const status = useQuery(trpc.localApi.status.queryOptions());
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(trpc.settings.get.queryKey(), next);
        void queryClient.invalidateQueries({ queryKey: trpc.localApi.status.queryKey() });
      },
    }),
  );
  const s = settings.data;
  if (!s) return null;

  return (
    <Panel
      title="Local API"
      description="Lets other apps on this computer use the models clanks pulled, through OpenAI- and Ollama-style endpoints. Nothing else on the network can reach it."
    >
      <Toggle
        label="Serve models to other apps"
        description="Requests queue behind the crew's, on the same loaded models."
        checked={s.localApiEnabled}
        disabled={update.isPending}
        onChange={(localApiEnabled) => update.mutate({ localApiEnabled })}
      />
      <div className="flex items-center justify-between gap-8">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Port</span>
          <span className="text-[13px] text-dim">
            11434 is Ollama's, so its tools find clanks there.
          </span>
        </span>
        <PortInput
          key={s.localApiPort}
          port={s.localApiPort}
          onSave={(localApiPort) => update.mutate({ localApiPort })}
        />
      </div>
      {s.localApiEnabled && status.data?.url && (
        <div className="flex flex-col gap-2 rounded-2xl border border-line bg-black/30 p-4">
          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-[13px] text-white">{status.data.url}</span>
            <CopyButton text={status.data.url} />
          </div>
          <p className="font-mono text-[11px] leading-relaxed text-dim">{ENDPOINTS.join('  ')}</p>
        </div>
      )}
      {s.localApiEnabled && status.data?.error && <ErrorText>{status.data.error}</ErrorText>}
      {update.error && <ErrorText>{update.error.message}</ErrorText>}
    </Panel>
  );
}

function PortInput({ port, onSave }: { port: number; onSave: (port: number) => void }) {
  const [draft, setDraft] = useState(String(port));
  const commit = () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) return setDraft(String(port));
    if (value !== port) onSave(value);
  };
  return (
    <input
      aria-label="Local API port"
      inputMode="numeric"
      className={`${inputClass} w-28 font-mono`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}
