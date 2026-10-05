import type { ChatUsage, FinishReason } from '@clanks/core';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { formatRate } from '../../lib/format';
import { useModels } from '../../lib/models';
import { trpcClient } from '../../lib/trpc';
import { Button, Dot, ErrorText, Panel, inputClass } from '../ui';

interface Reply {
  text: string;
  reasoning: string;
  usage: ChatUsage | null;
  error: string | null;
  running: boolean;
  finish: FinishReason | null;
}

const empty: Reply = {
  text: '',
  reasoning: '',
  usage: null,
  error: null,
  running: false,
  finish: null,
};

/** A prompt box to try a pulled model, through the same provider the crew will use. */
export function TryPanel({
  model,
  onModel,
}: {
  model: string | null;
  onModel: (id: string) => void;
}) {
  const snapshot = useModels();
  const library = (snapshot?.library ?? []).filter((m) => !m.missing);
  const selected = model ?? snapshot?.crewModel ?? library[0]?.id ?? '';
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState<Reply>(empty);
  const stop = useRef<(() => void) | null>(null);
  const loaded = snapshot?.runtime.loaded.find((l) => l.modelId === selected);

  useEffect(() => () => stop.current?.(), []);

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    stop.current?.();
    setReply({ ...empty, running: true });
    const subscription = trpcClient.models.try.subscribe(
      { model: selected, prompt },
      {
        onData: (event) => {
          setReply((current) => {
            switch (event.type) {
              case 'text':
                return { ...current, text: current.text + event.text };
              case 'reasoning':
                return { ...current, reasoning: current.reasoning + event.text };
              case 'usage':
                return { ...current, usage: event.usage };
              case 'done':
                return { ...current, running: false, finish: event.finishReason };
              default:
                return current;
            }
          });
        },
        onError: (error) =>
          setReply((current) => ({ ...current, error: error.message, running: false })),
        onComplete: () => setReply((current) => ({ ...current, running: false })),
      },
    );
    stop.current = () => {
      subscription.unsubscribe();
      setReply((current) => ({ ...current, running: false }));
    };
  };

  return (
    <Panel
      title="Try a model"
      description="Ask it something. It answers here, on this machine, even with the network off."
    >
      {library.length === 0 ? (
        <p className="text-sm text-dim">Pull a model to try it.</p>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-3">
          <div className="flex gap-2">
            <select
              aria-label="Model"
              className={`${inputClass} w-64 shrink-0 font-mono text-[13px]`}
              value={selected}
              onChange={(e) => onModel(e.target.value)}
            >
              {library.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
            <input
              aria-label="Prompt"
              className={`${inputClass} w-full min-w-0`}
              placeholder="Write a haiku about a surf shop."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            {reply.running ? (
              <Button onClick={() => stop.current?.()}>Stop</Button>
            ) : (
              <Button type="submit" variant="primary" disabled={!prompt.trim()}>
                Send
              </Button>
            )}
          </div>
          {(reply.running || reply.text || reply.reasoning || reply.error) && (
            <div className="flex flex-col gap-3 rounded-2xl border border-line bg-black/30 p-4">
              {reply.running && !reply.text && !reply.reasoning && (
                <p className="flex items-center gap-2 text-sm text-dim">
                  <Dot tone="lavender" live />
                  {loaded?.state === 'ready' ? 'Thinking…' : 'Loading the model…'}
                </p>
              )}
              {reply.reasoning && (
                <details className="text-[13px] text-dim" open={reply.running && !reply.text}>
                  <summary className="cursor-pointer select-none">Thinking</summary>
                  <p className="mt-2 whitespace-pre-wrap">{reply.reasoning}</p>
                </details>
              )}
              {reply.text && (
                <p className="text-sm whitespace-pre-wrap text-white/90">{reply.text}</p>
              )}
              {reply.usage && (
                <p className="font-mono text-[12px] text-dim">
                  {reply.usage.completionTokens} tokens · {formatRate(reply.usage.tokensPerSecond)}{' '}
                  · {(reply.usage.durationMs / 1000).toFixed(1)} s
                  {reply.finish === 'length' && ' · stopped at the length limit'}
                </p>
              )}
              {reply.error && <ErrorText>{reply.error}</ErrorText>}
            </div>
          )}
        </form>
      )}
    </Panel>
  );
}
