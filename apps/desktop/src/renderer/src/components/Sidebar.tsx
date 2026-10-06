import type { ConversationSummary, ProjectSummary } from '@clanks/core';
import type { ReactNode } from 'react';
import { useConversations, useCrew } from '../lib/crew';
import { formatAgo } from '../lib/format';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { useProjects } from '../lib/projects';
import { Avatar } from './Avatar';
import { ChipIcon, Dot, Eyebrow, IconButton, Logo, PlusIcon, SlidersIcon } from './ui';

/** Projects, the crew and recent chats, as on clanks.si; models and settings at the foot. */
export function Sidebar() {
  const { route, go } = useNav();
  const crew = useCrew();
  const conversations = useConversations();
  const projects = useProjects();
  const snapshot = useModels();
  const working = snapshot?.runtime.loaded.some((l) => l.inUse > 0) ?? false;
  const loaded = (snapshot?.runtime.loaded.length ?? 0) > 0;
  const pulling = snapshot?.pulls.some((p) => p.state === 'downloading' || p.state === 'verifying');
  // The project the window is in, so its chats show under it.
  const here =
    route.page === 'project'
      ? route.id
      : route.page === 'draft'
        ? route.projectId
        : route.page === 'chat'
          ? conversations?.find((c) => c.id === route.id)?.projectId
          : null;
  const chats = conversations?.filter((c) => c.projectId === null) ?? null;

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-line bg-panel/50">
      <div className="flex items-center justify-between px-5 pt-4 pb-5">
        <span className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[17px] font-semibold tracking-tight">clanks</span>
        </span>
        <IconButton label="New chat" onClick={() => go({ page: 'home' })}>
          <PlusIcon />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div className="flex items-center justify-between pr-1">
          <Eyebrow>Projects</Eyebrow>
          <button
            type="button"
            onClick={() => go({ page: 'new-project' })}
            className="pb-2 text-[11px] text-dim transition-colors hover:text-white"
          >
            New
          </button>
        </div>
        {projects?.length === 0 && (
          <p className="px-2 pb-4 text-sm text-dim">
            No projects yet.{' '}
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => go({ page: 'new-project' })}
            >
              Start one
            </button>
          </p>
        )}
        <ul data-testid="projects" className="flex flex-col gap-0.5 pb-4">
          {projects?.map((project) => (
            <li key={project.id}>
              <ProjectRow
                project={project}
                active={route.page === 'project' && route.id === project.id}
                onClick={() => go({ page: 'project', id: project.id, tab: 'board' })}
              />
              {here === project.id && (
                <ProjectChats
                  project={project}
                  chats={
                    conversations?.filter((c) => c.projectId === project.id && c.role === null) ??
                    []
                  }
                />
              )}
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between pr-1">
          <Eyebrow>Crew</Eyebrow>
          <button
            type="button"
            onClick={() => go({ page: 'crew', clankId: null })}
            className="pb-2 text-[11px] text-dim transition-colors hover:text-white"
          >
            Profiles
          </button>
        </div>
        <ul data-testid="crew" className="flex flex-col gap-0.5 pb-4">
          {crew.map((clank) => {
            const active = route.page === 'draft' && !route.projectId && route.clankId === clank.id;
            return (
              <li key={clank.id}>
                <button
                  type="button"
                  onClick={() => go({ page: 'draft', clankId: clank.id })}
                  title={`Chat with ${clank.name}`}
                  className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left transition-colors ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}
                >
                  <Avatar colour={clank.avatar} />
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm text-white">{clank.name}</span>
                    <span className="truncate text-[11px] text-dim">{clank.role}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <Eyebrow>Chats</Eyebrow>
        {chats?.length === 0 && (
          <p className="px-2 text-sm text-dim">Nothing yet. Pick a clank to start.</p>
        )}
        <ul className="flex flex-col gap-0.5">
          {chats?.map((conversation) => (
            <li key={conversation.id}>
              <ChatRow conversation={conversation} />
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1 border-t border-line p-3">
        <NavItem
          active={route.page === 'models'}
          onClick={() => go({ page: 'models' })}
          icon={<ChipIcon />}
        >
          Models
          {(loaded || pulling) && (
            <span className="ml-auto">
              <Dot tone={pulling ? 'lavender' : 'mint'} live={working || pulling} />
            </span>
          )}
        </NavItem>
        <NavItem
          active={route.page === 'settings'}
          onClick={() => go({ page: 'settings' })}
          icon={<SlidersIcon />}
        >
          Settings
        </NavItem>
      </div>
    </nav>
  );
}

function ProjectRow(props: { project: ProjectSummary; active: boolean; onClick: () => void }) {
  const { project } = props;
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={project.brief || project.name}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors ${props.active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.04] font-mono text-[10px] text-white/80">
        {project.key.slice(0, 2)}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-white">{project.name}</span>
      {project.needsYou > 0 ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[10px] text-amber-200"
          title={`${project.needsYou} waiting on you`}
        >
          <Dot tone="amber" live />
          {project.needsYou}
        </span>
      ) : project.working > 0 ? (
        <span title={`${project.working} working`}>
          <Dot tone="mint" live />
        </span>
      ) : null}
    </button>
  );
}

/** A project's own chats, under it while the window is in it. */
function ProjectChats({
  project,
  chats,
}: {
  project: ProjectSummary;
  chats: ConversationSummary[];
}) {
  const { route, go } = useNav();
  const drafting = route.page === 'draft' && route.projectId === project.id;
  return (
    <ul className="ml-4 flex flex-col gap-0.5 border-l border-line py-1 pl-2">
      {chats.map((conversation) => (
        <li key={conversation.id}>
          <ChatRow conversation={conversation} />
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={() => go({ page: 'draft', clankId: 'atlas', projectId: project.id })}
          className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] transition-colors ${drafting ? 'bg-white/[0.07] text-white' : 'text-dim hover:bg-white/[0.04] hover:text-white'}`}
        >
          <PlusIcon /> Chat in {project.name}
        </button>
      </li>
    </ul>
  );
}

function ChatRow({ conversation }: { conversation: ConversationSummary }) {
  const { route, go } = useNav();
  const crew = useCrew();
  const active = route.page === 'chat' && route.id === conversation.id;
  const colour = crew.find((c) => c.id === conversation.clankId)?.avatar ?? 'slate';
  return (
    <button
      type="button"
      onClick={() => go({ page: 'chat', id: conversation.id })}
      title={conversation.title}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors ${active ? 'bg-white/[0.07] text-white' : 'text-white/75 hover:bg-white/[0.04] hover:text-white'}`}
    >
      <Avatar colour={colour} size="xs" live={conversation.replying} />
      <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
      {conversation.asking ? (
        <span
          className="flex shrink-0 items-center gap-1 text-[10px] text-amber-200"
          title="Waiting for your approval"
        >
          <Dot tone="amber" live />
          needs you
        </span>
      ) : (
        <span className="shrink-0 font-mono text-[10px] text-dim">
          {formatAgo(conversation.updatedAt)}
        </span>
      )}
    </button>
  );
}

function NavItem(props: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={props.active ? 'page' : undefined}
      onClick={props.onClick}
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${props.active ? 'border-line bg-white/[0.06] text-white' : 'border-transparent text-dim hover:bg-white/[0.04] hover:text-white'}`}
    >
      {props.icon}
      {props.children}
    </button>
  );
}
