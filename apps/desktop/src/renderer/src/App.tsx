import { LEAD_CLANK } from '@clanks/core';
import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useState } from 'react';
import { ConversationsProvider } from './components/ConversationsProvider';
import { ModelsProvider } from './components/ModelsProvider';
import { ProjectsProvider } from './components/ProjectsProvider';
import { Sidebar } from './components/Sidebar';
import { useClank, useConversations } from './lib/crew';
import { NavContext, type Route } from './lib/nav';
import { useProject } from './lib/projects';
import { useTRPC } from './lib/trpc';
import { DraftChat, LiveChat } from './pages/ChatPage';
import { ClankPage, CrewPage } from './pages/CrewPage';
import { HomePage } from './pages/HomePage';
import { MarketplacePage } from './pages/MarketplacePage';
import { ModelsPage } from './pages/ModelsPage';
import { NewClankPage } from './pages/NewClankPage';
import { NewProjectPage } from './pages/NewProjectPage';
import { ProjectPage } from './pages/ProjectPage';
import { SettingsPage } from './pages/SettingsPage';
import { Welcome } from './pages/Welcome';

export function App() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  // Null until the user goes somewhere. Until then first run shows, if it isn't done yet.
  const [route, setRoute] = useState<Route | null>(null);
  const welcome = route === null && settings.data !== undefined && !settings.data.onboarded;
  const shown: Route = route ?? { page: 'home' };
  // The shell sends the window somewhere, such as to the routine a notification was about.
  useSubscription(
    trpc.app.opened.subscriptionOptions(undefined, {
      onData: (to) => {
        if (to.page === 'routines') {
          setRoute({
            page: 'project',
            id: to.projectId,
            tab: 'routines',
            focus: to.actionId ?? to.runId,
          });
        } else setRoute({ page: to.page });
      },
    }),
  );

  return (
    <ModelsProvider>
      <ConversationsProvider>
        <ProjectsProvider>
          <NavContext value={{ route: welcome ? { page: 'setup' } : shown, go: setRoute }}>
            <div className="flex h-screen flex-col overflow-hidden">
              <TitleBar route={welcome ? { page: 'setup' } : shown} />
              <div className="flex min-h-0 flex-1">
                {/* First run is one thing to do, with nothing beside it to wonder about. */}
                {!welcome && <Sidebar />}
                <main className="relative min-w-0 flex-1 overflow-y-auto">
                  <div className="pointer-events-none absolute top-[-260px] left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(185,167,255,0.13),transparent)] blur-2xl" />
                  {!settings.data ? null : welcome ? <Welcome /> : <Page route={shown} />}
                </main>
              </div>
            </div>
          </NavContext>
        </ProjectsProvider>
      </ConversationsProvider>
    </ModelsProvider>
  );
}

function Page({ route }: { route: Route }) {
  const conversations = useConversations();
  switch (route.page) {
    case 'home':
      return <HomePage />;
    case 'setup':
      return <Welcome />;
    case 'draft':
      // A new chat in a project is written in the project, with its crew beside it.
      return route.projectId ? (
        <ProjectPage
          key={route.projectId}
          id={route.projectId}
          tab="overview"
          chat={{ draft: route.clankId }}
          ticket={route.ticket ?? null}
        />
      ) : (
        <DraftChat key={route.clankId} clankId={route.clankId} projectId={null} />
      );
    case 'chat': {
      // Which it is isn't known until the chats have arrived.
      if (!conversations) return null;
      const conversation = conversations.find((c) => c.id === route.id);
      // The user's own chat in a project is the project's conversation. A clank's run on a
      // ticket is watched on a page of its own, with the workbench.
      const projectId = conversation
        ? conversation.role === null
          ? conversation.projectId
          : null
        : route.projectId;
      return projectId ? (
        <ProjectPage
          key={projectId}
          id={projectId}
          tab="overview"
          chat={{ id: route.id }}
          ticket={route.ticket ?? null}
        />
      ) : (
        <LiveChat key={route.id} id={route.id} />
      );
    }
    case 'crew':
      return route.clankId ? (
        <ClankPage key={route.clankId} clankId={route.clankId} />
      ) : (
        <CrewPage />
      );
    case 'project':
      return (
        <ProjectPage
          key={route.id}
          id={route.id}
          tab={route.tab}
          ticket={route.ticket ?? null}
          run={route.run ?? null}
          focus={route.focus ?? null}
        />
      );
    case 'new-clank':
      return <NewClankPage />;
    case 'new-project':
      return <NewProjectPage idea={route.idea ?? ''} templateId={route.templateId ?? null} />;
    case 'models':
      return <ModelsPage />;
    case 'marketplace':
      return <MarketplacePage open={route.open ?? null} />;
    case 'settings':
      return <SettingsPage key={route.section ?? 'you'} section={route.section ?? null} />;
  }
}

/** The window has no native frame; this bar drags it and leaves room for the window controls. */
function TitleBar({ route }: { route: Route }) {
  const conversations = useConversations();
  const clank = useClank(route.page === 'draft' || route.page === 'crew' ? route.clankId : null);
  const conversation =
    route.page === 'chat' ? conversations?.find((c) => c.id === route.id) : undefined;
  const project = useProject(
    route.page === 'project'
      ? route.id
      : route.page === 'draft'
        ? route.projectId
        : route.page === 'chat'
          ? (conversation?.projectId ?? route.projectId)
          : null,
  );
  let title: string;
  if (route.page === 'chat') title = conversation?.title ?? 'Chat';
  else if (route.page === 'draft') {
    title = project
      ? clank && clank.id !== LEAD_CLANK
        ? `New chat with ${clank.name}`
        : ''
      : clank
        ? `New chat with ${clank.name}`
        : 'New chat';
  } else if (route.page === 'crew') title = clank?.name ?? 'Crew';
  else if (route.page === 'project') {
    title = {
      overview: '',
      board: 'Board',
      spec: 'Spec',
      design: 'Studio',
      routines: 'Routines',
      context: 'Knowledge',
      settings: 'Settings',
    }[route.tab];
  } else {
    title = {
      home: 'Home',
      setup: 'Welcome',
      'new-clank': 'New clank',
      'new-project': 'New project',
      models: 'Models',
      marketplace: 'Marketplace',
      settings: 'Settings',
    }[route.page];
  }
  const parts = [project?.name, title].filter(Boolean);

  return (
    <header className="titlebar app-drag flex h-10 shrink-0 items-center border-b border-line text-[13px] text-dim">
      <span className="truncate">
        <span className="font-medium text-white/70">clanks</span>
        {parts.map((part) => (
          <span key={part}>
            <span className="px-2 text-white/20">/</span>
            {part}
          </span>
        ))}
      </span>
    </header>
  );
}
