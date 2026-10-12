import {
  type Artifact,
  type BoardSnapshot,
  type CampaignPost,
  type DocumentExport,
  type TicketCard,
  emailOf,
  isTextArtifact,
  isWrittenOutput,
  keepLineBreaks,
  outputDocument,
  parseAddress,
  postLength,
  postLimit,
  postsOf,
  shotsOf,
  sourcesOf,
} from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TYPE_LABELS, namer } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { formatAgo, formatBytes } from '../../lib/format';
import { useTRPC } from '../../lib/trpc';
import { CopyButton, Markdown } from '../chat/Markdown';
import { CampaignSchedule } from '../routines/CampaignSchedule';
import { Badge, Button, ErrorText, IconButton, XIcon, Zoomable, inputClass } from '../ui';

const EXPORT_LABELS: Record<DocumentExport, string> = {
  md: 'Markdown',
  docx: 'Word',
  pdf: 'PDF',
  html: 'HTML',
};

function useArtifacts(card: TicketCard): Artifact[] {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const changed = +card.updatedAt;
  // The ticket changes whenever something is handed in or saved with it.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.artifacts.forTicket.queryKey(card.id) });
  }, [queryClient, trpc, card.id, changed]);
  return useQuery(trpc.artifacts.forTicket.queryOptions(card.id)).data ?? [];
}

/**
 * What was handed in on a ticket whose work is words: a card that says what it is, opens it to
 * read in full, exports it and lists what else is kept with the ticket.
 */
export function WrittenOutput({ card, snapshot }: { card: TicketCard; snapshot: BoardSnapshot }) {
  const [reading, setReading] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const output = card.output;
  const artifacts = useArtifacts(card);
  if (!output || !isWrittenOutput(card.type)) return null;
  const document = outputDocument(output);
  const warnings = Array.isArray(output.warnings)
    ? output.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  const email = emailOf(output);
  const posts = postsOf(output);
  const sources = sourcesOf(output);
  const words = document ? document.text.split(/\s+/).filter(Boolean).length : 0;
  const main = document ? artifacts.filter((a) => a.name === document.name) : [];
  const others = artifacts.filter((a) => !document || a.name !== document.name);
  const facts = [
    email
      ? `To ${email.to.length > 0 ? email.to.join(', ') : 'nobody yet'}`
      : `${words.toLocaleString('en')} words`,
    posts.length > 0 ? `${posts.length} ${posts.length === 1 ? 'post' : 'posts'}` : '',
    sources.length > 0 ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}` : '',
    main.length > 1 ? `version ${main[0]!.version}` : '',
    typeof output.path === 'string' ? `in the project at ${output.path}` : '',
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => setReading(true)}
        className="flex flex-col gap-1.5 rounded-2xl border border-line bg-black/20 p-3.5 text-left transition-colors hover:border-accent/40 hover:bg-accent/[0.04]"
      >
        <span className="flex items-center gap-2">
          <Badge tone="lavender">{TYPE_LABELS[card.type]}</Badge>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-white">
            {email ? email.subject : (document?.title ?? card.title)}
          </span>
          <span className="shrink-0 text-[12px] text-accent">Read ›</span>
        </span>
        <span className="line-clamp-3 text-[13px] leading-snug text-white/65">
          {preview(email ? email.body : (document?.text ?? ''))}
        </span>
        <span className="text-[11px] text-dim">{facts.join(' · ')}</span>
      </button>
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl border border-amber-300/20 bg-amber-300/[0.04] px-3 py-2 text-[12px] text-amber-100/90">
          {warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
      {card.sent?.at && (
        <p className="text-[12px] text-accent-2">
          Sent {formatAgo(new Date(card.sent.at))} from {card.sent.from} to{' '}
          {card.sent.to.join(', ')}.
        </p>
      )}
      <ExportButtons card={card} />
      {card.type === 'campaign' && posts.length > 0 && card.outcome === 'approved' && (
        <span className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => setScheduling(true)}>
            Schedule the posts
          </Button>
          <span className="text-[12px] text-dim">
            Each post with a time and an account goes out then, once you've approved it as shown.
          </span>
        </span>
      )}
      {scheduling && <CampaignSchedule card={card} onClose={() => setScheduling(false)} />}
      {others.length > 0 && <Files artifacts={others} />}
      {reading && (
        <Reader card={card} snapshot={snapshot} versions={main} onClose={() => setReading(false)} />
      )}
    </div>
  );
}

/**
 * A document as a page, the way its PDF prints, shown where it's being read. A long one is folded
 * to `fold` rem with a way to open it in place, so a conversation isn't all one document.
 */
export function Paper(props: { text: string; meta?: string; fold: number }) {
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const { text, fold } = props;
  // Whether there's more than the fold shows is known once it's drawn.
  useLayoutEffect(() => {
    const el = page.current;
    if (el) setTall(el.scrollHeight > fold * 16 + 48);
  }, [text, fold]);
  const words = text.split(/\s+/).filter(Boolean).length;
  return (
    <div className="paper relative overflow-hidden rounded-xl shadow-lg shadow-black/40">
      <div
        ref={page}
        className="overflow-hidden px-8 py-7"
        style={open || !tall ? undefined : { maxHeight: `${fold}rem` }}
      >
        {props.meta && <p className="mb-4 text-[11px] text-[#6a6a75]">{props.meta}</p>}
        <Markdown text={text} />
      </div>
      {tall && (
        <div
          className={`flex justify-center pb-4 ${open ? 'pt-1' : 'absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white to-transparent pt-16'}`}
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="rounded-full border border-[#d0d0d8] bg-white px-4 py-1.5 text-[13px] font-medium text-[#16161a] shadow-sm transition-colors hover:bg-[#f1f1f5]"
          >
            {open ? 'Fold it away' : `Read all of it (${words.toLocaleString('en')} words)`}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A written hand-in in full, right where it's shown: the document as a page, an email with who
 * it goes to, a research note with its sources and the pages they were read from, a campaign with
 * its posts. Nothing has to be opened somewhere else to judge it.
 */
export function WrittenInline(props: {
  card: TicketCard;
  snapshot: BoardSnapshot;
  /** How much of a long document shows before it's opened, in rem. */
  fold: number;
}) {
  const { card, snapshot } = props;
  const [scheduling, setScheduling] = useState(false);
  const artifacts = useArtifacts(card);
  const output = card.output;
  if (!output || !isWrittenOutput(card.type)) return null;
  const document = outputDocument(output);
  const warnings = Array.isArray(output.warnings)
    ? output.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  const email = emailOf(output);
  const posts = postsOf(output);
  const others = artifacts.filter((a) => !document || a.name !== document.name);
  const text = document?.text ?? '';

  return (
    <div className="flex flex-col gap-3">
      {email ? (
        <EmailView card={card} />
      ) : (
        text && (
          <Paper
            text={card.type === 'copy' ? keepLineBreaks(text) : text}
            meta={`${snapshot.project.name} · ${card.key}`}
            fold={props.fold}
          />
        )
      )}
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-xl border border-amber-300/20 bg-amber-300/[0.04] px-3 py-2 text-[12px] text-amber-100/90">
          {warnings.map((warning, i) => (
            <li key={i}>{warning}</li>
          ))}
        </ul>
      )}
      {card.type === 'research' && <Sources card={card} />}
      {card.type === 'campaign' && <Posts posts={posts} projectId={snapshot.project.id} />}
      {card.sent?.at && email === null && (
        <p className="text-[12px] text-accent-2">
          Sent {formatAgo(new Date(card.sent.at))} from {card.sent.from} to{' '}
          {card.sent.to.join(', ')}.
        </p>
      )}
      {!email && text && <ExportButtons card={card} />}
      {card.type === 'campaign' && posts.length > 0 && card.outcome === 'approved' && (
        <span className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => setScheduling(true)}>
            Schedule the posts
          </Button>
          <span className="text-[12px] text-dim">
            Each post with a time and an account goes out then, once you've approved it as shown.
          </span>
        </span>
      )}
      {scheduling && <CampaignSchedule card={card} onClose={() => setScheduling(false)} />}
      {others.length > 0 && <Files artifacts={others} />}
    </div>
  );
}

/** The first lines of a piece of writing, without its Markdown marks. */
function preview(text: string): string {
  return text
    .replace(/^#{1,6}\s+.*$/m, '')
    .replace(/[*_`>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

function ExportButtons({ card, version }: { card: TicketCard; version?: string | undefined }) {
  const trpc = useTRPC();
  const [saved, setSaved] = useState<string | null>(null);
  const save = useMutation(
    trpc.artifacts.export.mutationOptions({ onSuccess: (path) => setSaved(path) }),
  );
  const formats: DocumentExport[] = card.type === 'email' ? ['md', 'pdf'] : ['docx', 'pdf', 'md'];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-dim">Save as</span>
        {formats.map((format) => (
          <Button
            key={format}
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ ticketId: card.id, format, ...(version ? { version } : {}) })
            }
          >
            {card.type === 'email' && format === 'md' ? 'Text' : EXPORT_LABELS[format]}
          </Button>
        ))}
      </span>
      {saved && !save.isPending && (
        <p className="truncate font-mono text-[11px] text-accent-2" title={saved}>
          Saved to {saved}
        </p>
      )}
      {save.error && <ErrorText>{save.error.message}</ErrorText>}
    </div>
  );
}

/** Notes, files and pictures kept with the ticket, besides what was handed in. */
function Files({ artifacts }: { artifacts: Artifact[] }) {
  const trpc = useTRPC();
  const crew = useCrew();
  const name = namer(crew);
  const [open, setOpen] = useState<Artifact | null>(null);
  const save = useMutation(trpc.artifacts.save.mutationOptions());
  const names = [...new Set(artifacts.map((a) => a.name))];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-dim">Kept with the ticket</span>
      <ul className="flex flex-col">
        {names.map((n) => {
          const versions = artifacts.filter((a) => a.name === n);
          const newest = versions[0]!;
          return (
            <li key={n} className="flex items-center gap-2 py-0.5 text-[12px]">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-mono text-white/85 hover:text-accent"
                onClick={() => setOpen(newest)}
              >
                {n}
              </button>
              <span className="shrink-0 text-dim">
                {newest.author === 'user' ? 'you' : name(newest.author)} ·{' '}
                {formatBytes(newest.size)}
                {versions.length > 1 ? ` · v${newest.version}` : ''}
              </span>
              <Button size="sm" variant="ghost" onClick={() => save.mutate(newest.id)}>
                Save
              </Button>
            </li>
          );
        })}
      </ul>
      {save.error && <ErrorText>{save.error.message}</ErrorText>}
      {open && <FileReader artifact={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FileReader({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const trpc = useTRPC();
  const text = useQuery(
    trpc.artifacts.text.queryOptions(artifact.id, { enabled: isTextArtifact(artifact) }),
  );
  const picture = useQuery(
    trpc.artifacts.picture.queryOptions(artifact.id, {
      enabled: artifact.mediaType.startsWith('image/'),
      staleTime: Infinity,
    }),
  );
  return (
    <Overlay title={artifact.name} onClose={onClose}>
      {picture.data && (
        <img
          src={picture.data}
          alt={artifact.name}
          className="w-full rounded-xl border border-line"
        />
      )}
      {text.data !== undefined &&
        (artifact.mediaType === 'text/markdown' ? (
          <Markdown text={text.data} />
        ) : (
          <pre className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-white/85">
            {text.data}
          </pre>
        ))}
      {(text.error ?? picture.error) && (
        <ErrorText>{(text.error ?? picture.error)!.message}</ErrorText>
      )}
    </Overlay>
  );
}

/** A panel over the window, wide enough to read a document in. */
function Overlay(props: {
  title: string;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-6 pt-14 backdrop-blur-sm"
      role="dialog"
      aria-label={props.title}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="flex w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-line bg-panel shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-6 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</h2>
          {props.actions}
          <IconButton label="Close" onClick={onClose}>
            <XIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-10 py-8">
          <div className="mx-auto flex max-w-2xl flex-col gap-6">{props.children}</div>
        </div>
      </div>
    </div>
  );
}

/** A hand-in in full: the document, an email with its headers, a note with its sources, a campaign. */
function Reader(props: {
  card: TicketCard;
  snapshot: BoardSnapshot;
  versions: Artifact[];
  onClose: () => void;
}) {
  const { card, versions } = props;
  const trpc = useTRPC();
  const output = card.output!;
  const document = outputDocument(output);
  // Null reads what's on the ticket now; an id reads an earlier version as it was kept.
  const [version, setVersion] = useState<string | null>(null);
  const earlier = useQuery(
    trpc.artifacts.text.queryOptions(version ?? '', { enabled: version !== null }),
  );
  const shown = versions.find((a) => a.id === version);
  const email = emailOf(output);
  const posts = postsOf(output);
  const field = (name: string) => {
    const value = output[name];
    return typeof value === 'string' ? value : '';
  };
  const body =
    card.type === 'research'
      ? field('note')
      : card.type === 'campaign'
        ? field('plan')
        : field('body') || field('summary');

  return (
    <Overlay
      title={`${card.key} · ${email ? email.subject : (document?.title ?? card.title)}`}
      onClose={props.onClose}
      actions={
        <>
          {versions.length > 1 && (
            <select
              aria-label="Version"
              className={`${inputClass} h-8 text-[12px]`}
              value={version ?? ''}
              onChange={(e) => setVersion(e.target.value || null)}
            >
              <option value="">Version {versions[0]!.version}, the latest</option>
              {versions.slice(1).map((a) => (
                <option key={a.id} value={a.id}>
                  Version {a.version}, {formatAgo(a.createdAt)}
                </option>
              ))}
            </select>
          )}
          {document && <CopyButton text={document.text} label="Copy" />}
        </>
      }
    >
      {shown ? (
        <>
          <p className="text-[12px] text-dim">
            Version {shown.version}, as {shown.author === 'user' ? 'you' : shown.author} left it{' '}
            {formatAgo(shown.createdAt)}.
          </p>
          {earlier.data !== undefined &&
            (shown.mediaType === 'text/markdown' ? (
              <Markdown text={card.type === 'copy' ? keepLineBreaks(earlier.data) : earlier.data} />
            ) : (
              <pre className="text-[14px] leading-relaxed whitespace-pre-wrap text-white/90">
                {earlier.data}
              </pre>
            ))}
          <ExportButtons card={card} version={shown.id} />
        </>
      ) : email ? (
        <EmailView card={card} />
      ) : (
        <>
          <article className="text-[15px] leading-relaxed">
            <Markdown text={card.type === 'copy' ? keepLineBreaks(body) : body} />
          </article>
          {card.type === 'research' && <Sources card={card} />}
          {card.type === 'campaign' && (
            <Posts posts={posts} projectId={props.snapshot.project.id} />
          )}
          <ExportButtons card={card} />
        </>
      )}
    </Overlay>
  );
}

/** An email as it will go out, which the user can change while it waits for them. */
function EmailView({ card }: { card: TicketCard }) {
  const trpc = useTRPC();
  const email = emailOf(card.output)!;
  const editable = card.column === 'ready';
  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState(email.to.join(', '));
  const [cc, setCc] = useState(email.cc.join(', '));
  const [subject, setSubject] = useState(email.subject);
  const [body, setBody] = useState(email.body);
  const save = useMutation(
    trpc.board.editOutput.mutationOptions({ onSuccess: () => setEditing(false) }),
  );
  const split = (text: string) =>
    text
      .split(/[,;\n]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  const bad = [...split(to), ...split(cc)].filter((address) => !parseAddress(address));

  if (editing) {
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ id: card.id, patch: { to: split(to), cc: split(cc), subject, body } });
        }}
      >
        <Labelled label="To">
          <input
            aria-label="To"
            autoFocus
            placeholder="name@example.com, another@example.com"
            className={inputClass}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Labelled>
        <Labelled label="Cc">
          <input
            aria-label="Cc"
            className={inputClass}
            value={cc}
            onChange={(e) => setCc(e.target.value)}
          />
        </Labelled>
        <Labelled label="Subject">
          <input
            aria-label="Subject"
            className={inputClass}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Labelled>
        <textarea
          aria-label="The email"
          rows={14}
          className={`${inputClass} h-auto py-3 leading-relaxed`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        {bad.length > 0 && (
          <ErrorText>
            {bad.join(', ')} {bad.length === 1 ? "isn't an address" : "aren't addresses"}.
          </ErrorText>
        )}
        <span className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={save.isPending || bad.length > 0 || !subject.trim() || !body.trim()}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </span>
        {save.error && <ErrorText>{save.error.message}</ErrorText>}
      </form>
    );
  }
  return (
    <>
      <dl className="flex flex-col gap-1.5 rounded-2xl border border-line bg-black/20 p-4 text-[13px]">
        <Header label="To">
          {email.to.length > 0 ? (
            email.to.join(', ')
          ) : (
            <span className="text-amber-200">Nobody yet: add who it goes to</span>
          )}
        </Header>
        {email.cc.length > 0 && <Header label="Cc">{email.cc.join(', ')}</Header>}
        <Header label="Subject">
          <span className="font-medium text-white">{email.subject}</span>
        </Header>
      </dl>
      <pre className="font-sans text-[15px] leading-relaxed whitespace-pre-wrap text-white/90">
        {email.body}
      </pre>
      <span className="flex flex-wrap items-center gap-2">
        {editable && (
          <Button size="sm" onClick={() => setEditing(true)}>
            Change it
          </Button>
        )}
        <ExportButtons card={card} />
      </span>
      {card.sent?.at ? (
        <p className="text-[12px] text-accent-2">
          Sent {formatAgo(new Date(card.sent.at))} from {card.sent.from}.
        </p>
      ) : (
        <p className="text-[12px] text-dim">
          Not sent. It goes out from your own account when you approve it, exactly as it is here.
        </p>
      )}
    </>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[4.5rem_1fr] items-center gap-3 text-[13px] text-dim">
      {label}
      {children}
    </label>
  );
}

function Header({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-3">
      <dt className="text-dim">{label}</dt>
      <dd className="min-w-0 break-words text-white/85">{children}</dd>
    </div>
  );
}

/** A research note's sources, each with the picture kept of its page when there is one. */
function Sources({ card }: { card: TicketCard }) {
  const sources = sourcesOf(card.output);
  const shots = shotsOf(card.output);
  if (sources.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">
        Sources as Scout saw them
      </h3>
      <ol className="flex flex-col gap-3">
        {sources.map((source) => {
          const shot = shots.find((s) => s.source === source.n);
          return (
            <li
              key={source.n}
              className="flex flex-col gap-2 rounded-2xl border border-line bg-black/20 p-3.5"
            >
              <p className="text-[13px] text-white/85">
                <span className="mr-2 font-mono text-[12px] text-accent">[{source.n}]</span>
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-words hover:underline"
                  >
                    {source.text}
                  </a>
                ) : (
                  source.text
                )}
              </p>
              {shot ? (
                <ShotPicture artifact={shot.artifact} alt={`Source ${source.n}`} />
              ) : (
                <p className="text-[11px] text-dim">
                  No picture kept: it wasn't opened in the browser.
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ShotPicture({ artifact, alt }: { artifact: string; alt: string }) {
  const trpc = useTRPC();
  const picture = useQuery(trpc.artifacts.picture.queryOptions(artifact, { staleTime: Infinity }));
  if (!picture.data) return null;
  return (
    <Zoomable
      src={picture.data}
      alt={alt}
      className="max-h-72 w-full rounded-lg border border-line object-cover object-top"
    />
  );
}

/** A campaign's posts as cards: where and when, the text against its limit, and its picture. */
function Posts({ posts, projectId }: { posts: CampaignPost[]; projectId: string }) {
  if (posts.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">
        Posts, for you to approve
      </h3>
      <ol className="grid gap-3 sm:grid-cols-2">
        {posts.map((post, i) => {
          const limit = postLimit(post.channel);
          const length = postLength(post);
          return (
            <li
              key={i}
              className="flex flex-col gap-2.5 rounded-2xl border border-line bg-black/20 p-4"
            >
              <span className="flex flex-wrap items-center gap-2 text-[12px]">
                <Badge tone="lavender">{post.channel}</Badge>
                {post.account && <span className="font-mono text-white/75">{post.account}</span>}
                {post.at && <span className="text-dim">{post.at}</span>}
              </span>
              {post.visual && <Visual name={post.visual} projectId={projectId} />}
              <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-white/90">
                {post.text}
              </p>
              <span className="flex items-center justify-between gap-2">
                <span
                  className={`font-mono text-[11px] ${limit !== null && length > limit ? 'text-amber-200' : 'text-dim'}`}
                >
                  {length}
                  {limit !== null ? ` / ${limit}` : ''} characters
                </span>
                <CopyButton text={post.text} />
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-[12px] text-dim">
        Nothing here is posted by approving the campaign, which accepts the plan and the drafts.
        Once it's approved, Schedule the posts sends the ones you pick at their times.
      </p>
    </section>
  );
}

/** A post's picture: Prism's frame of that name when the project has one, else what it should show. */
function Visual({ name, projectId }: { name: string; projectId: string }) {
  const trpc = useTRPC();
  // A description is longer than any frame's name, and isn't worth looking up.
  const frame = useQuery(
    trpc.design.framePicture.queryOptions(
      { projectId, name },
      { enabled: name.length <= 80, staleTime: 30_000 },
    ),
  );
  if (frame.data) {
    return (
      <figure className="flex flex-col gap-1">
        <img
          src={frame.data.url}
          alt={name}
          className="max-h-64 w-full rounded-xl border border-line bg-white/5 object-contain"
        />
        <figcaption className="font-mono text-[11px] text-dim">{name}</figcaption>
      </figure>
    );
  }
  return (
    <p className="rounded-xl border border-dashed border-line px-3 py-2 text-[12px] text-dim">
      Visual: {name}
    </p>
  );
}
