import type { ClankSummary } from '@clanks/core';
import { useQuery } from '@tanstack/react-query';
import { formatCount } from '../../lib/format';
import { providerName, useClankModel, useProviders } from '../../lib/crew';
import { useTRPC } from '../../lib/trpc';
import { Badge, ErrorText, IconButton, XIcon } from '../ui';

/** Exactly what a clank is told before the conversation: its system prompt, layer by layer. */
export function PromptPanel(props: {
  clank: ClankSummary;
  conversationId: string | null;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const providers = useProviders();
  const model = useClankModel(props.clank);
  const preview = useQuery(
    trpc.chat.preview.queryOptions({
      clankId: props.clank.id,
      conversationId: props.conversationId,
    }),
  );
  const cloud = model && model.provider !== 'builtin';

  return (
    <aside className="flex w-[26rem] shrink-0 flex-col border-l border-line bg-panel/50">
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">What {props.clank.name} is told</h2>
          <p className="text-[12px] text-dim">
            {preview.data
              ? `About ${formatCount(preview.data.tokens)} tokens before the chat. `
              : ''}
            {cloud
              ? `This goes to ${providerName(model, providers)} with every message.`
              : 'It never leaves this machine.'}
          </p>
        </div>
        <IconButton label="Close" onClick={props.onClose}>
          <XIcon />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {preview.error && <ErrorText>{preview.error.message}</ErrorText>}
        <ol className="flex flex-col gap-3">
          {preview.data?.layers.map((layer) => (
            <li key={layer.id}>
              <details className="group rounded-xl border border-line bg-black/20">
                <summary className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm select-none">
                  <span>{layer.title}</span>
                  <span className="flex items-center gap-2">
                    {layer.truncated && <Badge tone="amber">Cut to fit</Badge>}
                    <span className="font-mono text-[11px] text-dim">
                      {formatCount(layer.tokens)}
                      {layer.budget ? ` / ${formatCount(layer.budget)}` : ''} tokens
                    </span>
                  </span>
                </summary>
                <pre className="max-h-96 overflow-auto border-t border-line px-3.5 py-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-white/75">
                  {layer.text}
                </pre>
              </details>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}
