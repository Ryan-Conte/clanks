import type { ConversationSummary, ProjectSummary } from '@clanks/core';
import type { ReactNode } from 'react';
import { useConversations, useCrew } from '../lib/crew';
import { formatAgo } from '../lib/format';
import { useMarketplace } from '../lib/integrations';
import { useModels, useSetup } from '../lib/models';
import { useNav } from '../lib/nav';
import { useProjects } from '../lib/projects';
import { Avatar } from './Avatar';
import {
  ChipIcon,
  Dot,
  Eyebrow,
  HomeIcon,
  Logo,
  PlusIcon,
  ProgressBar,
  ShelfIcon,
  SlidersIcon,
} from './ui';

/** A new project, Home, the projects, the crew and recent chats; the rest at the foot. */
export function Sidebar() {
  const { route, go } = useNav();
  const crew = useCrew();
  const conversations = useConversations();
  const projects = useProjects();
  const snapshot = useModels();
  const setup = useSetup();
  const packages = useMarketplace()?.installed ?? [];
  // An update to look at, or something its marketplace took down.
  const packageNews = packages.some((p) => p.status !== 'active');
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
          ? (conversations?.find((c) => c.id === route.id)?.projectId ?? route.projectId)
          : null;
  /** The user's own chats, and a clank's answers to another's questions asked outside a ticket. */
  const listed = (c: ConversationSummary) =>
    c.role === null || (c.role === 'consult' && c.ticketId === null);
  const chats = conversations?.filter((c) => c.projectId === null && listed(c)) ?? null;
  // Everything waiting on the user, wherever it is.
  const needsYou =
    (projects?.reduce((sum, p) => sum + p.needsYou, 0) ?? 0) +
    (chats?.filter((c) => c.asking).length ?? 0);
  // Who's writing a reply right now, in a chat or on a ticket.
  const busy = new Set(conversations?.filter((c) => c.replying).map((c) => c.clankId));

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-line bg-panel/50">
      <div className="flex items-center gap-2.5 px-5 pt-4 pb-4">
        <Logo />
        <span className="text-[17px] font-semibold tracking-tight">clanks</span>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => {
            go({ page: 'home' });
            // Already there: put the cursor where the idea goes.
            requestAnimationFrame(() => document.getElementById('idea')?.focus());
          }}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-white text-sm font-medium text-black transition-colors hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <PlusIcon /> New project
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4">
        <NavItem
          active={route.page === 'home'}
          onClick={() => go({ page: 'home' })}
          icon={<HomeIcon />}
        >
          Home
          {needsYou > 0 && (
            <span
              className="tabular ml-auto rounded-full bg-amber-300/15 px-2 py-0.5 text-[11px] font-medium text-amber-200"
              title={`${needsYou} waiting on you`}
            >
              {needsYou}
            </span>
          )}
        </NavItem>

        <section>
          <Eyebrow>Projects</Eyebrow>
          {projects?.length === 0 && (
            <p className="px-2 text-[13px] leading-relaxed text-dim">
              Nothing yet. Tell the crew what you want on Home.
            </p>
          )}
          <ul data-testid="projects" className="flex flex-col gap-0.5">
            {projects?.map((project) => (
              <li key={project.id}>
                <ProjectRow
                  project={project}
                  active={here === project.id}
                  onClick={() => go({ page: 'project', id: project.id, tab: 'overview' })}
                />
                {here === project.id && (
                  <ProjectChats
                    project={project}
                    chats={
                      conversations?.filter((c) => c.projectId === project.id && listed(c)) ?? []
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <div className="flex items-center justify-between pr-1">
            <Eyebrow>Crew</Eyebrow>
            <button
              type="button"
              onClick={() => go({ page: 'crew', clankId: null })}
              className="pb-2 text-[11px] text-dim transition-colors hover:text-white"
            >
              Manage
            </button>
          </div>
          {/* The crew as a handful of faces: who's there, and who's busy. A click starts a chat. */}
          <ul data-testid="crew" className="grid grid-cols-4 gap-y-2">
            {crew.map((clank) => {
              const active =
                route.page === 'draft' && !route.projectId && route.clankId === clank.id;
              return (
                <li key={clank.id}>
                  <button
                    type="button"
                    onClick={() => go({ page: 'draft', clankId: clank.id })}
                    title={`${clank.name}, ${clank.role}. ${clank.summary} Click to chat.`}
                    className={`flex w-full flex-col items-center gap-1 rounded-xl px-1 py-1.5 transition-colors ${active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}
                  >
                    <Avatar colour={clank.avatar} live={busy.has(clank.id)} />
                    <span className="w-full truncate text-center text-[11px] text-white/80">
                      {clank.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {chats && chats.length > 0 && (
          <section>
            <Eyebrow>Chats</Eyebrow>
            <ul className="flex flex-col gap-0.5">
              {chats.map((conversation) => (
                <li key={conversation.id}>
                  <ChatRow conversation={conversation} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="flex flex-col gap-0.5 border-t border-line p-3">
        {setup && (
          <button
            type="button"
            onClick={() => go({ page: 'setup' })}
            className="mb-1.5 flex flex-col gap-1.5 rounded-xl border border-accent/25 bg-accent/[0.07] px-3 py-2.5 text-left transition-colors hover:bg-accent/[0.12]"
          >
            <span className="flex items-center justify-between text-[12px]">
              <span className="text-white">Getting the crew ready</span>
              <span className="tabular text-dim">{Math.round(setup.progress * 100)}%</span>
            </span>
            <ProgressBar value={setup.progress} />
          </button>
        )}
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
          active={route.page === 'marketplace'}
          onClick={() => go({ page: 'marketplace' })}
          icon={<ShelfIcon />}
        >
          Marketplace
          {packageNews && (
            <span className="ml-auto">
              <Dot tone={packages.some((p) => p.status === 'revoked') ? 'rose' : 'lavender'} />
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
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${props.active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}
    >
      <span
        className={`size-2 shrink-0 rounded-full ${project.needsYou > 0 ? 'animate-pulse-dot bg-amber-300' : project.working > 0 ? 'animate-pulse-dot bg-accent-2' : 'bg-white/20'}`}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-white">{project.name}</span>
      {project.needsYou > 0 ? (
        <span
          className="tabular shrink-0 text-[11px] text-amber-200"
          title={`${project.needsYou} waiting on you`}
        >
          {project.needsYou} for you
        </span>
      ) : project.working > 0 ? (
        <span className="shrink-0 text-[11px] text-accent-2" title={`${project.working} working`}>
          working
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
  // One chat is the project's conversation, and needs no list. More than one, or a new one
  // being written, and they're listed to move between.
  if (chats.length < 2 && !drafting) return null;
  return (
    <ul className="ml-3.5 flex flex-col gap-0.5 border-l border-line py-1 pl-2">
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
          <PlusIcon /> New chat
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
      onClick={() => go({ page: 'chat', id: conversation.id, projectId: conversation.projectId })}
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
        <span className="tabular shrink-0 text-[10px] text-dim">
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
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors ${props.active ? 'bg-white/[0.07] text-white' : 'text-dim hover:bg-white/[0.04] hover:text-white'}`}
    >
      {props.icon}
      {props.children}
    </button>
  );
}
