import type { ReactNode } from 'react';
import { useConversations, useCrew } from '../lib/crew';
import { formatAgo } from '../lib/format';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { Avatar } from './Avatar';
import { ChipIcon, Dot, Eyebrow, IconButton, Logo, PlusIcon, SlidersIcon } from './ui';

/** Projects, the crew and recent chats, as on clanks.si; models and settings at the foot. */
export function Sidebar() {
  const { route, go } = useNav();
  const crew = useCrew();
  const conversations = useConversations();
  const snapshot = useModels();
  const working = snapshot?.runtime.loaded.some((l) => l.inUse > 0) ?? false;
  const loaded = (snapshot?.runtime.loaded.length ?? 0) > 0;
  const pulling = snapshot?.pulls.some((p) => p.state === 'downloading' || p.state === 'verifying');
  const colourOf = (clankId: string) => crew.find((c) => c.id === clankId)?.avatar ?? 'slate';

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
        <Eyebrow>Projects</Eyebrow>
        <p className="px-2 pb-4 text-sm text-dim">No projects yet.</p>

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
            const active = route.page === 'draft' && route.clankId === clank.id;
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
        {conversations?.length === 0 && (
          <p className="px-2 text-sm text-dim">Nothing yet. Pick a clank to start.</p>
        )}
        <ul className="flex flex-col gap-0.5">
          {conversations?.map((conversation) => {
            const active = route.page === 'chat' && route.id === conversation.id;
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => go({ page: 'chat', id: conversation.id })}
                  title={conversation.title}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors ${active ? 'bg-white/[0.07] text-white' : 'text-white/75 hover:bg-white/[0.04] hover:text-white'}`}
                >
                  <Avatar
                    colour={colourOf(conversation.clankId)}
                    size="xs"
                    live={conversation.replying}
                  />
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
              </li>
            );
          })}
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
