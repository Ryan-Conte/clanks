import type { ClankSummary } from '@clanks/core';
import { Avatar } from '../components/Avatar';
import { useClankModel, useCrew, useProviders, whereItRuns } from '../lib/crew';
import { useNav } from '../lib/nav';

/** Start a chat: pick who to talk to. */
export function HomePage() {
  const crew = useCrew();
  return (
    <div className="relative mx-auto flex max-w-4xl flex-col gap-8 px-10 py-12">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">New chat</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Who do you want to talk to?</h1>
        <p className="text-dim">
          Not sure? Start with Atlas, the lead. Chats are saved on this machine, and pick up where
          you left off.
        </p>
      </header>
      <ul className="grid grid-cols-2 gap-3">
        {crew.map((clank) => (
          <li key={clank.id}>
            <ClankCard clank={clank} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClankCard({ clank }: { clank: ClankSummary }) {
  const { go } = useNav();
  const model = useClankModel(clank);
  const providers = useProviders();
  return (
    <button
      type="button"
      onClick={() => go({ page: 'draft', clankId: clank.id })}
      className="flex h-full w-full flex-col gap-3 rounded-2xl border border-line bg-panel/60 p-5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.03]"
    >
      <span className="flex items-center gap-3">
        <Avatar colour={clank.avatar} size="md" />
        <span className="flex flex-col">
          <span className="font-medium">{clank.name}</span>
          <span className="text-[12px] text-dim">{clank.role}</span>
        </span>
      </span>
      <span className="text-[13px] leading-relaxed text-white/70">{clank.summary}</span>
      <span className="mt-auto truncate font-mono text-[11px] text-dim">
        {model ? `${model.model} · ${whereItRuns(model, providers)}` : 'No model yet'}
      </span>
    </button>
  );
}
