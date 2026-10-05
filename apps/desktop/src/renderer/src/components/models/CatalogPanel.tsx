import { useMutation } from '@tanstack/react-query';
import { formatBytes, formatTokens } from '../../lib/format';
import { type CatalogItem, useModels } from '../../lib/models';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText, Panel } from '../ui';
import { Capabilities, FitBadge } from './badges';

/** Recommended models, with an estimate of how each would run here. */
export function CatalogPanel() {
  const snapshot = useModels();
  const catalog = snapshot?.catalog ?? [];

  return (
    <Panel
      title="Catalog"
      description="Open models picked for the crew's roles, straight from Hugging Face and checked by sha256."
    >
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {catalog.map((item) => (
          <CatalogCard key={item.id} item={item} recommended={snapshot?.recommended === item.id} />
        ))}
      </ul>
    </Panel>
  );
}

function CatalogCard({ item, recommended }: { item: CatalogItem; recommended: boolean }) {
  const trpc = useTRPC();
  const snapshot = useModels();
  const pull = useMutation(trpc.models.pull.mutationOptions());
  const pulling = snapshot?.pulls.some((p) => p.modelId === item.id && p.state !== 'done');

  return (
    <li
      className={`flex flex-col gap-3 rounded-2xl border p-4 ${recommended ? 'border-accent/40 bg-accent/[0.05]' : 'border-line bg-black/20'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{item.title}</span>
            {recommended && <Badge tone="lavender">Best fit here</Badge>}
          </p>
          <p className="font-mono text-[12px] text-dim">{item.id}</p>
        </div>
        <FitBadge fit={item.fit} />
      </div>
      <p className="text-[13px] text-white/75">{item.summary}</p>
      <div className="mt-auto flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5 text-[12px] text-dim">
          <span>
            {formatBytes(item.size)} · {formatTokens(item.facts.contextLength)} context ·{' '}
            {item.license}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {item.tags.map((tag) => (
              <span key={tag} className="rounded-md border border-line px-1.5 py-0.5 text-[11px]">
                {tag}
              </span>
            ))}
            <Capabilities capabilities={item.capabilities} />
          </span>
        </div>
        {item.pulled ? (
          <Badge tone="mint">Pulled</Badge>
        ) : (
          <Button
            size="sm"
            variant={recommended ? 'primary' : 'secondary'}
            disabled={pulling || pull.isPending}
            onClick={() => pull.mutate(item.id)}
          >
            {pulling ? 'Pulling' : 'Pull'}
          </Button>
        )}
      </div>
      {pull.error && <ErrorText>{pull.error.message}</ErrorText>}
    </li>
  );
}
