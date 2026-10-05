import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { formatBytes, formatDuration, formatSpeed, formatTokens } from '../../lib/format';
import { type PullItem, useModels } from '../../lib/models';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText, Panel, ProgressBar, inputClass } from '../ui';
import { Capabilities, FitBadge } from './badges';

/** Pull by catalog name or from any Hugging Face GGUF repo, and follow the downloads. */
export function PullPanel() {
  const trpc = useTRPC();
  const snapshot = useModels();
  const [draft, setDraft] = useState('');
  const [ref, setRef] = useState('');
  const preview = useQuery({
    ...trpc.models.inspect.queryOptions(ref),
    enabled: ref.length > 0,
    staleTime: 60_000,
  });
  const pull = useMutation(
    trpc.models.pull.mutationOptions({
      onSuccess: () => {
        setDraft('');
        setRef('');
      },
    }),
  );
  // A finished pull shows up in the library; it needn't stay here too.
  const pulls = (snapshot?.pulls ?? []).filter((p) => p.state !== 'done');

  const check = (event: FormEvent) => {
    event.preventDefault();
    setRef(draft.trim());
  };

  return (
    <Panel
      title="Pull a model"
      description={
        <>
          A catalog name such as <code className="font-mono text-white/80">qwen3.5:9b</code>, or any
          GGUF repo on Hugging Face as{' '}
          <code className="font-mono text-white/80">
            hf.co/&lt;owner&gt;/&lt;repo&gt;:&lt;quant&gt;
          </code>
          .
        </>
      }
    >
      <form onSubmit={check} className="flex gap-2">
        <input
          aria-label="Model to pull"
          className={`${inputClass} w-full font-mono`}
          placeholder="hf.co/unsloth/Qwen3.5-9B-GGUF:Q4_K_M"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={!draft.trim() || preview.isFetching}>
          {preview.isFetching ? 'Checking…' : 'Check'}
        </Button>
      </form>

      {preview.error && <ErrorText>{preview.error.message}</ErrorText>}
      {preview.data && ref && (
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-black/20 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium">
                {preview.data.title}{' '}
                <span className="font-mono text-[12px] text-dim">{preview.data.id}</span>
              </p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-dim">
                {preview.data.params && <span>{preview.data.params}</span>}
                {preview.data.quant && <span>{preview.data.quant}</span>}
                <span>{formatBytes(preview.data.size)}</span>
                <span>{formatTokens(preview.data.contextLength)} context</span>
                {preview.data.license && <span>{preview.data.license}</span>}
                <Capabilities capabilities={preview.data.capabilities} />
              </p>
            </div>
            <FitBadge fit={preview.data.fit} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-[13px] text-dim">
              {preview.data.pulled
                ? 'Already pulled.'
                : preview.data.downloadBytes < preview.data.size
                  ? `${formatBytes(preview.data.downloadBytes)} to download; the rest is already here.`
                  : `${formatBytes(preview.data.downloadBytes)} to download from Hugging Face.`}
            </p>
            <Button
              variant="primary"
              size="sm"
              disabled={preview.data.pulled || pull.isPending}
              onClick={() => pull.mutate(preview.data.id)}
            >
              Pull
            </Button>
          </div>
        </div>
      )}
      {pull.error && <ErrorText>{pull.error.message}</ErrorText>}

      {pulls.length > 0 && (
        <ul className="flex flex-col gap-4">
          {pulls.map((item) => (
            <PullRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const STATE_LABEL: Record<PullItem['state'], string> = {
  queued: 'Waiting',
  resolving: 'Looking it up',
  downloading: 'Downloading',
  verifying: 'Checking the download',
  paused: 'Paused',
  failed: 'Failed',
  done: 'Pulled',
};

export function PullRow({ item }: { item: PullItem }) {
  const trpc = useTRPC();
  const pause = useMutation(trpc.models.pausePull.mutationOptions());
  const resume = useMutation(trpc.models.resumePull.mutationOptions());
  const cancel = useMutation(trpc.models.cancelPull.mutationOptions());
  const active = item.state !== 'paused' && item.state !== 'failed';

  return (
    <li className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-medium">{item.title ?? item.ref}</span>
          <Badge
            tone={item.state === 'failed' ? 'rose' : item.state === 'paused' ? 'dim' : 'lavender'}
          >
            {STATE_LABEL[item.state]}
          </Badge>
        </div>
        <div className="flex gap-1">
          {active ? (
            <Button size="sm" variant="ghost" onClick={() => pause.mutate(item.id)}>
              Pause
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => resume.mutate(item.id)}>
              {item.state === 'failed' ? 'Try again' : 'Resume'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate(item.id)}>
            Cancel
          </Button>
        </div>
      </div>
      <ProgressBar value={item.totalBytes ? item.doneBytes / item.totalBytes : 0} />
      <p className="text-[12px] text-dim">
        {item.totalBytes > 0 && `${formatBytes(item.doneBytes)} of ${formatBytes(item.totalBytes)}`}
        {item.bytesPerSecond > 0 && ` · ${formatSpeed(item.bytesPerSecond)}`}
        {item.etaSeconds !== null && ` · ${formatDuration(item.etaSeconds)} left`}
      </p>
      {item.error && <ErrorText>{item.error}</ErrorText>}
    </li>
  );
}
