import { type BoardSnapshot, LEAD_CLANK } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useState } from 'react';
import { Board } from '../components/project/Board';
import { ContextView } from '../components/project/ContextView';
import { CrewRail } from '../components/project/Overview';
import { ProjectSettings } from '../components/project/ProjectSettings';
import { ProjectStudio } from '../components/project/ProjectStudio';
import { SpecView } from '../components/project/SpecView';
import { TicketDrawer } from '../components/project/TicketDrawer';
import { RoutinesView } from '../components/routines/RoutinesView';
import {
  Button,
  Dot,
  ErrorText,
  FolderIcon,
  Menu,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SlidersIcon,
  inputClass,
} from '../components/ui';
import { usageText } from '../lib/board';
import { useConversations, useCrew } from '../lib/crew';
import { type ProjectTab, useNav, useOpenTicket } from '../lib/nav';
import { useRoutines } from '../lib/routines';
import { useTRPC } from '../lib/trpc';
import { DraftChat, LiveChat } from './ChatPage';

/** Each view, with what it's for in a few words, shown when the pointer rests on it. */
const TABS: [ProjectTab, string, string][] = [
  ['overview', 'Overview', 'Talk to Atlas, with the crew at work beside you'],
  ['board', 'Board', 'Every piece of work and where it is'],
  ['spec', 'Spec', 'What will be made, written up for you to approve'],
  ['design', 'Studio', 'The designs, on a canvas'],
  ['routines', 'Routines', 'Work that repeats on a schedule'],
  ['context', 'Knowledge', 'What the crew knows about this project'],
  ['settings', 'Settings', 'The crew, the models, limits and the folder'],
];

/** Which of the project's chats the overview shows: a saved one, or a new one with a clank. */
export type ProjectChat = { id: string } | { draft: string };

/** A project: the conversation with its crew, its board, its spec and its settings, kept live. */
export function ProjectPage({
  id,
  tab,
  ticket = null,
  run = null,
  focus = null,
  chat = null,
}: {
  id: string;
  tab: ProjectTab;
  ticket?: string | null;
  /** A run whose design to open in Studio. */
  run?: string | null;
  /** What to bring into view on the Routines tab. */
  focus?: string | null;
  /** The chat to show on the overview. Left out, it's the latest with the lead. */
  chat?: ProjectChat | null;
}) {
  const trpc = useTRPC();
  const [live, setLive] = useState<BoardSnapshot | null>(null);
  const initial = useQuery(trpc.board.snapshot.queryOptions(id));
  useSubscription(trpc.board.live.subscriptionOptions(id, { onData: setLive }));
  const snapshot = live ?? initial.data;

  if (!snapshot) {
    return initial.error ? (
      <div className="p-10">
        <ErrorText>{initial.error.message}</ErrorText>
      </div>
    ) : null;
  }
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ProjectHeader snapshot={snapshot} tab={tab} />
      {tab === 'overview' && <Overview snapshot={snapshot} chat={chat} ticket={ticket} />}
      {tab === 'board' && <Board snapshot={snapshot} ticket={ticket} />}
      {tab === 'spec' && <SpecView snapshot={snapshot} />}
      {tab === 'design' && <ProjectStudio snapshot={snapshot} run={run} />}
      {tab === 'routines' && <RoutinesView snapshot={snapshot} focus={focus} />}
      {tab === 'context' && <ContextView snapshot={snapshot} />}
      {tab === 'settings' && <ProjectSettings snapshot={snapshot} />}
    </div>
  );
}

/**
 * The project as one conversation with the lead. What the crew needs from the user, and what it
 * finishes, shows in the thread; who's doing what stands beside it, or a ticket opened from there.
 */
function Overview(props: {
  snapshot: BoardSnapshot;
  chat: ProjectChat | null;
  ticket: string | null;
}) {
  const { snapshot } = props;
  const projectId = snapshot.project.id;
  const conversations = useConversations();
  const open = useOpenTicket(projectId);
  const { go } = useNav();
  // Until the chats arrive there's no telling whether there's one to carry on.
  if (!props.chat && !conversations) return null;
  const latest = conversations
    ?.filter((c) => c.projectId === projectId && c.role === null && c.clankId === LEAD_CLANK)
    .sort((a, b) => +b.updatedAt - +a.updatedAt)[0];
  const chat: ProjectChat = props.chat ?? (latest ? { id: latest.id } : { draft: LEAD_CLANK });
  const card = snapshot.tickets.find((t) => t.id === props.ticket);
  const inProject = {
    snapshot,
    aside: card ? (
      <TicketDrawer
        key={card.id}
        snapshot={snapshot}
        card={card}
        onClose={() => open(null)}
        onWatch={(watched) => {
          const run = watched.live ?? watched.runs.find((r) => r.replying) ?? watched.runs.at(-1);
          if (run) go({ page: 'chat', id: run.conversationId });
        }}
      />
    ) : (
      <CrewRail snapshot={snapshot} />
    ),
  };
  return (
    <div className="flex min-h-0 flex-1">
      {'id' in chat ? (
        <LiveChat key={chat.id} id={chat.id} inProject={inProject} />
      ) : (
        <DraftChat
          key={`draft:${chat.draft}`}
          clankId={chat.draft}
          projectId={projectId}
          inProject={inProject}
        />
      )}
    </div>
  );
}

function ProjectHeader({ snapshot, tab }: { snapshot: BoardSnapshot; tab: ProjectTab }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const { project } = snapshot;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const routineNeeds = useRoutines(project.id)?.needs.length ?? 0;
  const openFolder = useMutation(trpc.projects.openFolder.mutationOptions());
  const update = useMutation(
    trpc.projects.update.mutationOptions({ onSuccess: () => setRenaming(false) }),
  );
  const conversations = useConversations();
  // Who's at it this moment, by name: it's a crew, not a count. A clank answering the user in a
  // chat is at it too.
  const busy = [
    ...new Set(
      (conversations ?? [])
        .filter((c) => c.projectId === project.id && c.replying && !c.asking)
        .map((c) => c.clankId),
    ),
  ].map((clankId) => crew.find((c) => c.id === clankId)?.name ?? clankId);
  const working =
    busy.length === 0
      ? null
      : busy.length <= 2
        ? `${busy.join(' and ')} ${busy.length === 1 ? 'is' : 'are'} working`
        : `${busy.length} of the crew are working`;

  return (
    <header className="flex flex-col gap-3 border-b border-line px-6 pt-4 pb-3">
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) update.mutate({ id: project.id, patch: { name: name.trim() } });
              }}
            >
              <input
                autoFocus
                aria-label="Project name"
                className={`${inputClass} h-9 w-72`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
              />
              <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <h1 className="truncate text-xl font-semibold tracking-[-0.02em]">{project.name}</h1>
          )}
          {project.brief && !renaming && (
            <p className="truncate text-sm text-dim" title={project.brief}>
              {project.brief}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-2 text-[13px] text-dim">
            {project.needsYou > 0 ? (
              <button
                type="button"
                title="Show what's waiting, in your conversation with Atlas"
                onClick={() => {
                  if (tab !== 'overview') go({ page: 'project', id: project.id, tab: 'overview' });
                  // Once it's on screen: straight away on the overview, a moment later otherwise.
                  setTimeout(
                    () =>
                      document
                        .querySelector('[data-waiting]')
                        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
                    tab === 'overview' ? 0 : 300,
                  );
                }}
                className="flex items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-300/[0.07] px-3 py-1 text-amber-200 transition-colors hover:bg-amber-300/[0.14]"
              >
                <Dot tone="amber" live />
                {project.needsYou} waiting for you
              </button>
            ) : working ? (
              <span className="flex items-center gap-1.5 text-accent-2">
                <Dot tone="mint" live />
                {working}
              </span>
            ) : (
              !project.held && <span>All quiet</span>
            )}
          </span>
          <BudgetMeter project={project} />
          {project.held && (
            <Button
              size="sm"
              variant="primary"
              title="The crew starts nothing new until you let it carry on"
              onClick={() => update.mutate({ id: project.id, patch: { held: false } })}
            >
              <PlayIcon /> Paused. Carry on
            </Button>
          )}
          <Menu
            label="Project options"
            items={[
              !project.held && {
                label: 'Pause the crew',
                hint: 'They finish what they have going, and start nothing new.',
                icon: <PauseIcon />,
                onSelect: () => update.mutate({ id: project.id, patch: { held: true } }),
              },
              {
                label: 'Open the folder',
                hint: project.repo
                  ? `${project.folder}, a copy of ${project.repo.fullName}`
                  : project.folder,
                icon: <FolderIcon />,
                onSelect: () => openFolder.mutate(project.id),
              },
              {
                label: 'Rename',
                icon: <PencilIcon />,
                onSelect: () => {
                  setName(project.name);
                  setRenaming(true);
                },
              },
              {
                label: 'Project settings',
                icon: <SlidersIcon />,
                onSelect: () => go({ page: 'project', id: project.id, tab: 'settings' }),
              },
            ]}
          />
        </div>
      </div>
      {(update.error ?? openFolder.error) && (
        <ErrorText>{(update.error ?? openFolder.error)!.message}</ErrorText>
      )}
      <nav className="-ml-1.5 flex gap-0.5">
        {TABS.map(([id, label, hint]) => (
          <button
            key={id}
            type="button"
            title={hint}
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => go({ page: 'project', id: project.id, tab: id })}
            className={`rounded-full px-3.5 py-1.5 text-[13px] transition-colors ${tab === id ? 'bg-white/[0.09] text-white' : 'text-dim hover:bg-white/[0.04] hover:text-white'}`}
          >
            {label}
            {id === 'spec' && snapshot.specs.some((s) => s.status === 'signed_off') && (
              <span className="ml-1.5 inline-block">
                <Dot tone="amber" live />
              </span>
            )}
            {id === 'routines' && routineNeeds > 0 && (
              <span className="ml-1.5 inline-block" title={`${routineNeeds} need you`}>
                <Dot tone="amber" live />
              </span>
            )}
          </button>
        ))}
      </nav>
    </header>
  );
}

/** What the project has spent, against its budget when it has one. */
function BudgetMeter({ project }: { project: BoardSnapshot['project'] }) {
  const { spend, budget } = project;
  if (!budget) return null;
  const fractions = [
    budget.tokens !== null ? spend.usage.tokens / budget.tokens : null,
    budget.minutes !== null ? spend.usage.ms / (budget.minutes * 60_000) : null,
    budget.dollars !== null ? spend.usage.dollars / budget.dollars : null,
  ].filter((f): f is number => f !== null);
  const used = Math.min(1, Math.max(0, ...fractions));
  return (
    <span
      className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12px] ${spend.reached ? 'border-amber-300/30 text-amber-200' : 'border-line text-dim'}`}
      title={`Used so far: ${usageText(spend.usage)}`}
    >
      {spend.reached ? `Budget used up: ${spend.reached}` : `Budget ${Math.round(used * 100)}%`}
      <span className="h-1 w-14 overflow-hidden rounded-full bg-white/10">
        <span
          className={`block h-full rounded-full ${spend.reached ? 'bg-amber-300' : 'bg-accent'}`}
          style={{ width: `${Math.round(used * 100)}%` }}
        />
      </span>
    </span>
  );
}
