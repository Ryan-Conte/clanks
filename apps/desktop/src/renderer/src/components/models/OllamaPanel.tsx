import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes } from '../../lib/format';
import { useModels } from '../../lib/models';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText, Panel, ProgressBar } from '../ui';

const STATE_LABELS = { linking: 'Linking', copying: 'Copying', verifying: 'Checking' } as const;

/**
 * Models already in Ollama's folder, which clanks can reuse instead of downloading again. Only shows
 * when there are some. Ollama doesn't need to be running, and clanks never calls it.
 */
export function OllamaPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useModels();
  const ollama = useQuery(trpc.models.ollama.queryOptions());
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.models.ollama.queryKey() });
  const importModel = useMutation(trpc.models.importOllama.mutationOptions({ onSettled: refresh }));
  const dismiss = useMutation(trpc.models.dismissImport.mutationOptions());
  const imports = snapshot?.imports ?? [];

  if (!ollama.data || ollama.data.models.length === 0) return null;

  return (
    <Panel
      title="Already in Ollama"
      description={
        <>
          Reuse these instead of downloading them again. Each file is linked where it can be, so it
          takes no more space, and checked by sha256. From{' '}
          <span className="font-mono text-[12px] break-all">{ollama.data.dir}</span>.
        </>
      }
    >
      <ul className="flex flex-col divide-y divide-line">
        {ollama.data.models.map((model) => {
          const status = imports.find((i) => i.name === model.name);
          return (
            <li key={model.name} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-4">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13px]">{model.name}</span>
                    {model.vision && <Badge>vision</Badge>}
                  </span>
                  <span className="text-[12px] text-dim">
                    {formatBytes(model.size)} · becomes {model.id}
                  </span>
                </span>
                {model.imported ? (
                  <Badge tone="mint">In clanks</Badge>
                ) : status && status.state !== 'failed' ? (
                  <span className="text-[13px] text-dim">{STATE_LABELS[status.state]}…</span>
                ) : (
                  <Button size="sm" onClick={() => importModel.mutate(model.name)}>
                    Use in clanks
                  </Button>
                )}
              </div>
              {status && status.state !== 'failed' && (
                <ProgressBar value={status.totalBytes ? status.doneBytes / status.totalBytes : 0} />
              )}
              {status?.state === 'failed' && (
                <div className="flex items-center justify-between gap-4">
                  <ErrorText>{status.error}</ErrorText>
                  <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(model.name)}>
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
