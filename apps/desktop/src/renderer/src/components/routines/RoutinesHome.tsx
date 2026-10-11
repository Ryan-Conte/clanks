import type { RoutinesOverview } from '@clanks/core';
import { useSubscription } from '@trpc/tanstack-react-query';
import type { ReactNode } from 'react';
import { useNav } from '../../lib/nav';
import { ACTION_STATUS, fromNow, useNow } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Dot } from '../ui';

function Card(props: { title: string; tone?: 'amber'; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel/60 p-5">
      <p
        className={`flex items-center gap-2 font-mono text-xs tracking-[0.2em] uppercase ${props.tone === 'amber' ? 'text-amber-200' : 'text-accent'}`}
      >
        {props.title}
        {props.count !== undefined && props.count > 0 && (
          <span className="text-white/60">{props.count}</span>
        )}
      </p>
      {props.children}
    </section>
  );
}

/** Routines across every project, on Home: what waits on the user, and what's coming up. */
export function RoutinesHome() {
  const trpc = useTRPC();
  const { go } = useNav();
  const now = useNow();
  const overview: RoutinesOverview | undefined = useSubscription(
    trpc.routines.overview.subscriptionOptions(),
  ).data;
  if (!overview || (overview.needs.length === 0 && overview.coming.length === 0)) return null;
  const open = (projectId: string, focus: string | null) =>
    go({ page: 'project', id: projectId, tab: 'routines', focus });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {overview.needs.length > 0 && (
        <Card title="Routines need you" tone="amber" count={overview.needs.length}>
          <ul className="flex flex-col gap-1">
            {overview.needs.map((need) => (
              <li key={`${need.kind}:${need.actionId ?? need.runId ?? need.routineId}`}>
                <button
                  type="button"
                  onClick={() =>
                    open(need.projectId, need.actionId ?? need.runId ?? need.routineId)
                  }
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.04]"
                >
                  <span className="min-w-0 flex-1 truncate text-amber-100">{need.text}</span>
                  <span className="text-[11px] text-dim">{need.projectName}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {overview.coming.length > 0 && (
        <Card title={overview.paused ? 'Scheduled (paused)' : 'Scheduled'}>
          <ul className="flex flex-col gap-1">
            {overview.coming.slice(0, 8).map((item) => (
              <li key={`${item.kind}:${item.actionId ?? `${item.routineId}:${+item.at}`}`}>
                <button
                  type="button"
                  onClick={() =>
                    open(item.projectId, item.actionId ?? item.runId ?? item.routineId)
                  }
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.04]"
                >
                  <Dot tone={item.status ? ACTION_STATUS[item.status].tone : 'dim'} />
                  <span className="w-16 shrink-0 font-mono text-[11px] text-dim">
                    {fromNow(item.at, now)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {item.title}
                    {item.status === 'pending_approval' && (
                      <span className="text-amber-200"> · needs approval</span>
                    )}
                  </span>
                  <span className="text-[11px] text-dim">{item.projectName}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
