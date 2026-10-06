import type { BoardSnapshot } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Board } from '../components/project/Board';
import { ProjectSettings } from '../components/project/ProjectSettings';
import { SpecView } from '../components/project/SpecView';
import { Button, Dot, ErrorText, FolderIcon, IconButton } from '../components/ui';
import { useCrew } from '../lib/crew';
import { type ProjectTab, useNav } from '../lib/nav';
import { folderName } from '../lib/projects';
import { useTRPC } from '../lib/trpc';

const TABS: [ProjectTab, string][] = [
  ['board', 'Board'],
  ['spec', 'Spec'],
  ['settings', 'Settings'],
];

/** A project: its board, its spec and its settings, kept live. */
export function ProjectPage({
  id,
  tab,
  ticket,
}: {
  id: string;
  tab: ProjectTab;
  ticket: string | null;
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
      {tab === 'board' && <Board snapshot={snapshot} ticket={ticket} />}
      {tab === 'spec' && <SpecView snapshot={snapshot} />}
      {tab === 'settings' && <ProjectSettings snapshot={snapshot} />}
    </div>
  );
}

function ProjectHeader({ snapshot, tab }: { snapshot: BoardSnapshot; tab: ProjectTab }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const { project } = snapshot;
  const [chatting, setChatting] = useState(false);
  const openFolder = useMutation(trpc.projects.openFolder.mutationOptions());
  const members = crew.filter((c) => project.crew.some((m) => m.clankId === c.id));

  return (
    <header className="flex flex-col gap-3 border-b border-line px-6 pt-4 pb-3">
      <div className="flex items-start justify-between gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-baseline gap-3 text-xl font-semibold tracking-[-0.02em]">
            {project.name}
            <span className="font-mono text-xs font-normal text-dim">{project.key}</span>
          </h1>
          {project.brief && <p className="truncate text-sm text-dim">{project.brief}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[12px] text-dim">
            <Dot tone="mint" live={project.working > 0} />
            {project.working} {project.working === 1 ? 'clank' : 'clanks'} working
            {project.needsYou > 0 && (
              <>
                <span className="text-white/25">·</span>
                <span className="text-amber-200">{project.needsYou} need you</span>
              </>
            )}
          </span>
          <span
            className="ml-2 flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-0.5 pl-2.5 text-[12px] text-white/80"
            title={
              project.repo ? `${project.folder}, a clone of ${project.repo.url}` : project.folder
            }
          >
            <FolderIcon />
            <span className="max-w-40 truncate">
              {project.repo ? project.repo.fullName : folderName(project.folder)}
            </span>
            <IconButton label="Open the folder" onClick={() => openFolder.mutate(project.id)}>
              <span className="text-[13px]">↗</span>
            </IconButton>
          </span>
          <div className="relative">
            <Button size="sm" variant="primary" onClick={() => setChatting((c) => !c)}>
              Chat
            </Button>
            {chatting && (
              <ul
                className="absolute top-10 right-0 z-30 flex w-64 flex-col gap-0.5 rounded-2xl border border-line bg-panel p-1.5 shadow-2xl"
                onMouseLeave={() => setChatting(false)}
              >
                {members.map((clank) => (
                  <li key={clank.id}>
                    <button
                      type="button"
                      onClick={() =>
                        go({ page: 'draft', clankId: clank.id, projectId: project.id })
                      }
                      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left hover:bg-white/[0.06]"
                    >
                      <Avatar colour={clank.avatar} size="xs" />
                      <span className="text-sm">{clank.name}</span>
                      <span className="text-[11px] text-dim">{clank.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <nav className="flex gap-1">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => go({ page: 'project', id: project.id, tab: id })}
            className={`rounded-full px-3 py-1 text-[13px] transition-colors ${tab === id ? 'bg-white/[0.08] text-white' : 'text-dim hover:text-white'}`}
          >
            {label}
            {id === 'spec' && snapshot.specs.some((s) => s.status === 'signed_off') && (
              <span className="ml-1.5 inline-block">
                <Dot tone="amber" live />
              </span>
            )}
          </button>
        ))}
      </nav>
    </header>
  );
}
