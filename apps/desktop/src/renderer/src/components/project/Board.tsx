import {
  type BoardSnapshot,
  COLUMN_TITLES,
  type ClankSummary,
  type OutputType,
  TICKET_COLUMNS,
  type TicketCard,
  type TicketColumn,
  outputTypeSchema,
} from '@clanks/core';
import { useMutation } from '@tanstack/react-query';
import {
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { TYPE_LABELS, actorName, cardStatus, ciText, namer, progressText } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { Badge, Button, ErrorText, IconButton, PlusIcon, XIcon, inputClass } from '../ui';
import { TicketDrawer } from './TicketDrawer';

/** The drag's ticket id travels under this type, so other drags are ignored. */
const DRAG_TYPE = 'application/x-clanks-ticket';

type View = 'columns' | 'clanks';

/** The live board: Needs you, the crew, the columns or lanes, and the feed, with a ticket's drawer. */
export function Board({ snapshot, ticket }: { snapshot: BoardSnapshot; ticket: string | null }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const [filter, setFilter] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [view, setView] = useState<View>('columns');
  const [stopping, setStopping] = useState<string | null>(null);
  const project = snapshot.project;
  const members = crew.filter((c) => project.crew.some((m) => m.clankId === c.id));
  const name = namer(crew);
  const open = (id: string | null) =>
    go({ page: 'project', id: project.id, tab: 'board', ticket: id });

  const say = (message: string) => setNotice(message);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const onError = (error: { message: string }) => say(error.message);
  const reorder = useMutation(trpc.board.reorder.mutationOptions({ onError }));
  const move = useMutation(trpc.board.move.mutationOptions({ onError }));
  const assign = useMutation(trpc.board.assign.mutationOptions({ onError }));

  const shown = snapshot.tickets.filter(
    (t) =>
      !filter ||
      t.assignee === filter ||
      t.live?.clankId === filter ||
      t.route[t.step]?.clankId === filter,
  );
  const dropOn = (column: TicketColumn, before: string | null) => (event: DragEvent) => {
    const id = event.dataTransfer.getData(DRAG_TYPE);
    setDragging(null);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const card = snapshot.tickets.find((t) => t.id === id);
    if (!card || before === id) return;
    if (card.column === 'backlog' && column === 'backlog') reorder.mutate({ id, before });
    // Stopping a run asks first; the work so far stays on its branch.
    else if (card.column === 'build' && column === 'backlog') setStopping(id);
    else move.mutate({ id, column });
  };
  /** Follows a ticket's run in its workbench: the run being written now, or the latest. */
  const watch = (card: TicketCard) => {
    const run = card.live ?? card.runs.find((r) => r.replying) ?? card.runs.at(-1);
    if (run) go({ page: 'chat', id: run.conversationId });
  };
  const stoppingCard = snapshot.tickets.find((t) => t.id === stopping);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <CrewStrip
          snapshot={snapshot}
          members={members}
          filter={filter}
          onFilter={(id) => setFilter((f) => (f === id ? null : id))}
          onDropTicket={(ticketId, clankId) => assign.mutate({ id: ticketId, clankId })}
        />
        <NeedsYou snapshot={snapshot} onOpen={open} />
        {notice && (
          <p
            role="status"
            className="mx-6 mb-2 flex items-center gap-2 rounded-xl border border-amber-300/25 bg-amber-300/[0.07] px-3 py-2 text-[13px] text-amber-100"
          >
            <span className="flex-1">{notice}</span>
            <IconButton label="Dismiss" onClick={() => setNotice(null)}>
              <XIcon />
            </IconButton>
          </p>
        )}
        {stoppingCard && (
          <p
            role="alert"
            className="mx-6 mb-2 flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2 text-[13px]"
          >
            <span className="flex-1">
              Stop {stoppingCard.key} and put it back in the backlog? Its work so far stays on its
              branch, and it carries on from there when it starts again.
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                move.mutate({ id: stoppingCard.id, column: 'backlog' });
                setStopping(null);
              }}
            >
              Stop it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStopping(null)}>
              Keep going
            </Button>
          </p>
        )}
        <span className="flex gap-1 px-6 pb-2" role="tablist" aria-label="View">
          {(
            [
              ['columns', 'Columns'],
              ['clanks', 'By clank'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={`rounded-full px-3 py-0.5 text-[12px] ${view === id ? 'bg-white/[0.08] text-white' : 'text-dim hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </span>
        {view === 'clanks' ? (
          <ByClank
            snapshot={snapshot}
            members={members}
            name={name}
            onOpen={open}
            onWatch={watch}
          />
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-3">
            {TICKET_COLUMNS.map((column) => {
              const cards = shown.filter((t) => t.column === column);
              if (column === 'done' && !showDone) {
                return (
                  <button
                    key={column}
                    type="button"
                    onClick={() => setShowDone(true)}
                    title="Show done tickets"
                    className="flex w-11 shrink-0 flex-col items-center gap-2 rounded-2xl border border-line bg-panel/40 py-3 text-[12px] text-dim hover:text-white"
                  >
                    <span className="font-mono">{cards.length}</span>
                    <span className="[writing-mode:vertical-rl]">Done</span>
                  </button>
                );
              }
              return (
                <section
                  key={column}
                  aria-label={COLUMN_TITLES[column]}
                  onDragOver={(e) => {
                    if (dragging) e.preventDefault();
                  }}
                  onDrop={dropOn(column, null)}
                  className={`flex max-w-80 min-w-56 flex-1 basis-0 flex-col rounded-2xl border bg-panel/40 transition-colors ${dragging ? 'border-white/15' : 'border-line'}`}
                >
                  <header className="flex items-center justify-between px-3.5 pt-3 pb-2">
                    <span className="flex items-baseline gap-2 text-[13px] font-medium">
                      {COLUMN_TITLES[column]}
                      <span className="font-mono text-[11px] text-dim">{cards.length}</span>
                    </span>
                    {column === 'backlog' && (
                      <IconButton label="Add a card" onClick={() => setAdding((a) => !a)}>
                        <PlusIcon />
                      </IconButton>
                    )}
                    {column === 'done' && (
                      <IconButton label="Hide done tickets" onClick={() => setShowDone(false)}>
                        <XIcon />
                      </IconButton>
                    )}
                  </header>
                  <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2.5">
                    {column === 'backlog' && adding && (
                      <li>
                        <AddTicket
                          snapshot={snapshot}
                          members={members}
                          onDone={(id) => {
                            setAdding(false);
                            if (id) open(id);
                          }}
                        />
                      </li>
                    )}
                    {cards.map((card) => (
                      <li
                        key={card.id}
                        onDragOver={(e) => {
                          if (dragging) e.preventDefault();
                        }}
                        onDrop={dropOn(column, column === 'backlog' ? card.id : null)}
                      >
                        <Card
                          card={card}
                          snapshot={snapshot}
                          name={name}
                          crew={crew}
                          selected={ticket === card.id}
                          onOpen={() => open(card.id)}
                          onWatch={() => watch(card)}
                          onDragStart={(e) => {
                            e.dataTransfer.setData(DRAG_TYPE, card.id);
                            e.dataTransfer.effectAllowed = 'move';
                            setDragging(card.id);
                          }}
                          onDragEnd={() => setDragging(null)}
                        />
                      </li>
                    ))}
                    {cards.length === 0 && !(column === 'backlog' && adding) && (
                      <li className="px-1 py-2 text-[12px] text-dim">{emptyText(column)}</li>
                    )}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
        <Feed snapshot={snapshot} crew={crew} onOpen={open} />
      </div>
      {ticket && snapshot.tickets.some((t) => t.id === ticket) && (
        <TicketDrawer
          key={ticket}
          snapshot={snapshot}
          card={snapshot.tickets.find((t) => t.id === ticket)!}
          onClose={() => open(null)}
          onWatch={watch}
        />
      )}
    </div>
  );
}

function emptyText(column: TicketColumn): string {
  return {
    backlog: 'Nothing waiting. Ask Atlas for work, or add a card.',
    build: 'Nobody is making anything right now.',
    review: 'Nothing being checked.',
    ready: 'Nothing waiting for you.',
    done: 'Nothing done yet.',
  }[column];
}

/** Every clank in the project, what it's on now, and a place to drop a card to reassign it. */
function CrewStrip(props: {
  snapshot: BoardSnapshot;
  members: ClankSummary[];
  filter: string | null;
  onFilter: (clankId: string) => void;
  onDropTicket: (ticketId: string, clankId: string) => void;
}) {
  const [over, setOver] = useState<string | null>(null);
  return (
    <ul className="flex flex-wrap items-center gap-1.5 px-6 pt-3 pb-2" aria-label="The crew">
      {props.members.map((clank) => {
        const on = props.snapshot.tickets.filter((t) => t.live?.clankId === clank.id);
        const active = props.filter === clank.id;
        const spend = props.snapshot.clanks[clank.id];
        return (
          <li key={clank.id}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => props.onFilter(clank.id)}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(clank.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData(DRAG_TYPE);
                if (id) props.onDropTicket(id, clank.id);
              }}
              title={
                (on.length > 0
                  ? `${clank.name}: ${on.map((t) => t.key).join(', ')}. `
                  : `${clank.name} is free. `) +
                `Click to show only its tickets; drop a card to give it to ${clank.name}.` +
                (spend?.reached ? ` Its budget of ${spend.reached} is spent.` : '')
              }
              className={`flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-[12px] transition-colors ${over === clank.id ? 'border-accent bg-accent/15' : active ? 'border-accent/50 bg-accent/[0.08] text-white' : 'border-line text-white/75 hover:bg-white/[0.04]'}`}
            >
              <Avatar colour={clank.avatar} size="xs" live={on.length > 0} />
              {clank.name}
              {on.length > 1 && <span className="font-mono text-dim">×{on.length}</span>}
              {spend?.reached ? (
                <span className="text-[11px] text-amber-200">‖ budget</span>
              ) : on.length > 0 ? (
                <span className="font-mono text-[11px] text-accent-2">
                  {on.map((t) => t.key).join(' ')}
                </span>
              ) : (
                <span className="text-dim">○</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Everything on this board waiting on the user, oldest first. */
function NeedsYou({ snapshot, onOpen }: { snapshot: BoardSnapshot; onOpen: (id: string) => void }) {
  const { go } = useNav();
  if (snapshot.needsYou.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
      <span className="text-[11px] font-medium tracking-[0.15em] text-amber-200 uppercase">
        Needs you
      </span>
      {snapshot.needsYou.map((item) => (
        <button
          key={`${item.ticketId}:${item.kind}`}
          type="button"
          onClick={() =>
            item.kind === 'approval' && item.conversationId
              ? go({ page: 'chat', id: item.conversationId })
              : onOpen(item.ticketId)
          }
          className="flex max-w-96 items-center gap-2 rounded-full border border-amber-300/25 bg-amber-300/[0.06] px-3 py-1 text-[12px] text-amber-100 hover:bg-amber-300/[0.12]"
        >
          <span className="font-mono text-[11px] whitespace-nowrap">{item.key}</span>
          <span className="truncate">{item.text}</span>
        </button>
      ))}
    </div>
  );
}

function Card(props: {
  card: TicketCard;
  snapshot: BoardSnapshot;
  name: (id: string) => string;
  crew: ClankSummary[];
  selected: boolean;
  onOpen: () => void;
  onWatch: () => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { card } = props;
  const status = cardStatus(card, props.snapshot, props.name);
  // The clank it's with, or in the backlog, the one it's for.
  const who = status.clankId ?? (card.column === 'backlog' ? card.assignee : null);
  const colour = props.crew.find((c) => c.id === who)?.avatar;
  const progress = progressText(card);
  const needsYou = props.snapshot.needsYou.some((n) => n.ticketId === card.id);
  const watchable = card.live !== null || card.runs.some((r) => r.replying);
  const tones = {
    mint: 'text-accent-2',
    lavender: 'text-accent',
    amber: 'text-amber-200',
    rose: 'text-rose-300',
    dim: 'text-dim',
  };
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={card.column !== 'done'}
      onDragStart={props.onDragStart}
      onDragEnd={props.onDragEnd}
      onClick={props.onOpen}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onOpen();
        } else if ((e.key === 'w' || e.key === 'W') && watchable) props.onWatch();
      }}
      className={`group animate-rise relative flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${props.selected ? 'border-accent/60 bg-accent/[0.07]' : needsYou ? 'border-amber-300/30 bg-black/30 hover:bg-white/[0.04]' : 'border-line bg-black/30 hover:bg-white/[0.04]'}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-dim">{card.key}</span>
        <span className="flex items-center gap-1">
          {card.bounces > 0 && (
            <span
              className="font-mono text-[11px] text-amber-200"
              title={`Sent back ${card.bounces} times`}
            >
              ↩{card.bounces}
            </span>
          )}
          <Badge tone={card.type === 'spec' ? 'lavender' : 'dim'}>{TYPE_LABELS[card.type]}</Badge>
        </span>
      </span>
      <span className="text-[13px] leading-snug text-white">{card.title}</span>
      <span className={`flex min-w-0 items-center gap-1.5 text-[12px] ${tones[status.tone]}`}>
        {colour ? (
          <Avatar colour={colour} size="xs" live={status.live} />
        ) : (
          <span className="w-3 shrink-0 text-center">{status.icon}</span>
        )}
        <span className="truncate" title={status.text}>
          {status.text}
        </span>
        {progress && (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">{progress}</span>
        )}
      </span>
      {card.live && !card.live.asking && (
        <span className="truncate font-mono text-[11px] text-white/60 group-hover:pr-14">
          <LiveLabel text={card.live.label} />
        </span>
      )}
      {(card.stories.length > 0 ||
        card.proposed ||
        card.skipped.length > 0 ||
        card.delivery?.pr) && (
        <span className="flex flex-wrap items-center gap-1">
          {card.proposed && <Badge tone="lavender">proposal</Badge>}
          {card.delivery?.pr && (
            <span className="font-mono text-[10px] text-white/70">
              PR #{card.delivery.pr.number}
              {card.delivery.pr.ci && ` · ${ciText(card.delivery.pr.ci)}`}
            </span>
          )}
          {card.skipped.map((skip) => (
            <span
              key={skip.clankId}
              className="text-[10px] text-dim"
              title={`${props.name(skip.clankId)}'s check skipped: ${skip.reason}`}
            >
              no {props.name(skip.clankId)}
            </span>
          ))}
          {card.stories.map((s) => (
            <span key={s} className="font-mono text-[10px] text-dim">
              {s}
            </span>
          ))}
        </span>
      )}
      {watchable && (
        <button
          type="button"
          title="Watch: follow this run in its workbench (W)"
          onClick={(e) => {
            e.stopPropagation();
            props.onWatch();
          }}
          className="absolute right-2 bottom-2 hidden rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-white/80 group-hover:block group-focus-visible:block hover:bg-white/10"
        >
          Watch
        </button>
      )}
    </div>
  );
}

/** A live line, with its `code` in mono as tools write them. */
function LiveLabel({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((piece, i) =>
        piece.startsWith('`') && piece.endsWith('`') ? (
          <span key={i} className="text-white/90">
            {piece.slice(1, -1)}
          </span>
        ) : (
          <span key={i}>{piece}</span>
        ),
      )}
    </>
  );
}

/**
 * One lane per clank: what it's on now, each parallel run on its own row with its live line, what
 * it has queued, and what it finished today.
 */
function ByClank(props: {
  snapshot: BoardSnapshot;
  members: ClankSummary[];
  name: (id: string) => string;
  onOpen: (id: string) => void;
  onWatch: (card: TicketCard) => void;
}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tickets = props.snapshot.tickets;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6 pb-3">
      {props.members.map((clank) => {
        const now = tickets.filter(
          (t) =>
            (t.column === 'build' || t.column === 'review') &&
            (t.detour?.clankId ?? t.route[t.step]?.clankId) === clank.id,
        );
        const queued = tickets.filter((t) => t.column === 'backlog' && t.assignee === clank.id);
        const done = tickets.filter(
          (t) =>
            t.doneAt !== null && t.doneAt >= today && t.route.some((s) => s.clankId === clank.id),
        );
        const spend = props.snapshot.clanks[clank.id];
        return (
          <section
            key={clank.id}
            aria-label={clank.name}
            className="grid grid-cols-[11rem_1fr_12rem_10rem] gap-3 rounded-2xl border border-line bg-panel/40 p-3"
          >
            <span className="flex items-start gap-2">
              <Avatar colour={clank.avatar} size="sm" live={now.some((t) => t.live)} />
              <span className="flex flex-col">
                <span className="text-[13px] font-medium">
                  {clank.name}
                  {now.length > 1 && <span className="ml-1 font-mono text-dim">×{now.length}</span>}
                </span>
                <span className="text-[11px] text-dim">{clank.role}</span>
                {spend?.reached && (
                  <span className="text-[11px] text-amber-200">Budget spent: {spend.reached}</span>
                )}
              </span>
            </span>
            <ul className="flex min-w-0 flex-col gap-1">
              {now.length === 0 && <li className="text-[12px] text-dim">Free</li>}
              {now.map((t, i) => (
                <li key={t.id} className="flex min-w-0 items-center gap-2 text-[12px]">
                  {now.length > 1 && (
                    <span className="font-mono text-[11px] text-dim">
                      {clank.name} {i + 1}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => props.onOpen(t.id)}
                    className="font-mono text-[11px] text-accent-2 hover:underline"
                  >
                    {t.key}
                  </button>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/70">
                    {t.live ? (
                      <LiveLabel text={t.live.label} />
                    ) : (
                      cardStatus(t, props.snapshot, props.name).text
                    )}
                  </span>
                  {t.live && (
                    <Button size="sm" variant="ghost" onClick={() => props.onWatch(t)}>
                      Watch
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <TicketKeys label="Queued" tickets={queued} onOpen={props.onOpen} />
            <TicketKeys label="Done today" tickets={done} onOpen={props.onOpen} />
          </section>
        );
      })}
    </div>
  );
}

function TicketKeys(props: { label: string; tickets: TicketCard[]; onOpen: (id: string) => void }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="text-[10px] tracking-[0.12em] text-dim uppercase">{props.label}</span>
      <span className="flex flex-wrap gap-1.5">
        {props.tickets.length === 0 && <span className="text-[12px] text-dim">–</span>}
        {props.tickets.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.title}
            onClick={() => props.onOpen(t.id)}
            className="font-mono text-[11px] text-white/75 hover:underline"
          >
            {t.key}
          </button>
        ))}
      </span>
    </span>
  );
}

/** A card the user adds: a title, a type, and a clank or Open. */
function AddTicket(props: {
  snapshot: BoardSnapshot;
  members: ClankSummary[];
  onDone: (id: string | null) => void;
}) {
  const trpc = useTRPC();
  const [title, setTitle] = useState('');
  const [type, setType] = useState<OutputType>('pr');
  const [assignee, setAssignee] = useState<string>('');
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const add = useMutation(trpc.board.add.mutationOptions({ onSuccess: (t) => props.onDone(t.id) }));
  const makers = props.members.filter((c) => c.outputs.includes(type));
  const types = outputTypeSchema.options.filter((t) =>
    props.members.some((c) => c.outputs.includes(t)),
  );
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-black/40 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({
          projectId: props.snapshot.project.id,
          title: title.trim(),
          type,
          description,
          criteria: criteria
            .split('\n')
            .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
            .filter(Boolean),
          stories: [],
          assignee: assignee || null,
        });
      }}
    >
      <input
        autoFocus
        aria-label="Title"
        placeholder="What needs doing"
        className={`${inputClass} h-8 text-[13px]`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && props.onDone(null)}
      />
      <span className="grid grid-cols-2 gap-2">
        <select
          aria-label="Type"
          className={`${inputClass} h-8 text-[13px]`}
          value={type}
          onChange={(e) => {
            setType(e.target.value as OutputType);
            setAssignee('');
          }}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select
          aria-label="For"
          className={`${inputClass} h-8 text-[13px]`}
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="">Open</option>
          {makers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </span>
      <textarea
        aria-label="Description"
        placeholder="Why, and what the maker needs to know (optional)"
        rows={2}
        className={`${inputClass} h-auto py-2 text-[13px]`}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <textarea
        aria-label="Acceptance criteria"
        placeholder="Acceptance criteria, one per line (optional)"
        rows={2}
        className={`${inputClass} h-auto py-2 text-[13px]`}
        value={criteria}
        onChange={(e) => setCriteria(e.target.value)}
      />
      <span className="flex gap-2">
        <Button size="sm" variant="primary" type="submit" disabled={!title.trim() || add.isPending}>
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onDone(null)}>
          Cancel
        </Button>
      </span>
      {add.error && <ErrorText>{add.error.message}</ErrorText>}
    </form>
  );
}

/** The crew's running commentary, newest at the bottom. */
function Feed(props: {
  snapshot: BoardSnapshot;
  crew: ClankSummary[];
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const events = props.snapshot.events;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, open]);
  const known = new Set(props.snapshot.tickets.map((t) => t.id));

  return (
    <section className="shrink-0 border-t border-line bg-panel/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-6 py-2 text-[11px] font-medium tracking-[0.15em] text-dim uppercase hover:text-white"
      >
        Activity
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <ol
          ref={list}
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="max-h-40 overflow-y-auto px-6 pb-3 font-mono text-[12px]"
        >
          {events.length === 0 && <li className="text-dim">Nothing has happened yet.</li>}
          {events.map((event) => {
            const linked = event.ticketId !== null && known.has(event.ticketId);
            return (
              <li key={event.id}>
                <button
                  type="button"
                  disabled={!linked}
                  onClick={() => linked && props.onOpen(event.ticketId!)}
                  className="flex w-full gap-3 rounded px-1 py-0.5 text-left enabled:hover:bg-white/[0.04]"
                >
                  <span className="shrink-0 text-dim">
                    {event.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="min-w-0 text-white/85">
                    <span className="text-white">{actorName(event.actor, props.crew)}</span>{' '}
                    <span className="text-dim">›</span> {event.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
