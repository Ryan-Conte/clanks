import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { formatAgo } from '../../lib/format';
import { indexLabel, useMarketplace } from '../../lib/integrations';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, Dot, ErrorText, Panel, inputClass } from '../ui';

/** Where packages come from: the public marketplace, and any of a team's own beside it. */
export function MarketplacePanel() {
  const trpc = useTRPC();
  const { go } = useNav();
  const snapshot = useMarketplace();
  const [url, setUrl] = useState('');
  const add = useMutation(
    trpc.marketplace.addIndex.mutationOptions({ onSuccess: () => setUrl('') }),
  );
  const addFolder = useMutation(trpc.marketplace.addIndexFolder.mutationOptions());
  const remove = useMutation(trpc.marketplace.removeIndex.mutationOptions());
  const refresh = useMutation(trpc.marketplace.refresh.mutationOptions());
  const error = add.error ?? addFolder.error ?? remove.error ?? refresh.error;

  return (
    <Panel
      title="Marketplaces"
      description="Where clanks, integrations and crews are installed from. The public one needs no account and keeps no count of who installs what. Add another in the same format, such as your team's: the address of its index.json, or a folder on a shared drive."
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={refresh.isPending || snapshot?.refreshing}
            onClick={() => refresh.mutate()}
          >
            {snapshot?.refreshing ? 'Reading…' : 'Read them again'}
          </Button>
          <Button size="sm" onClick={() => go({ page: 'marketplace' })}>
            Browse
          </Button>
        </>
      }
    >
      <ul className="flex flex-col divide-y divide-line">
        {snapshot?.indexes.map((index) => (
          <li key={index.url} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <Dot tone={index.error ? 'rose' : index.fetchedAt ? 'mint' : 'dim'} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm">
                {index.name}
                {index.builtin && <Badge>Public</Badge>}
                {index.fetchedAt && (
                  <span className="text-[12px] text-dim">
                    {index.packages} {index.packages === 1 ? 'package' : 'packages'}, read{' '}
                    {formatAgo(index.fetchedAt)}
                  </span>
                )}
              </span>
              <span className="truncate font-mono text-[12px] text-dim" title={index.url}>
                {indexLabel(index.url)}
              </span>
              {index.error && <span className="text-[12px] text-rose-300">{index.error}</span>}
            </span>
            {!index.builtin && (
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(index.url)}>
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) add.mutate(url.trim());
        }}
      >
        <input
          aria-label="A marketplace's address"
          placeholder="https://example.com/marketplace/index.json"
          className={`${inputClass} flex-1 font-mono text-[13px]`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" disabled={!url.trim() || add.isPending}>
          Add
        </Button>
        <Button disabled={addFolder.isPending} onClick={() => addFolder.mutate()}>
          A folder…
        </Button>
      </form>
      {error && <ErrorText>{error.message}</ErrorText>}
    </Panel>
  );
}
