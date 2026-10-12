import {
  type BoardSnapshot,
  type TicketCard,
  type ToolPart,
  isWrittenOutput,
  itemText,
} from '@clanks/core';
import { useQueries, useQuery } from '@tanstack/react-query';
import { TYPE_LABELS, cardStatus, namer } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { formatAgo } from '../../lib/format';
import { useNav, useOpenTicket } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { Markdown } from '../chat/Markdown';
import { Button, CheckIcon, Disclosure, Dot, ErrorText, Zoomable } from '../ui';
import { Paper, WrittenInline } from './Output';
import { Fields, TicketActions } from './TicketDrawer';

/** How much of a long document shows before it's opened, in rem: more while it waits to be read. */
const FOLD = { waiting: 26, done: 16 } as const;

/** How many pictures of one piece of work show in the conversation. The rest are a click away. */
const PICTURES_SHOWN = 6;

/**
 * A piece of the crew's work as its own message in the conversation with the lead: what was made,
 * shown in full where it can be judged, and the yes or no it's waiting for. It stays in the thread
 * once it's decided, so what was approved can always be looked at again.
 */
export function Deliverable({ card, snapshot }: { card: TicketCard; snapshot: BoardSnapshot }) {
  const crew = useCrew();
  const name = namer(crew);
  const open = useOpenTicket(snapshot.project.id);
  const waiting = card.column === 'ready';
  const maker = crew.find((c) => c.id === (card.route[0]?.clankId ?? card.createdBy));
  const draft = snapshot.specs.find((s) => s.ticketId === card.id && s.status !== 'approved');
  const rejected = card.outcome === 'rejected';
  const status = cardStatus(card, snapshot, name);
  const checkers = [...new Set(card.reviews.map((r) => name(r.clankId)))];

  return (
    <div className="animate-rise flex gap-3" {...(waiting ? { 'data-waiting': '' } : {})}>
      <Avatar colour={maker?.avatar ?? 'slate'} />
      <article
        aria-label={card.title}
        className={`flex min-w-0 flex-1 flex-col gap-3.5 rounded-3xl rounded-tl-lg border p-4 ${waiting ? 'border-amber-300/25 bg-amber-300/[0.04]' : 'border-line bg-panel/60'}`}
      >
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-[12px] text-dim">
              {maker?.name ?? 'The crew'} made this
              {checkers.length > 0 && `, and ${checkers.join(' and ')} checked it`}
            </p>
            <h3 className="text-[15px] leading-snug font-medium text-white">{card.title}</h3>
          </div>
          <span
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] ${waiting ? 'border-amber-300/30 bg-amber-300/10 text-amber-100' : rejected ? 'border-line text-dim' : 'border-accent-2/25 bg-accent-2/10 text-accent-2'}`}
          >
            {waiting ? <Dot tone="amber" live /> : !rejected && <CheckIcon />}
            {waiting ? 'Waiting for you' : rejected ? 'Turned down' : status.text}
          </span>
        </header>

        {!rejected && <Made card={card} snapshot={snapshot} draft={draft?.version ?? null} />}
        {!rejected && <Checked card={card} name={name} />}

        {waiting && (
          <div className="border-t border-amber-300/15 pt-3.5">
            <TicketActions
              compact
              card={card}
              snapshot={snapshot}
              draftVersion={draft?.version ?? null}
              onClose={() => {}}
            />
          </div>
        )}
        <footer className="flex items-center justify-between gap-3 text-[12px] text-dim">
          <button
            type="button"
            className="transition-colors hover:text-white"
            onClick={() => open(card.id)}
          >
            {TYPE_LABELS[card.type]} · {card.key} · everything about it
          </button>
          {card.doneAt && <span>{formatAgo(card.doneAt)}</span>}
        </footer>
      </article>
    </div>
  );
}

/** What the work made, by its kind, shown rather than linked to. */
function Made(props: { card: TicketCard; snapshot: BoardSnapshot; draft: number | null }) {
  const { card, snapshot } = props;
  const { go } = useNav();
  const projectId = snapshot.project.id;
  const fold = card.column === 'ready' ? FOLD.waiting : FOLD.done;
  const makerRun = card.runs.find((run) => run.role === 'maker');

  if (card.type === 'spec') {
    const version = props.draft ?? card.specVersion;
    return version === null ? null : (
      <SpecDoc projectId={projectId} version={version} fold={fold} meta={snapshot.project.name} />
    );
  }
  if (isWrittenOutput(card.type)) {
    return <WrittenInline card={card} snapshot={snapshot} fold={fold} />;
  }
  const summary =
    typeof card.output?.summary === 'string'
      ? card.output.summary
      : typeof card.output?.title === 'string'
        ? card.output.title
        : '';
  const frames = Array.isArray(card.output?.frames)
    ? card.output.frames.filter((f): f is string => typeof f === 'string')
    : [];
  return (
    <div className="flex flex-col gap-3">
      {summary && <Markdown text={summary} />}
      {card.type === 'design' ? (
        <Frames projectId={projectId} names={frames} />
      ) : (
        <PagesSeen card={card} />
      )}
      {card.output && (
        <Disclosure summary="More about what was made">
          <div className="flex flex-col gap-3">
            <Fields
              fields={card.output}
              hide={new Set(['summary', 'title', 'frames', 'file', 'criteria'])}
            />
            <span className="flex flex-wrap gap-2">
              {card.type === 'design' && (
                <Button
                  size="sm"
                  onClick={() =>
                    go({
                      page: 'project',
                      id: projectId,
                      tab: 'design',
                      ...(makerRun && !card.doneAt ? { run: makerRun.conversationId } : {}),
                    })
                  }
                >
                  Open it in Studio
                </Button>
              )}
              {card.type !== 'design' && makerRun && (
                <Button size="sm" onClick={() => go({ page: 'chat', id: makerRun.conversationId })}>
                  Watch how it was made
                </Button>
              )}
            </span>
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/** The spec as a document, to read in the conversation before approving it. */
function SpecDoc(props: { projectId: string; version: number; fold: number; meta: string }) {
  const trpc = useTRPC();
  const spec = useQuery(
    trpc.board.spec.queryOptions({ projectId: props.projectId, version: props.version }),
  );
  if (spec.error) return <ErrorText>{spec.error.message}</ErrorText>;
  if (!spec.data) return null;
  return (
    <Paper
      text={spec.data.body}
      meta={`${props.meta} · Spec v${props.version}`}
      fold={props.fold}
    />
  );
}

/** A design's frames as pictures, each opening large, so it's judged without leaving the chat. */
function Frames({ projectId, names }: { projectId: string; names: string[] }) {
  const trpc = useTRPC();
  const shown = names.slice(0, PICTURES_SHOWN);
  const pictures = useQueries({
    queries: shown.map((name) =>
      trpc.design.framePicture.queryOptions({ projectId, name }, { staleTime: 30_000 }),
    ),
  });
  const drawn = shown.flatMap((name, i) => {
    const picture = pictures[i]?.data;
    return picture ? [{ name, url: picture.url }] : [];
  });
  if (drawn.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <ul className={`grid gap-3 ${drawn.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {drawn.map((frame) => (
          <li key={frame.name}>
            <figure className="flex flex-col gap-1.5">
              <Zoomable
                src={frame.url}
                alt={frame.name}
                className="max-h-96 w-full rounded-xl border border-line bg-white/5 object-contain object-top"
              />
              <figcaption className="text-[12px] text-dim">{frame.name}</figcaption>
            </figure>
          </li>
        ))}
      </ul>
      {names.length > shown.length && (
        <p className="text-[12px] text-dim">And {names.length - shown.length} more, in Studio.</p>
      )}
    </div>
  );
}

/**
 * The pages the crew opened in the browser while making and checking the work, newest first: the
 * checker's look at it when there was one, since that's the one that was judged. Nothing shows
 * for work that was never opened in a browser.
 */
function PagesSeen({ card }: { card: TicketCard }) {
  const trpc = useTRPC();
  const crew = useCrew();
  const runs = card.runs
    .filter((run) => run.role === 'checker' || run.role === 'maker')
    .sort((a, b) => Number(b.role === 'checker') - Number(a.role === 'checker'));
  const chats = useQueries({
    queries: runs.map((run) =>
      trpc.chat.get.queryOptions(run.conversationId, { staleTime: 60_000 }),
    ),
  });
  // One run's pictures: whoever looked at it last, among those who looked at all.
  const seen = runs.flatMap((run, i) => {
    const paths = (chats[i]?.data?.messages ?? [])
      .flatMap((message) => message.parts)
      .filter(
        (part): part is ToolPart =>
          part.type === 'tool' && part.name.startsWith('browser_') && Boolean(part.image),
      )
      .map((part) => part.image!);
    const unique = [...new Set(paths)].reverse().slice(0, PICTURES_SHOWN);
    return unique.length > 0 ? [{ paths: unique, clankId: run.clankId }] : [];
  })[0];
  if (!seen) return null;
  const who = crew.find((c) => c.id === seen.clankId)?.name ?? 'the crew';
  const [first, ...rest] = seen.paths;
  return (
    <figure className="flex flex-col gap-2">
      <ChatPicture
        path={first!}
        alt={`The page as ${who} saw it`}
        className="max-h-[28rem] w-full rounded-xl border border-line object-cover object-top"
      />
      {rest.length > 0 && (
        <ul className="grid grid-cols-5 gap-2">
          {rest.map((path) => (
            <li key={path}>
              <ChatPicture
                path={path}
                alt={`An earlier look by ${who}`}
                className="aspect-video w-full rounded-lg border border-line object-cover object-top"
              />
            </li>
          ))}
        </ul>
      )}
      <figcaption className="text-[12px] text-dim">
        How it looked when {who} opened it. Click a picture to look closer.
      </figcaption>
    </figure>
  );
}

/** A picture kept with a chat, which opens large. */
function ChatPicture(props: { path: string; alt: string; className: string }) {
  const trpc = useTRPC();
  const picture = useQuery(trpc.chat.picture.queryOptions(props.path, { staleTime: Infinity }));
  if (!picture.data) return null;
  return <Zoomable src={picture.data} alt={props.alt} className={props.className} />;
}

/** What each checker found, for whoever wants to know how it was checked. */
function Checked({ card, name }: { card: TicketCard; name: (clankId: string) => string }) {
  if (card.reviews.length === 0) return null;
  return (
    <Disclosure summary="What the crew checked">
      <ul className="flex flex-col gap-3">
        {card.reviews.map((review, i) => {
          const criteria = Array.isArray(review.criteria) ? review.criteria : [];
          return (
            <li key={i} className="flex flex-col gap-1.5 text-[13px]">
              <p className="text-white/90">
                <span className="font-medium text-white">{name(review.clankId)}:</span>{' '}
                {typeof review.summary === 'string' ? review.summary : 'Passed it.'}
              </p>
              {criteria.length > 0 && (
                <ul className="flex flex-col gap-1 text-white/70">
                  {criteria.map((item, n) => (
                    <li key={n} className="flex gap-2">
                      <span className="shrink-0 text-accent-2">
                        <CheckIcon />
                      </span>
                      <span>{itemText(item)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}
