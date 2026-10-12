import type { BoardSnapshot, ClankSummary, NeedsYouItem, TicketCard, ToolPart } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { COLUMN_LABELS, cardStatus, namer, progressText } from '../../lib/board';
import { plainJob, useConversations, useCrew } from '../../lib/crew';
import { useNav, useOpenTicket } from '../../lib/nav';
import { useNow, useRoutines } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { ToolCard } from '../chat/ToolCard';
import {
  BoardIcon,
  Button,
  CheckIcon,
  Disclosure,
  Dot,
  ErrorText,
  ProgressBar,
  inputClass,
} from '../ui';
import { RunCard } from '../routines/RunCard';
import { TicketActions } from './TicketDrawer';

/**
 * What in the project waits on the user besides finished work, as cards in their conversation with
 * the lead: a clank's question, something risky it wants to do, work that stopped, and a routine's
 * run before anything goes out. Finished work is a message of its own (`Deliverable`). Nobody has
 * to go and find the clank that asked.
 */
export function ProjectAsks({
  snapshot,
  skipConversation,
}: {
  snapshot: BoardSnapshot;
  /** The chat these show in, whose own questions are already in its messages. */
  skipConversation: string | null;
}) {
  const crew = useCrew();
  const now = useNow();
  const routines = useRoutines(snapshot.project.id);
  const ready = new Set(snapshot.tickets.filter((t) => t.column === 'ready').map((t) => t.id));
  const items = snapshot.needsYou
    .filter((item) => item.conversationId === null || item.conversationId !== skipConversation)
    // Work that's ready has its own message, with what was made in it.
    .filter((item) => !ready.has(item.ticketId))
    .sort((a, b) => +a.at - +b.at);
  // A routine's run that's made what it will send, and waits for a yes before any of it goes out.
  const runs = routines?.runs.filter((r) => r.status === 'awaiting_approval' || r.asks) ?? [];
  if (items.length === 0 && runs.length === 0) return null;
  return (
    // The project's header brings this into view when it says something is waiting.
    <div data-waiting="" className="flex flex-col gap-6">
      {routines && runs.length > 0 && (
        <ul className="flex flex-col gap-3">
          {runs.map((run) => (
            <RunCard key={run.id} run={run} zone={routines.zone} now={now} open />
          ))}
        </ul>
      )}
      {items.map((item) => {
        const card = snapshot.tickets.find((t) => t.id === item.ticketId);
        if (!card) return null;
        const key = `${item.ticketId}:${item.kind}`;
        return (item.kind === 'approval' || item.kind === 'question') && item.conversationId ? (
          <RunAsk
            key={key}
            item={item}
            conversationId={item.conversationId}
            card={card}
            crew={crew}
          />
        ) : (
          <TicketAsk key={key} item={item} card={card} snapshot={snapshot} crew={crew} />
        );
      })}
    </div>
  );
}

/** A card from the crew in the conversation: who it's from, and what it's about. */
function Ask(props: {
  clank: ClankSummary | undefined;
  title: ReactNode;
  about?: string;
  children: ReactNode;
}) {
  return (
    <div className="animate-rise flex gap-3">
      <Avatar colour={props.clank?.avatar ?? 'slate'} />
      <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-3xl rounded-tl-lg border border-amber-300/25 bg-amber-300/[0.04] p-4">
        <div className="flex flex-col gap-0.5">
          <p className="flex items-center gap-2 text-sm font-medium text-amber-50">
            <Dot tone="amber" live />
            {props.title}
          </p>
          {props.about && <p className="text-[12px] text-dim">{props.about}</p>}
        </div>
        {props.children}
      </div>
    </div>
  );
}

/**
 * Something a clank is stopped on in its own run: a question, or a risky step that needs a yes.
 * The answer goes to that run, which carries on.
 */
function RunAsk(props: {
  item: NeedsYouItem;
  conversationId: string;
  card: TicketCard;
  crew: ClankSummary[];
}) {
  const { item, conversationId, card } = props;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const run = useQuery(trpc.chat.get.queryOptions(conversationId));
  // What it's stopped on changes with the board, so it's read again whenever the board says so.
  const changed = +item.at;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.chat.get.queryKey(conversationId) });
  }, [queryClient, trpc, conversationId, changed]);
  const clank = props.crew.find((c) => c.id === run.data?.conversation.clankId);
  const parts = (run.data?.messages.at(-1)?.parts ?? []).filter(
    (part): part is ToolPart => part.type === 'tool',
  );
  const approvals = parts.filter((part) => part.status === 'asking' && part.approval);
  const question = parts
    .filter((part) => part.name === 'ask_user' && part.status === 'done')
    .at(-1);

  if (!run.data || !clank) return null;
  if (item.kind === 'approval') {
    if (approvals.length === 0) return null;
    return (
      <div className="animate-rise flex gap-3">
        <Avatar colour={clank.avatar} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="pt-1 text-[12px] text-dim">
            While working on <span className="text-white/80">{card.title}</span>
          </p>
          {approvals.map((part) => (
            <ToolCard key={part.id} part={part} conversationId={conversationId} clank={clank} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <Ask clank={clank} title={`${clank.name} has a question`} about={`About: ${card.title}`}>
      <Question
        conversationId={conversationId}
        clank={clank}
        part={question}
        fallback={card.reason ?? item.text}
      />
    </Ask>
  );
}

/** A clank's question, answered right here: one of its options, or the user's own words. */
function Question(props: {
  conversationId: string;
  clank: ClankSummary;
  part: ToolPart | undefined;
  /** The question as the board has it, when the run's own call can't be read. */
  fallback: string;
}) {
  const trpc = useTRPC();
  const [text, setText] = useState('');
  const send = useMutation(trpc.chat.send.mutationOptions());
  let args: { question?: unknown; options?: unknown; recommendation?: unknown } = {};
  try {
    args = JSON.parse(props.part?.arguments || '{}') as typeof args;
  } catch {
    // The board's wording is shown instead.
  }
  const question = typeof args.question === 'string' ? args.question : props.fallback;
  const options = Array.isArray(args.options)
    ? args.options.filter((o): o is string => typeof o === 'string')
    : [];
  const recommended = typeof args.recommendation === 'string' ? args.recommendation : '';
  const answer = (reply: string) =>
    send.mutate({ conversationId: props.conversationId, text: reply });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) answer(text);
  };

  return (
    <>
      <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-white">{question}</p>
      {recommended && (
        <p className="text-[13px] text-dim">
          {props.clank.name} would go with: {recommended}
        </p>
      )}
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === recommended ? 'primary' : 'secondary'}
              disabled={send.isPending}
              onClick={() => answer(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="flex gap-2">
        <input
          aria-label={`Your answer to ${props.clank.name}`}
          placeholder={options.length > 0 ? 'Or answer in your own words' : 'Your answer'}
          className={`${inputClass} min-w-0 flex-1`}
          value={text}
          disabled={send.isPending}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!text.trim() || send.isPending}>
          Send
        </Button>
      </form>
      {send.error && <ErrorText>{send.error.message}</ErrorText>}
    </>
  );
}

const ASK_TITLES: Record<NeedsYouItem['kind'], string> = {
  ready: 'is ready for you',
  question: 'has a question',
  approval: 'needs a yes',
  paused: 'is paused',
  failed: 'hit a problem',
  looping: 'keeps going back and forth',
  proposal: 'is a suggestion from the crew',
};

/** A ticket stopped on the user, such as one that paused or failed, and what they can do about it. */
function TicketAsk(props: {
  item: NeedsYouItem;
  card: TicketCard;
  snapshot: BoardSnapshot;
  crew: ClankSummary[];
}) {
  const { item, card, snapshot } = props;
  const open = useOpenTicket(snapshot.project.id);
  const maker = props.crew.find((c) => c.id === (card.route[0]?.clankId ?? card.createdBy));
  const draft = snapshot.specs.find((s) => s.ticketId === card.id && s.status !== 'approved');
  return (
    <Ask
      clank={maker}
      title={
        <span>
          <span className="text-white">{card.title}</span> {ASK_TITLES[item.kind]}
        </span>
      }
    >
      <TicketActions
        compact
        card={card}
        snapshot={snapshot}
        draftVersion={draft?.version ?? null}
        onClose={() => {}}
      />
      <button
        type="button"
        className="self-start text-[12px] text-dim transition-colors hover:text-white"
        onClick={() => open(card.id)}
      >
        See everything about it
      </button>
    </Ask>
  );
}

/**
 * Beside the conversation: the crew, and what each of them is doing this moment, then the work as
 * a plain list. It's there to glance at; nothing in it needs doing.
 */
export function CrewRail({ snapshot }: { snapshot: BoardSnapshot }) {
  const { go } = useNav();
  const crew = useCrew();
  const name = namer(crew);
  const { project, tickets } = snapshot;
  const members = crew.filter((c) => project.crew.some((m) => m.clankId === c.id));
  const open = useOpenTicket(project.id);
  // A clank answering the user in a chat is at work too, though no ticket says so.
  const chatting = new Set(
    (useConversations() ?? [])
      .filter((c) => c.projectId === project.id && c.role === null && c.replying)
      .map((c) => c.clankId),
  );
  const done = tickets.filter((t) => t.column === 'done');
  const underway = tickets.filter((t) => t.column !== 'done');
  // What's furthest along first: with you, being checked, being made, then what's waiting.
  const order = { ready: 0, review: 1, build: 2, backlog: 3, done: 4 } as const;
  const listed = [...underway].sort((a, b) => order[a.column] - order[b.column]);

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-6 overflow-y-auto border-l border-line bg-panel/40 px-5 py-5">
      <section className="flex flex-col gap-3">
        <h2 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">The crew</h2>
        <ul className="flex flex-col gap-1">
          {members.map((clank) => {
            const on = tickets.filter(
              (t) =>
                (t.column === 'build' || t.column === 'review') &&
                (t.live?.clankId ?? t.detour?.clankId ?? t.route[t.step]?.clankId) === clank.id,
            );
            const live = on.find((t) => t.live && !t.live.asking);
            const current = live ?? on[0];
            const next = tickets.find((t) => t.column === 'backlog' && t.assignee === clank.id);
            return (
              <li key={clank.id}>
                <button
                  type="button"
                  title={
                    current?.live
                      ? `Watch ${clank.name} work`
                      : `${clank.name}: ${plainJob(clank)}. Click to chat.`
                  }
                  onClick={() =>
                    current?.live
                      ? go({ page: 'chat', id: current.live.conversationId })
                      : go({ page: 'draft', clankId: clank.id, projectId: project.id })
                  }
                  className="flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.04]"
                >
                  <Avatar colour={clank.avatar} live={Boolean(live) || chatting.has(clank.id)} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-2 text-sm">
                      <span className="font-medium">{clank.name}</span>
                      {on.length > 1 && <span className="tabular text-dim">×{on.length}</span>}
                    </span>
                    {current ? (
                      <>
                        <span className="truncate text-[12px] text-white/75">{current.title}</span>
                        {current.live && (
                          <span
                            className={`truncate text-[12px] ${current.live.asking ? 'text-amber-200' : 'text-accent-2'}`}
                          >
                            {current.live.label.replace(/`/g, '')}
                          </span>
                        )}
                      </>
                    ) : chatting.has(clank.id) ? (
                      <span className="truncate text-[12px] text-accent-2">Answering you</span>
                    ) : (
                      <span className="truncate text-[12px] text-dim">
                        {next ? `Up next: ${next.title}` : plainJob(clank)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">The work</h2>
          <button
            type="button"
            onClick={() => go({ page: 'project', id: project.id, tab: 'board' })}
            className="flex items-center gap-1.5 text-[12px] text-dim transition-colors hover:text-white"
          >
            <BoardIcon /> Board
          </button>
        </div>
        {tickets.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-dim">
            Nothing is planned yet. Tell Atlas what you want and the work shows up here as the crew
            takes it on.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <ProgressBar value={done.length / tickets.length} tone="mint" />
              <p className="tabular text-[12px] text-dim">
                {done.length} of {tickets.length} done
              </p>
            </div>
            <ul className="flex flex-col gap-0.5">
              {listed.map((card) => {
                const status = cardStatus(card, snapshot, name);
                const progress = progressText(card);
                return (
                  <li key={card.id}>
                    <button
                      type="button"
                      onClick={() => open(card.id)}
                      className="flex w-full flex-col gap-0.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
                    >
                      <span className="truncate text-[13px] text-white/90">{card.title}</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-dim">
                        <span
                          className={`size-1.5 shrink-0 rounded-full ${card.column === 'ready' ? 'bg-amber-300' : card.column === 'backlog' ? 'bg-white/25' : 'bg-accent-2'} ${status.live ? 'animate-pulse-dot' : ''}`}
                        />
                        <span className="truncate">
                          {COLUMN_LABELS[card.column]}
                          {progress ? ` · ${progress}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {done.length > 0 && (
              <Disclosure summary={`Done (${done.length})`}>
                <ul className="-mt-2 flex flex-col gap-0.5">
                  {done.map((card) => (
                    <li key={card.id}>
                      <button
                        type="button"
                        onClick={() => open(card.id)}
                        className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[13px] text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white"
                      >
                        <span className="shrink-0 text-accent-2">
                          <CheckIcon />
                        </span>
                        <span className="truncate">{card.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
