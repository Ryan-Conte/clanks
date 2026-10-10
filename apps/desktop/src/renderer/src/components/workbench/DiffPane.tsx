import type { ChangedFile, ReviewNote } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useClank } from '../../lib/crew';
import { useTRPC } from '../../lib/trpc';
import { useWorkbench } from '../../lib/workbench';
import { Button, ErrorText, IconButton, XIcon, inputClass } from '../ui';
import { hunkLines } from '../../lib/hunks';
import { type DiffHandle, MonacoDiff } from './MonacoDiff';

type View = { kind: 'all' } | { kind: 'step' | 'upTo'; checkpointId: string };

/** Every change the clank made, live: pick a file, a step, a change; reject, comment, edit. */
export function DiffPane({ clankId, width }: { clankId: string; width: number }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { state, conversationId, replying, focus } = useWorkbench();
  const clank = useClank(clankId);
  const checkpoints = useMemo(
    () => (state?.checkpoints ?? []).filter((c) => !c.rewound),
    [state?.checkpoints],
  );
  const base = checkpoints[0];
  const latest = checkpoints.at(-1);
  const [view, setView] = useState<View>({ kind: 'all' });
  const [follow, setFollow] = useState(true);
  const [path, setPath] = useState<string | null>(null);
  const [layout, setLayout] = useState<'auto' | 'split' | 'inline'>('auto');
  const [activeHunk, setActiveHunk] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<{ kind: 'reject' | 'comment'; text: string } | null>(null);
  const [confirmRewind, setConfirmRewind] = useState(false);
  const editor = useRef<DiffHandle | null>(null);

  const viewed = view.kind === 'all' ? null : checkpoints.find((c) => c.id === view.checkpointId);
  const { from, to } = useMemo(() => {
    if (!base) return { from: null, to: null };
    if (!viewed || view.kind === 'all') return { from: base.id, to: 'live' as const };
    const index = checkpoints.indexOf(viewed);
    if (view.kind === 'upTo') return { from: base.id, to: viewed.id };
    return { from: checkpoints[index - 1]?.id ?? base.id, to: viewed.id };
  }, [base, viewed, view.kind, checkpoints]);
  const live = to === 'live';

  // The activity timeline and tool cards can point the diff at a step. Nonces start at 1, so a
  // request made before the pane opened is still followed.
  const [seenFocus, setSeenFocus] = useState(0);
  if (focus && focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce);
    if (focus.checkpointId) {
      setView({ kind: focus.diff ?? 'step', checkpointId: focus.checkpointId });
      setFollow(false);
      const found = state?.checkpoints.find((c) => c.id === focus.checkpointId);
      if (found?.files[0]) setPath(found.files[0].path);
    }
  }

  // Following: each change the clank makes is shown as it lands.
  const [seenLatest, setSeenLatest] = useState(latest?.id ?? null);
  if (latest && latest.id !== seenLatest) {
    setSeenLatest(latest.id);
    if (follow && latest.author === 'clank') {
      setView({ kind: 'all' });
      if (latest.files[0] && !dirty) setPath(latest.files[0].path);
    }
  }

  // Every new checkpoint or note may change what the diff shows.
  const version = `${state?.checkpoints.length ?? 0}:${latest?.id ?? ''}:${state?.notes.length ?? 0}`;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: trpc.workspace.files.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.workspace.file.queryKey() });
  }, [version, queryClient, trpc]);

  const files = useQuery(
    trpc.workspace.files.queryOptions(
      { conversationId: conversationId!, from: from!, to: to! },
      { enabled: conversationId !== null && from !== null && to !== null },
    ),
  );
  const list = files.data ?? [];
  const selected = list.find((f) => f.path === path) ?? list[0] ?? null;
  const file = useQuery(
    trpc.workspace.file.queryOptions(
      {
        conversationId: conversationId!,
        path: selected?.path ?? '',
        oldPath: selected?.oldPath ?? null,
        from: from!,
        to: to!,
      },
      { enabled: selected !== null && conversationId !== null && from !== null },
    ),
  );
  const hunks = live ? (file.data?.hunks ?? []) : [];
  const hunk = hunks[Math.min(activeHunk, hunks.length - 1)];

  // Another file or comparison starts at its first change, with nothing half-written.
  const shownKey = `${selected?.path ?? ''}|${from}|${to}`;
  const [seenShown, setSeenShown] = useState(shownKey);
  if (shownKey !== seenShown) {
    setSeenShown(shownKey);
    setActiveHunk(0);
    setForm(null);
  }

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.workspace.file.queryKey() });
  const reject = useMutation(
    trpc.workspace.rejectHunk.mutationOptions({ onSuccess: () => setForm(null) }),
  );
  const comment = useMutation(
    trpc.workspace.comment.mutationOptions({ onSuccess: () => setForm(null) }),
  );
  const save = useMutation(trpc.workspace.saveFile.mutationOptions({ onSuccess: refresh }));
  const rewind = useMutation(
    trpc.workspace.rewind.mutationOptions({
      onSuccess: () => {
        setConfirmRewind(false);
        setView({ kind: 'all' });
        setFollow(true);
      },
    }),
  );
  const error = [reject, comment, save, rewind].find((m) => m.error)?.error;

  if (!state?.run || !base || !conversationId) return null;
  const sideBySide = layout === 'auto' ? width >= 820 : layout === 'split';
  const compact = width < 720;
  const editable =
    live &&
    file.data !== undefined &&
    !file.data.binary &&
    !file.data.tooLarge &&
    file.data.modified !== null;
  const stepIndex = viewed ? checkpoints.indexOf(viewed) : checkpoints.length;
  const go = (index: number) => {
    setFollow(false);
    if (index >= checkpoints.length) setView({ kind: 'all' });
    else
      setView({
        kind: view.kind === 'upTo' ? 'upTo' : 'step',
        checkpointId: checkpoints[Math.max(1, index)]!.id,
      });
  };

  const submitForm = () => {
    if (!form || !selected || !file.data) return;
    if (form.kind === 'reject' && hunk && file.data.hash) {
      reject.mutate({
        conversationId,
        path: selected.path,
        from: from!,
        hunk,
        hash: file.data.hash,
        comment: form.text.trim(),
      });
    } else if (form.kind === 'comment') {
      const lines = editor.current?.selection() ?? (hunk ? hunkLines(hunk) : { start: 1, end: 1 });
      comment.mutate({
        conversationId,
        path: selected.path,
        startLine: lines.start,
        endLine: lines.end,
        body: form.text.trim(),
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <IconButton
          label="Earlier step"
          disabled={stepIndex <= 1}
          onClick={() => go(stepIndex - 1)}
        >
          ‹
        </IconButton>
        <select
          aria-label="Which changes to show"
          className={`${inputClass} h-8 min-w-[11rem] flex-1 text-[13px]`}
          value={view.kind === 'all' ? 'all' : view.checkpointId}
          onChange={(e) => {
            setFollow(false);
            setView(
              e.target.value === 'all'
                ? { kind: 'all' }
                : { kind: view.kind === 'upTo' ? 'upTo' : 'step', checkpointId: e.target.value },
            );
          }}
        >
          <option value="all">All changes, as they are now</option>
          {checkpoints.slice(1).map((c) => (
            <option key={c.id} value={c.id}>
              {`Step ${c.seq} · ${c.label.replace(/`/g, '')}`}
            </option>
          ))}
        </select>
        <IconButton
          label="Later step"
          disabled={view.kind === 'all'}
          onClick={() => go(stepIndex + 1)}
        >
          ›
        </IconButton>
        {view.kind !== 'all' && (
          <Segmented
            value={view.kind}
            options={[
              ['step', 'This step'],
              ['upTo', 'Up to here'],
            ]}
            onChange={(kind) =>
              setView({
                kind: kind as 'step' | 'upTo',
                checkpointId: (view as { checkpointId: string }).checkpointId,
              })
            }
          />
        )}
        <Segmented
          value={layout}
          options={[
            ['auto', 'Auto'],
            ['split', 'Split'],
            ['inline', 'Inline'],
          ]}
          onChange={(v) => setLayout(v as typeof layout)}
        />
        <label
          className="flex items-center gap-1.5 pl-1 text-[12px] text-dim"
          title="Show each change as it lands"
        >
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
      </div>

      {viewed && (
        <div className="flex items-center justify-between gap-3 border-b border-line bg-white/[0.02] px-3 py-1.5 text-[12px]">
          <span className="min-w-0 truncate text-dim">
            {view.kind === 'step' ? 'What this step changed' : 'Everything up to this step'} ·{' '}
            {viewed.createdAt.toLocaleTimeString()}
          </span>
          {confirmRewind ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="text-amber-200">
                Files go back to here, and the chat after it is removed.
              </span>
              <Button
                size="sm"
                variant="danger"
                disabled={rewind.isPending}
                onClick={() => rewind.mutate({ conversationId, checkpointId: viewed.id })}
              >
                Rewind
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRewind(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={replying || viewed.id === latest?.id}
              title={replying ? `Wait for ${clank?.name ?? 'the clank'} to finish` : undefined}
              onClick={() => setConfirmRewind(true)}
            >
              Rewind to here
            </Button>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {!compact && (
          <FileList
            files={list}
            selected={selected?.path ?? null}
            onSelect={(p) => setPath(p)}
            loading={files.isLoading}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {selected && file.data && (
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px]">
              {compact && list.length > 1 ? (
                // A narrow workbench has no room for the file list beside the diff.
                <select
                  aria-label="Changed file"
                  className="h-7 min-w-0 flex-1 truncate rounded-lg border border-line bg-black/30 px-2 font-mono text-[12px] text-white/85 focus:outline-none"
                  value={selected.path}
                  onChange={(e) => setPath(e.target.value)}
                >
                  {list.map((f) => (
                    <option key={f.path} value={f.path}>
                      {`${f.path}  +${f.added} −${f.removed}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="min-w-0 flex-1 truncate font-mono text-white/80">
                  {selected.path}
                </span>
              )}
              {dirty ? (
                <>
                  <span className="text-amber-200">Unsaved</span>
                  <Button
                    size="sm"
                    onClick={() =>
                      editor.current &&
                      save.mutate({
                        conversationId,
                        path: selected.path,
                        content: editor.current.value(),
                        hash: file.data.hash,
                      })
                    }
                  >
                    Save
                  </Button>
                </>
              ) : (
                live &&
                hunks.length > 0 && (
                  <>
                    <IconButton
                      label="Previous change"
                      disabled={activeHunk === 0}
                      onClick={() => {
                        setActiveHunk(activeHunk - 1);
                        editor.current?.reveal(hunkLines(hunks[activeHunk - 1]!).start);
                      }}
                    >
                      ‹
                    </IconButton>
                    <span className="whitespace-nowrap text-dim">
                      {compact ? '' : 'Change '}
                      {Math.min(activeHunk, hunks.length - 1) + 1}
                      {compact ? '/' : ' of '}
                      {hunks.length}
                    </span>
                    <IconButton
                      label="Next change"
                      disabled={activeHunk >= hunks.length - 1}
                      onClick={() => {
                        setActiveHunk(activeHunk + 1);
                        editor.current?.reveal(hunkLines(hunks[activeHunk + 1]!).start);
                      }}
                    >
                      ›
                    </IconButton>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setForm({ kind: 'reject', text: '' })}
                    >
                      Reject…
                    </Button>
                  </>
                )
              )}
              {live && !dirty && file.data.modified !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setForm({ kind: 'comment', text: '' })}
                  title="On the selected lines, or the picked change"
                >
                  Comment…
                </Button>
              )}
            </div>
          )}
          {form && (
            <form
              className="flex items-center gap-2 border-b border-line bg-white/[0.03] px-3 py-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitForm();
              }}
            >
              <input
                autoFocus
                aria-label={form.kind === 'reject' ? 'Why reject it (optional)' : 'Comment'}
                placeholder={
                  form.kind === 'reject'
                    ? `Why? ${clank?.name ?? 'The clank'} gets this. Optional.`
                    : `A note for ${clank?.name ?? 'the clank'} on these lines`
                }
                className={`${inputClass} h-8 flex-1`}
                value={form.text}
                onChange={(e) => setForm({ ...form, text: e.target.value })}
                onKeyDown={(e) => e.key === 'Escape' && setForm(null)}
              />
              <Button
                size="sm"
                type="submit"
                variant={form.kind === 'reject' ? 'danger' : 'secondary'}
                disabled={
                  (form.kind === 'comment' && !form.text.trim()) ||
                  reject.isPending ||
                  comment.isPending
                }
              >
                {form.kind === 'reject' ? 'Reject change' : 'Add note'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </form>
          )}
          {error && (
            <div className="border-b border-line px-3 py-1.5">
              <ErrorText>{error.message}</ErrorText>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {!selected ? (
              <Empty>
                {files.isLoading
                  ? 'Looking for changes…'
                  : view.kind === 'all'
                    ? `No changes yet. ${clank?.name ?? 'The clank'}'s edits show up here as it makes them.`
                    : 'This step changed no files.'}
              </Empty>
            ) : file.error ? (
              <Empty>{file.error.message}</Empty>
            ) : !file.data ? null : file.data.binary ? (
              <Empty>A binary file. It changed, but it can't be shown here.</Empty>
            ) : file.data.tooLarge ? (
              <Empty>Too big to show here.</Empty>
            ) : (
              <MonacoDiff
                path={selected.path}
                original={file.data.original ?? ''}
                modified={file.data.modified ?? ''}
                sideBySide={sideBySide}
                editable={editable}
                hunks={hunks}
                activeHunk={hunks.length ? Math.min(activeHunk, hunks.length - 1) : null}
                onSelectHunk={setActiveHunk}
                onDirty={setDirty}
                onSave={(content) =>
                  save.mutate({
                    conversationId,
                    path: selected.path,
                    content,
                    hash: file.data.hash,
                  })
                }
                handle={editor}
              />
            )}
          </div>
        </div>
      </div>
      <ReviewTray
        name={clank?.name ?? 'the clank'}
        notes={state.notes.filter((n) => n.status === 'pending')}
      />
    </div>
  );
}

function FileList(props: {
  files: ChangedFile[];
  selected: string | null;
  loading: boolean;
  onSelect: (path: string) => void;
}) {
  if (props.files.length === 0) return null;
  const tones: Record<ChangedFile['status'], string> = {
    added: 'text-accent-2',
    modified: 'text-accent',
    deleted: 'text-rose-300',
    renamed: 'text-amber-200',
  };
  return (
    <ul
      className="w-52 shrink-0 overflow-y-auto border-r border-line py-1"
      aria-label="Changed files"
    >
      {props.files.map((f) => {
        const name = f.path.split('/').pop()!;
        const dir = f.path.slice(0, f.path.length - name.length);
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => props.onSelect(f.path)}
              title={f.path}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] ${f.path === props.selected ? 'bg-white/[0.07] text-white' : 'text-white/75 hover:bg-white/[0.04]'}`}
            >
              <span className={`w-2.5 shrink-0 font-mono text-[11px] ${tones[f.status]}`}>
                {f.status[0]!.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="text-dim">{dir}</span>
                {name}
              </span>
              {!f.binary && (
                <span className="shrink-0 font-mono text-[10px]">
                  <span className="text-accent-2">+{f.added}</span>{' '}
                  <span className="text-rose-300">−{f.removed}</span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Notes for the clank that haven't gone to it yet, and the button that sends them. */
export function ReviewTray({ notes, name }: { notes: ReviewNote[]; name: string }) {
  const trpc = useTRPC();
  const { conversationId, replying } = useWorkbench();
  const remove = useMutation(trpc.workspace.deleteNote.mutationOptions());
  const send = useMutation(trpc.chat.sendReview.mutationOptions());
  if (notes.length === 0 || !conversationId) return null;
  const kinds = {
    reject: 'Rejected',
    comment: 'Comment',
    edit: 'You edited',
    design: 'You edited',
    pin: 'Comment',
  };
  return (
    <div className="flex max-h-56 shrink-0 flex-col border-t border-line bg-panel/80">
      <ul className="min-h-0 overflow-y-auto px-3 pt-2">
        {notes.map((note) => (
          <li key={note.id} className="flex items-start gap-2 py-1 text-[12px]">
            <span className="shrink-0 font-medium text-white/85">{kinds[note.kind]}</span>
            <span className="min-w-0 flex-1 text-dim">
              <span className="font-mono">
                {note.anchor?.kind === 'pin' ? note.anchor.name : note.path}
                {note.startLine !== null
                  ? `:${note.startLine}${note.endLine && note.endLine !== note.startLine ? `–${note.endLine}` : ''}`
                  : ''}
              </span>
              {note.anchor?.kind === 'edits' ? (
                <span className="text-white/75">
                  {' '}
                  · {Object.keys(note.anchor.lines).length}{' '}
                  {Object.keys(note.anchor.lines).length === 1 ? 'change' : 'changes'} in Studio
                </span>
              ) : note.body && note.kind !== 'edit' ? (
                <span className="text-white/75"> · {note.body}</span>
              ) : null}
            </span>
            <IconButton
              label="Remove note"
              className="size-5"
              onClick={() => remove.mutate({ conversationId, id: note.id })}
            >
              <XIcon />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="text-[12px] text-dim">
          {replying
            ? `${name} gets these after its next step.`
            : `These go with your next message, or send them now.`}
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={replying || send.isPending}
          onClick={() => send.mutate(conversationId)}
        >
          Send to {name}
        </Button>
      </div>
      {send.error && (
        <div className="px-3 pb-2">
          <ErrorText>{send.error.message}</ErrorText>
        </div>
      )}
    </div>
  );
}

function Segmented(props: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <span className="flex rounded-full border border-line bg-black/20 p-0.5">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={props.value === value}
          onClick={() => props.onChange(value)}
          className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${props.value === value ? 'bg-white/10 text-white' : 'text-dim hover:text-white'}`}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="p-6 text-sm text-dim">{children}</p>;
}
