import type { ActivityEvent } from '@clanks/core';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useState } from 'react';
import { formatSeconds } from '../../lib/format';
import { useTRPC } from '../../lib/trpc';
import { useWorkbench } from '../../lib/workbench';
import { Button } from '../ui';

const KINDS: Record<ActivityEvent['kind'], { label: string; tone: string }> = {
  model: { label: 'Model', tone: 'text-accent' },
  tool: { label: 'Tool', tone: 'text-accent-2' },
  checkpoint: { label: 'Checkpoint', tone: 'text-sky-300' },
  review: { label: 'Review', tone: 'text-amber-200' },
  rewind: { label: 'Rewind', tone: 'text-amber-200' },
  workspace: { label: 'Workspace', tone: 'text-dim' },
};

/**
 * Every model and tool call in the chat, with what went in and came out. Picking a step moves the
 * other panes to it: the diff as of that step, the command's output, the place in the chat.
 */
export function ActivityPane() {
  const trpc = useTRPC();
  const { conversationId, state, show } = useWorkbench();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  useSubscription(
    trpc.workspace.activity.subscriptionOptions(conversationId!, {
      enabled: conversationId !== null,
      onStarted: () => setEvents([]),
      onData: (batch) => setEvents((current) => [...current, ...batch]),
    }),
  );

  /** The checkpoint the files were at when a step ran. */
  const checkpointAt = (event: ActivityEvent) => {
    if (event.checkpointId) return event.checkpointId;
    const checkpoints = (state?.checkpoints ?? []).filter((c) => !c.rewound);
    return checkpoints.filter((c) => c.createdAt <= event.startedAt).at(-1)?.id ?? null;
  };

  const pick = (event: ActivityEvent) => {
    setSelected(event.id === selected ? null : event.id);
    const checkpointId = checkpointAt(event);
    show({
      ...(checkpointId ? { checkpointId, diff: event.checkpointId ? 'step' : 'upTo' } : {}),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      ...(event.image ? { image: event.image } : {}),
    });
    // The chat follows too.
    const target =
      (event.toolCallId ? document.getElementById(`tool-${event.toolCallId}`) : null) ??
      (event.messageId ? document.getElementById(`message-${event.messageId}`) : null);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  if (events.length === 0) {
    return <p className="p-6 text-sm text-dim">Every model and tool call shows up here.</p>;
  }
  const start = events[0]!.startedAt;
  return (
    <ol className="h-full overflow-y-auto py-1">
      {events.map((event) => {
        const kind = KINDS[event.kind];
        const open = event.id === selected;
        return (
          <li key={event.id} className={open ? 'bg-white/[0.03]' : ''}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => pick(event)}
              className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-[12px] hover:bg-white/[0.04]"
            >
              <span className="w-16 shrink-0 font-mono text-[10px] whitespace-nowrap text-dim">
                +{formatSeconds(+event.startedAt - +start)}
              </span>
              <span className={`w-16 shrink-0 text-[11px] ${kind.tone}`}>{kind.label}</span>
              <span className="min-w-0 flex-1 truncate text-white/85">
                {event.title.replace(/`/g, '')}
              </span>
              {event.status && event.status !== 'ok' && (
                <span className={event.status === 'cancelled' ? 'text-dim' : 'text-rose-300'}>
                  {event.status}
                </span>
              )}
              {event.durationMs !== null && (
                <span className="shrink-0 font-mono text-[10px] text-dim">
                  {formatSeconds(event.durationMs)}
                </span>
              )}
            </button>
            {open && (
              <div className="flex flex-col gap-2 px-3 pt-1 pb-3 pl-[8.75rem]">
                {event.input && <Block title="In">{event.input}</Block>}
                {event.output && <Block title="Out">{event.output}</Block>}
                <div className="flex gap-2">
                  {checkpointAt(event) && (
                    <Button
                      size="sm"
                      onClick={() =>
                        show({
                          tab: 'diff',
                          checkpointId: checkpointAt(event)!,
                          diff: event.checkpointId ? 'step' : 'upTo',
                        })
                      }
                    >
                      {event.checkpointId ? 'What it changed' : 'Files at this point'}
                    </Button>
                  )}
                  {event.sessionId && (
                    <Button
                      size="sm"
                      onClick={() => show({ tab: 'terminal', sessionId: event.sessionId! })}
                    >
                      Its output
                    </Button>
                  )}
                  {event.image && (
                    <Button size="sm" onClick={() => show({ tab: 'browser', image: event.image! })}>
                      The page at this step
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Block({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium tracking-[0.12em] text-dim uppercase">{title}</span>
      <pre className="max-h-64 overflow-auto rounded-lg bg-black/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-white/80">
        {children}
      </pre>
    </div>
  );
}
