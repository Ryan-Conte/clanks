import type {
  BoardSnapshot,
  ContextNote,
  ContextSnapshot,
  MemoryEntry,
  NoteKind,
} from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { type ReactNode, useState } from 'react';
import { namer } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { formatAgo } from '../../lib/format';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { Badge, Button, ErrorText, IconButton, PencilIcon, TrashIcon, inputClass } from '../ui';

const KINDS: NoteKind[] = ['fact', 'decision', 'convention', 'glossary', 'link'];

/**
 * What the crew knows on this project: the notes everyone shares, the instructions you wrote, each
 * clank's own memory, and a preview of exactly what a clank is told.
 */
export function ContextView({ snapshot }: { snapshot: BoardSnapshot }) {
  const trpc = useTRPC();
  const projectId = snapshot.project.id;
  const [live, setLive] = useState<ContextSnapshot | null>(null);
  const initial = useQuery(trpc.context.get.queryOptions(projectId));
  useSubscription(trpc.context.live.subscriptionOptions(projectId, { onData: setLive }));
  const context = live ?? initial.data;
  if (!context) return initial.error ? <ErrorText>{initial.error.message}</ErrorText> : null;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-8 py-6 xl:grid-cols-2">
        <Notes projectId={projectId} notes={context.notes} snapshot={snapshot} />
        <div className="flex flex-col gap-6">
          <Instructions projectId={projectId} instructions={context.instructions} />
          <Memory snapshot={snapshot} memory={context.memory} />
        </div>
        <div className="xl:col-span-2">
          <Preview snapshot={snapshot} />
        </div>
      </div>
    </div>
  );
}

function Block(props: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-line bg-panel/60 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium tracking-tight">{props.title}</h2>
          <p className="text-[13px] text-dim">{props.description}</p>
        </div>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

function Notes({
  projectId,
  notes,
  snapshot,
}: {
  projectId: string;
  notes: ContextNote[];
  snapshot: BoardSnapshot;
}) {
  const crew = useCrew();
  const [history, setHistory] = useState(false);
  const [adding, setAdding] = useState(false);
  const live = notes.filter((n) => n.status === 'provisional' || n.status === 'active');
  const shown = history ? notes.filter((n) => !live.includes(n)) : live;
  const [cutoff] = useState(() => new Date(Date.now() - 60 * 24 * 3600_000));
  const stale = live.filter((n) => !n.pinned && (n.usedAt ?? n.createdAt) < cutoff);
  return (
    <Block
      title="Project notes"
      description="Facts, decisions, conventions, names and links the whole crew shares. They're information, never instructions. A clank's note is provisional until the ticket it came from is approved."
      actions={
        <Button size="sm" onClick={() => setAdding((a) => !a)}>
          Add a note
        </Button>
      }
    >
      <span className="flex gap-1">
        {[
          [false, `Live ${live.length}`],
          [true, `History ${notes.length - live.length}`],
        ].map(([value, label]) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={history === value}
            onClick={() => setHistory(value as boolean)}
            className={`rounded-full px-3 py-1 text-[12px] ${history === value ? 'bg-white/[0.08] text-white' : 'text-dim hover:text-white'}`}
          >
            {label as string}
          </button>
        ))}
      </span>
      {adding && <NoteForm projectId={projectId} onDone={() => setAdding(false)} />}
      {!history && stale.length > 0 && (
        <p className="text-[12px] text-dim">
          {stale.length} {stale.length === 1 ? "note hasn't" : "notes haven't"} been in a prompt for
          60 days: {stale.map((n) => n.title).join('; ')}.
        </p>
      )}
      {shown.length === 0 ? (
        <p className="text-[13px] text-dim">
          {history
            ? 'Nothing superseded or dropped yet.'
            : 'No notes yet. The crew adds them as it learns things, and so can you.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((note) => (
            <NoteItem key={note.id} note={note} name={namer(crew)} snapshot={snapshot} />
          ))}
        </ul>
      )}
    </Block>
  );
}

function NoteItem(props: {
  note: ContextNote;
  name: (id: string) => string;
  snapshot: BoardSnapshot;
}) {
  const { note } = props;
  const trpc = useTRPC();
  const [editing, setEditing] = useState(false);
  const update = useMutation(trpc.context.updateNote.mutationOptions());
  const remove = useMutation(trpc.context.deleteNote.mutationOptions());
  const ticket = props.snapshot.tickets.find((t) => t.id === note.ticketId);
  const live = note.status === 'provisional' || note.status === 'active';
  if (editing) {
    return (
      <li>
        <NoteForm projectId={note.projectId} note={note} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1.5 rounded-2xl border border-line bg-black/20 px-4 py-3">
      <span className="flex items-center gap-2">
        <Badge tone={note.kind === 'decision' ? 'lavender' : 'dim'}>{note.kind}</Badge>
        {note.status === 'provisional' && <Badge tone="amber">provisional</Badge>}
        {note.status === 'superseded' && <Badge>superseded</Badge>}
        {note.status === 'dropped' && <Badge tone="rose">dropped</Badge>}
        {note.pinned && <Badge tone="mint">pinned</Badge>}
        <span className="ml-auto text-[11px] text-dim">
          {note.author === 'user' ? 'You' : props.name(note.author)}
          {ticket ? ` · ${ticket.key}` : ''} · {formatAgo(note.createdAt)}
        </span>
      </span>
      <p className="text-[14px] text-white">{note.title}</p>
      {note.body && <p className="text-[13px] whitespace-pre-wrap text-white/80">{note.body}</p>}
      {note.why && <p className="text-[12px] text-dim">Why: {note.why}</p>}
      {live && (
        <span className="flex flex-wrap gap-1.5 pt-1">
          {note.status === 'provisional' && (
            <Button
              size="sm"
              onClick={() => update.mutate({ id: note.id, patch: { status: 'active' } })}
            >
              Keep
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: note.id, patch: { pinned: !note.pinned } })}
          >
            {note.pinned ? 'Unpin' : 'Pin'}
          </Button>
          <IconButton label="Edit" onClick={() => setEditing(true)}>
            <PencilIcon />
          </IconButton>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: note.id, patch: { status: 'dropped' } })}
          >
            Drop
          </Button>
        </span>
      )}
      {!live && (
        <span className="flex gap-1.5 pt-1">
          <IconButton label="Delete for good" onClick={() => remove.mutate(note.id)}>
            <TrashIcon />
          </IconButton>
        </span>
      )}
      {(update.error ?? remove.error) && (
        <ErrorText>{(update.error ?? remove.error)!.message}</ErrorText>
      )}
    </li>
  );
}

function NoteForm(props: { projectId: string; note?: ContextNote; onDone: () => void }) {
  const trpc = useTRPC();
  const [kind, setKind] = useState<NoteKind>(props.note?.kind ?? 'fact');
  const [title, setTitle] = useState(props.note?.title ?? '');
  const [body, setBody] = useState(props.note?.body ?? '');
  const [why, setWhy] = useState(props.note?.why ?? '');
  const [pinned, setPinned] = useState(props.note?.pinned ?? false);
  const add = useMutation(trpc.context.addNote.mutationOptions({ onSuccess: props.onDone }));
  const update = useMutation(trpc.context.updateNote.mutationOptions({ onSuccess: props.onDone }));
  const error = add.error ?? update.error;
  return (
    <form
      className="flex flex-col gap-2 rounded-2xl border border-accent/30 bg-black/30 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const values = { kind, title: title.trim(), body: body.trim(), why: why.trim(), pinned };
        if (props.note) update.mutate({ id: props.note.id, patch: values });
        else add.mutate({ projectId: props.projectId, ...values });
      }}
    >
      <span className="grid grid-cols-[8rem_1fr] gap-2">
        <select
          aria-label="Kind"
          className={`${inputClass} h-9 text-[13px]`}
          value={kind}
          onChange={(e) => setKind(e.target.value as NoteKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          autoFocus
          aria-label="The note"
          placeholder="Prices include 10% GST"
          className={`${inputClass} h-9 text-[13px]`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </span>
      <textarea
        aria-label="More detail"
        placeholder="More detail (optional)"
        rows={2}
        className={`${inputClass} h-auto py-2 text-[13px]`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <input
        aria-label="Why"
        placeholder="Why it's true, or why it was decided (optional)"
        className={`${inputClass} h-9 text-[13px]`}
        value={why}
        onChange={(e) => setWhy(e.target.value)}
      />
      <span className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] text-dim">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          Pin it: in every prompt, not only when it's relevant
        </label>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="primary" type="submit" disabled={!title.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onDone}>
            Cancel
          </Button>
        </span>
      </span>
      {error && <ErrorText>{error.message}</ErrorText>}
    </form>
  );
}

function Instructions({
  projectId,
  instructions,
}: {
  projectId: string;
  instructions: ContextSnapshot['instructions'];
}) {
  const trpc = useTRPC();
  const [text, setText] = useState<string | null>(null);
  const save = useMutation(
    trpc.context.saveInstructions.mutationOptions({ onSuccess: () => setText(null) }),
  );
  const file = instructions?.file ?? 'CLANKS.md';
  const shown = text ?? instructions?.text ?? '';
  return (
    <Block
      title={file}
      description={
        <>
          Your instructions for this project, at the root of its workspace. The top part goes to
          every clank; a section headed <code className="font-mono">## For Forge</code> goes only to
          Forge. The crew picks it up at its next run.
        </>
      }
      actions={
        text !== null ? (
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={save.isPending}
              onClick={() => save.mutate({ projectId, text: shown })}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setText(null)}>
              Undo
            </Button>
          </span>
        ) : undefined
      }
    >
      <textarea
        aria-label={file}
        spellCheck={false}
        rows={12}
        placeholder={
          '# Surf shop\n\nWe sell surfboards in Australia. Write in Australian English.\n\n## For Forge\n\nUse pnpm. Run pnpm test before you hand in.'
        }
        className={`${inputClass} h-auto py-3 font-mono text-[12.5px] leading-relaxed`}
        value={shown}
        onChange={(e) => setText(e.target.value)}
      />
      {save.error && <ErrorText>{save.error.message}</ErrorText>}
    </Block>
  );
}

function Memory({ snapshot, memory }: { snapshot: BoardSnapshot; memory: MemoryEntry[] }) {
  const crew = useCrew();
  const members = crew.filter((c) => snapshot.project.crew.some((m) => m.clankId === c.id));
  const [clankId, setClankId] = useState(members[0]?.id ?? 'atlas');
  const entries = memory.filter((m) => m.clankId === clankId);
  return (
    <Block
      title="Memory"
      description="Each clank's own record of this project: its runs, its chats and the decisions it made, with why. Only it reads its memory, and Atlas when signing off its work."
    >
      <span className="flex flex-wrap gap-1.5">
        {members.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={c.id === clankId}
            onClick={() => setClankId(c.id)}
            className={`flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[12px] ${c.id === clankId ? 'border-accent/50 bg-accent/[0.08] text-white' : 'border-line text-white/70 hover:bg-white/[0.04]'}`}
          >
            <Avatar colour={c.avatar} size="xs" />
            {c.name}
            <span className="font-mono text-[11px] text-dim">
              {memory.filter((m) => m.clankId === c.id).length}
            </span>
          </button>
        ))}
      </span>
      {entries.length === 0 ? (
        <p className="text-[13px] text-dim">Nothing yet.</p>
      ) : (
        <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
          {entries.map((entry) => (
            <MemoryItem key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Block>
  );
}

function MemoryItem({ entry }: { entry: MemoryEntry }) {
  const trpc = useTRPC();
  const [body, setBody] = useState<string | null>(null);
  const update = useMutation(
    trpc.context.updateMemory.mutationOptions({ onSuccess: () => setBody(null) }),
  );
  const remove = useMutation(trpc.context.deleteMemory.mutationOptions());
  const kind = { decision: 'Decision', note: 'Note', run_summary: 'Run', chat: 'Chat' }[entry.kind];
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-line bg-black/20 px-3 py-2 text-[13px]">
      <span className="flex items-center gap-2 text-[11px] text-dim">
        <span className="font-medium text-white/70">{kind}</span>
        {formatAgo(entry.createdAt)}
        <span className="ml-auto flex">
          <IconButton label="Edit" onClick={() => setBody(entry.body)}>
            <PencilIcon />
          </IconButton>
          <IconButton label="Delete" onClick={() => remove.mutate(entry.id)}>
            <TrashIcon />
          </IconButton>
        </span>
      </span>
      {body === null ? (
        <p className="whitespace-pre-wrap text-white/85">{entry.body}</p>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ id: entry.id, patch: { body } });
          }}
        >
          <textarea
            aria-label="Memory"
            rows={3}
            className={`${inputClass} h-auto py-2 text-[13px]`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="flex gap-2">
            <Button size="sm" type="submit" disabled={!body.trim()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBody(null)}>
              Cancel
            </Button>
          </span>
        </form>
      )}
      {(update.error ?? remove.error) && (
        <ErrorText>{(update.error ?? remove.error)!.message}</ErrorText>
      )}
    </li>
  );
}

/** Exactly what a clank is told, on a ticket or in a chat here, layer by layer. */
function Preview({ snapshot }: { snapshot: BoardSnapshot }) {
  const trpc = useTRPC();
  const crew = useCrew();
  const members = crew.filter((c) => snapshot.project.crew.some((m) => m.clankId === c.id));
  const open = snapshot.tickets.filter((t) => !t.doneAt);
  const [clankId, setClankId] = useState(members[0]?.id ?? 'atlas');
  const [ticketId, setTicketId] = useState<string>(open[0]?.id ?? '');
  const [expanded, setExpanded] = useState<string | null>(null);
  const preview = useQuery(
    trpc.context.preview.queryOptions({
      projectId: snapshot.project.id,
      clankId,
      ticketId: ticketId || null,
    }),
  );
  return (
    <Block
      title="Preview"
      description="Exactly what a clank is told, layer by layer, with token counts. For a clank on a cloud model, this is what goes to its provider."
    >
      <span className="flex flex-wrap gap-2">
        <select
          aria-label="Clank"
          className={`${inputClass} h-9 text-[13px]`}
          value={clankId}
          onChange={(e) => setClankId(e.target.value)}
        >
          {members.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          aria-label="On"
          className={`${inputClass} h-9 min-w-64 text-[13px]`}
          value={ticketId}
          onChange={(e) => setTicketId(e.target.value)}
        >
          <option value="">In a chat in this project</option>
          {open.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key} {t.title}
            </option>
          ))}
        </select>
        {preview.data && (
          <span className="self-center font-mono text-[12px] text-dim">
            about {preview.data.tokens.toLocaleString('en')} tokens in all
          </span>
        )}
      </span>
      {preview.error && <ErrorText>{preview.error.message}</ErrorText>}
      <ul className="flex flex-col gap-1.5">
        {preview.data?.layers.map((layer) => (
          <li key={layer.id} className="rounded-xl border border-line bg-black/20">
            <button
              type="button"
              aria-expanded={expanded === layer.id}
              onClick={() => setExpanded((e) => (e === layer.id ? null : layer.id))}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px]"
            >
              <span className="flex-1">{layer.title}</span>
              {layer.truncated && <Badge tone="amber">cut to fit</Badge>}
              <span className="font-mono text-[11px] text-dim">
                {layer.tokens.toLocaleString('en')}
                {layer.budget !== null ? ` / ${layer.budget.toLocaleString('en')}` : ''} tokens
              </span>
              <span
                className={`text-dim transition-transform ${expanded === layer.id ? 'rotate-90' : ''}`}
              >
                ›
              </span>
            </button>
            {expanded === layer.id && (
              <pre className="max-h-96 overflow-auto border-t border-line px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-white/80">
                {layer.text}
              </pre>
            )}
          </li>
        ))}
      </ul>
      {preview.data?.layers.some(
        (l) => l.truncated && (l.id === 'instructions' || l.id === 'context'),
      ) && (
        <p className="text-[12px] text-amber-200/90">
          Some of your instructions or pinned notes don't fit this clank's model, so they were cut.
          Shorten them, or give the clank a model with a bigger context.
        </p>
      )}
    </Block>
  );
}
