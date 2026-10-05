import { useMutation } from '@tanstack/react-query';
import { type PointerEvent as ReactPointerEvent, useState } from 'react';
import { useClank } from '../../lib/crew';
import { useTRPC } from '../../lib/trpc';
import { type WorkbenchTab, useWorkbench } from '../../lib/workbench';
import { Button, ErrorText, FolderIcon, IconButton, XIcon } from '../ui';
import { ActivityPane } from './ActivityPane';
import { DiffPane } from './DiffPane';
import { TerminalPane } from './TerminalPane';

const MIN_WIDTH = 420;
const TABS: [WorkbenchTab, string][] = [
  ['diff', 'Diff'],
  ['terminal', 'Terminal'],
  ['activity', 'Activity'],
];

/** Beside the chat: what the clank is changing, running and doing, as it happens. */
export function Workbench({ clankId }: { clankId: string }) {
  const trpc = useTRPC();
  const { state, conversationId, setOpen, focus } = useWorkbench();
  const clank = useClank(clankId);
  const [tab, setTab] = useState<WorkbenchTab>('diff');
  const [visited, setVisited] = useState<Set<WorkbenchTab>>(new Set(['diff']));
  const [width, setWidth] = useState(() =>
    Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.42)),
  );
  const setupGit = useMutation(trpc.workspace.setupGit.mutationOptions());
  const openFolder = useMutation(trpc.workspace.openFolder.mutationOptions());

  const choose = (next: WorkbenchTab) => {
    setTab(next);
    setVisited((v) => new Set(v).add(next));
  };
  // A tool card or the activity timeline can ask for a tab.
  const [seenFocus, setSeenFocus] = useState(0);
  if (focus && focus.nonce !== seenFocus) {
    setSeenFocus(focus.nonce);
    if (focus.tab) choose(focus.tab);
  }

  const drag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (e: PointerEvent) =>
      setWidth(
        Math.min(window.innerWidth - 560, Math.max(MIN_WIDTH, startWidth + startX - e.clientX)),
      );
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const run = state?.run ?? null;
  const name = clank?.name ?? 'The clank';
  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-line bg-panel/40"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the workbench"
        onPointerDown={drag}
        className="absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/20"
      />
      <header className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <nav className="flex gap-0.5" aria-label="Workbench">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => choose(id)}
              className={`rounded-lg px-3 py-1 text-[13px] transition-colors ${tab === id ? 'bg-white/[0.08] text-white' : 'text-dim hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <span className="min-w-0 flex-1" />
        {run && (
          <span
            className="max-w-56 truncate rounded-full border border-line px-2.5 py-0.5 font-mono text-[11px] text-dim"
            title={`${name} works on ${run.branch}, made from ${run.baseCommit.slice(0, 7)}, in ${run.worktree}. Your own checkout isn't touched; merge the branch when you're happy.`}
          >
            {run.branch}
          </span>
        )}
        {run && conversationId && (
          <IconButton
            label="Open the clank's copy in your file manager"
            onClick={() => openFolder.mutate(conversationId)}
          >
            <FolderIcon />
          </IconButton>
        )}
        <IconButton label="Close the workbench" onClick={() => setOpen(false)}>
          <XIcon />
        </IconButton>
      </header>
      {!state ? null : state.status !== 'ready' ? (
        <div className="flex flex-col gap-3 p-6 text-sm">
          <p className="text-white/85">{statusText(state.status, state.folder, name)}</p>
          {state.error && <ErrorText>{state.error}</ErrorText>}
          {(state.status === 'not_repo' || state.status === 'no_commits') && conversationId && (
            <div>
              <Button
                size="sm"
                variant="primary"
                disabled={setupGit.isPending}
                onClick={() => setupGit.mutate(conversationId)}
              >
                {state.status === 'not_repo' ? 'Set up git here' : 'Commit everything'}
              </Button>
            </div>
          )}
          {setupGit.error && <ErrorText>{setupGit.error.message}</ErrorText>}
        </div>
      ) : !run ? (
        <p className="p-6 text-sm text-dim">Making {name}'s copy of the folder…</p>
      ) : (
        <div className="relative min-h-0 flex-1">
          {visited.has('diff') && (
            <div className={tab === 'diff' ? 'absolute inset-0' : 'hidden'}>
              <DiffPane clankId={clankId} width={width} />
            </div>
          )}
          {visited.has('terminal') && (
            <div className={tab === 'terminal' ? 'absolute inset-0' : 'hidden'}>
              <TerminalPane />
            </div>
          )}
          {visited.has('activity') && (
            <div className={tab === 'activity' ? 'absolute inset-0' : 'hidden'}>
              <ActivityPane />
            </div>
          )}
        </div>
      )}
      {openFolder.error && (
        <div className="border-t border-line px-3 py-2">
          <ErrorText>{openFolder.error.message}</ErrorText>
        </div>
      )}
    </aside>
  );
}

function statusText(status: string, folder: string | null, name: string): string {
  const where = folder?.split(/[\\/]/).filter(Boolean).pop() ?? 'This folder';
  switch (status) {
    case 'not_repo':
      return `${where} isn't a git repository. ${name} works on its own branch of one, so your files stay as they are until you merge. Setting up git commits everything that's there now.`;
    case 'no_commits':
      return `${where} has no commits yet, so there's nothing for ${name} to branch from. Commit what's there to start.`;
    case 'no_git':
      return `git isn't installed. ${name} needs it to work on a copy of ${where}: install git, then come back.`;
    case 'error':
      return `${name} can't work on ${where} right now.`;
    default:
      return '';
  }
}
