import { useMutation } from '@tanstack/react-query';
import { type PointerEvent as ReactPointerEvent, useState } from 'react';
import { useClank } from '../../lib/crew';
import { useTRPC } from '../../lib/trpc';
import { type WorkbenchTab, useWorkbench } from '../../lib/workbench';
import { Button, Dot, ErrorText, FolderIcon, IconButton, XIcon } from '../ui';
import { ActivityPane } from './ActivityPane';
import { BrowserPane } from './BrowserPane';
import { DiffPane } from './DiffPane';
import { Studio } from '../studio/Studio';
import { TerminalPane } from './TerminalPane';

const MIN_WIDTH = 420;
const TABS: [WorkbenchTab, string][] = [
  ['diff', 'Diff'],
  ['terminal', 'Terminal'],
  ['browser', 'Browser'],
  ['studio', 'Studio'],
  ['activity', 'Activity'],
];
/** Tabs that show the chat's files, which need a folder. */
const FILE_TABS = new Set<WorkbenchTab>(['diff', 'terminal', 'studio']);

/**
 * Beside the chat: what the clank is changing, running, browsing and doing, as it happens. The
 * diff and terminal need a folder; the browser and the activity work in any chat.
 */
export function Workbench({
  clankId,
  folder,
  role,
}: {
  clankId: string;
  folder: boolean;
  /** What the clank does in a run. A checker's copy of a design is only to look at. */
  role: string | null;
}) {
  const trpc = useTRPC();
  const { state, browser, conversationId, replying, setOpen, focus } = useWorkbench();
  const clank = useClank(clankId);
  const designer = clank?.outputs.includes('design') ?? false;
  const tabs = TABS.filter(
    ([id]) => (folder || !FILE_TABS.has(id)) && (id !== 'browser' || browser?.available),
  );
  // A designer's work is on the canvas; everyone else's is in the diff.
  const first: WorkbenchTab = folder ? (designer ? 'studio' : 'diff') : 'browser';
  const [chosen, setTab] = useState<WorkbenchTab>(first);
  const [visited, setVisited] = useState<Set<WorkbenchTab>>(new Set([first]));
  // A tab that went away, such as Diff when the folder is cleared, falls back to the first.
  const tab = tabs.some(([id]) => id === chosen) ? chosen : (tabs[0]?.[0] ?? 'activity');
  const seen = new Set([...visited, tab]);
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
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => choose(id)}
              className={`rounded-lg px-3 py-1 text-[13px] transition-colors ${tab === id ? 'bg-white/[0.08] text-white' : 'text-dim hover:text-white'}`}
            >
              {label}
              {id === 'browser' && (browser?.busy || browser?.control === 'user') && (
                <span className="ml-1.5 inline-block align-middle">
                  <Dot tone={browser.control === 'user' ? 'amber' : 'mint'} live />
                </span>
              )}
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
      <div className="relative min-h-0 flex-1">
        {FILE_TABS.has(tab) && folder && !run && state && (
          <div className="absolute inset-0 overflow-y-auto">
            {state.status !== 'ready' ? (
              <div className="flex flex-col gap-3 p-6 text-sm">
                <p className="text-white/85">{statusText(state.status, state.folder, name)}</p>
                {state.error && <ErrorText>{state.error}</ErrorText>}
                {(state.status === 'not_repo' || state.status === 'no_commits') &&
                  conversationId && (
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
            ) : (
              <p className="p-6 text-sm text-dim">Making {name}'s copy of the folder…</p>
            )}
          </div>
        )}
        {run && seen.has('diff') && (
          <div className={tab === 'diff' ? 'absolute inset-0' : 'hidden'}>
            <DiffPane clankId={clankId} width={width} />
          </div>
        )}
        {run && seen.has('terminal') && (
          <div className={tab === 'terminal' ? 'absolute inset-0' : 'hidden'}>
            <TerminalPane />
          </div>
        )}
        {seen.has('browser') && tabs.some(([id]) => id === 'browser') && (
          <div className={tab === 'browser' ? 'absolute inset-0' : 'hidden'}>
            <BrowserPane clankId={clankId} />
          </div>
        )}
        {run && conversationId && seen.has('studio') && (
          <div className={tab === 'studio' ? 'absolute inset-0' : 'hidden'}>
            <Studio
              source={{ conversationId }}
              editable={role === null || role === 'maker'}
              compact
              run={{
                conversationId,
                clankName: name,
                replying,
                notes: state?.notes ?? [],
                checkpoints: state?.checkpoints ?? [],
              }}
            />
          </div>
        )}
        {seen.has('activity') && (
          <div className={tab === 'activity' ? 'absolute inset-0' : 'hidden'}>
            <ActivityPane />
          </div>
        )}
      </div>
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
