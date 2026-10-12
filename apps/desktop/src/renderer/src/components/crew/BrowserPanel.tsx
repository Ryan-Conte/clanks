import type { ClankSummary } from '@clanks/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText, Panel, Toggle, inputClass } from '../ui';

/** One pattern per line, as typed: blanks and repeats dropped. */
function lines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/** Where a clank may browse, and whether its browser stays signed in between chats. */
export function BrowserPanel({ clank }: { clank: ClankSummary }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [allow, setAllow] = useState<string | null>(null);
  const [deny, setDeny] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const update = useMutation(
    trpc.crew.update.mutationOptions({
      onSuccess: () => {
        setAllow(null);
        setDeny(null);
        void queryClient.invalidateQueries({ queryKey: trpc.crew.list.queryKey() });
      },
    }),
  );
  const clear = useMutation(
    trpc.browser.clearSession.mutationOptions({ onSuccess: () => setCleared(true) }),
  );
  const { browser } = clank;
  const allowText = allow ?? browser.allow.join('\n');
  const denyText = deny ?? browser.deny.join('\n');
  const changed = allow !== null || deny !== null;
  const save = (patch: Partial<typeof browser>) =>
    update.mutate({ id: clank.id, patch: { browser: { ...browser, ...patch } } });

  return (
    <Panel
      title="Browser"
      description={`The sites ${clank.name} may open in the browser pane. While you've taken over, you can go anywhere.`}
    >
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Only these sites</span>
          <textarea
            rows={4}
            spellCheck={false}
            placeholder={'Any site\n\nexample.com\nlocalhost:3000'}
            value={allowText}
            onChange={(e) => setAllow(e.target.value)}
            className={`${inputClass} h-auto py-2 font-mono text-[12.5px]`}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Never these sites</span>
          <textarea
            rows={4}
            spellCheck={false}
            placeholder="None"
            value={denyText}
            onChange={(e) => setDeny(e.target.value)}
            className={`${inputClass} h-auto py-2 font-mono text-[12.5px]`}
          />
        </label>
      </div>
      <p className="text-[12.5px] text-dim">
        One site per line. <code className="font-mono">example.com</code> covers its subdomains too,{' '}
        <code className="font-mono">*.example.com</code> only the subdomains,{' '}
        <code className="font-mono">localhost:3000</code> one port, and{' '}
        <code className="font-mono">https://example.com/docs</code> one part of a site.
      </p>
      {changed && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={update.isPending}
            onClick={() => save({ allow: lines(allowText), deny: lines(denyText) })}
          >
            Save sites
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setAllow(null);
              setDeny(null);
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      <Toggle
        label="Stay signed in"
        description={`Keep ${clank.name}'s cookies between chats and restarts, so sites you sign it in to remember it. Otherwise every chat starts with a fresh, empty browser. Never your own browser's.`}
        checked={browser.persistent}
        disabled={update.isPending}
        onChange={(persistent) => save({ persistent })}
      />
      {browser.persistent && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={clear.isPending}
            onClick={() => {
              setCleared(false);
              clear.mutate(clank.id);
            }}
          >
            Sign out everywhere
          </Button>
          {cleared && (
            <span className="text-[13px] text-dim">Its cookies and storage are gone.</span>
          )}
        </div>
      )}
      {(update.error ?? clear.error) && (
        <ErrorText>{(update.error ?? clear.error)!.message}</ErrorText>
      )}
    </Panel>
  );
}
