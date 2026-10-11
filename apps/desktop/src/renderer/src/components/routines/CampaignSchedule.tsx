import type { TicketCard } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNav } from '../../lib/nav';
import { useNow, useRoutines, when } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText } from '../ui';
import { Dialog } from './shared';

/**
 * Schedules an approved campaign's posts. Each one with a time, an account and, when it names a
 * frame, a picture can go out at its time. Every post is shown in full, and scheduling the ones
 * ticked is their approval: exactly what's shown goes out, or nothing does.
 */
export function CampaignSchedule({ card, onClose }: { card: TicketCard; onClose: () => void }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const now = useNow();
  const zone = useRoutines(card.projectId)?.zone ?? 'UTC';
  const plan = useQuery(trpc.routines.campaignPlan.queryOptions(card.id));
  const [picked, setPicked] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const schedule = useMutation(
    trpc.routines.scheduleCampaign.mutationOptions({
      onError: (e) => setError(e.message),
      onSuccess: () => {
        onClose();
        go({ page: 'project', id: card.projectId, tab: 'routines' });
      },
    }),
  );
  const posts = plan.data ?? [];
  const ready = posts.filter((p) => p.problems.length === 0).map((p) => p.index);
  const chosen = (picked ?? ready).filter((i) => ready.includes(i));

  return (
    <Dialog
      title={`Schedule the posts of ${card.key}`}
      onClose={onClose}
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={chosen.length === 0 || schedule.isPending}
          onClick={() => schedule.mutate({ ticketId: card.id, posts: chosen })}
        >
          {chosen.length === 1
            ? 'Approve and schedule it'
            : `Approve and schedule ${chosen.length}`}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-dim">
          Each post ticked goes out at its time, from its account, exactly as it reads here. clanks
          posts it, with no model involved, and never later than 15 minutes after its time.
        </p>
        {plan.error && <ErrorText>{plan.error.message}</ErrorText>}
        {posts.length === 0 && plan.data && (
          <p className="text-[13px] text-dim">This campaign has no posts drafted.</p>
        )}
        <ol className="flex flex-col gap-3">
          {posts.map((post) => {
            const ok = post.problems.length === 0;
            const on = chosen.includes(post.index);
            return (
              <li
                key={post.index}
                className={`flex gap-3 rounded-2xl border p-4 ${ok ? 'border-line bg-black/20' : 'border-line bg-black/10 opacity-80'}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Schedule post ${post.index + 1}`}
                  className="mt-1"
                  disabled={!ok}
                  checked={on}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked
                        ? [...chosen, post.index]
                        : chosen.filter((i) => i !== post.index),
                    )
                  }
                />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <span className="flex flex-wrap items-center gap-2 text-[12px]">
                    <Badge tone="lavender">{post.channel || 'No channel'}</Badge>
                    {post.connectionLabel && (
                      <span className="font-mono text-white/80">{post.connectionLabel}</span>
                    )}
                    {post.at && <span className="text-white/80">{when(post.at, zone, now)}</span>}
                    {post.visual && <span className="text-dim">with {post.visual}</span>}
                  </span>
                  <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-white/90">
                    {post.text}
                  </p>
                  {post.problems.map((problem) => (
                    <p key={problem} className="text-[13px] text-amber-200">
                      {problem}
                    </p>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Dialog>
  );
}
