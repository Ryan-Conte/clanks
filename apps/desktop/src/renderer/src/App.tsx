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
import { Onboarding, SampleOffer } from './pages/Onboarding';
import { ProjectPage } from './pages/ProjectPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  // Null until the user goes somewhere. Until then first run shows, if it isn't done yet.
  const [route, setRoute] = useState<Route | null>(null);
  const welcome = route === null && settings.data !== undefined && !settings.data.onboarded;
  // Once the crew has a model, the sample project is offered, once.
  const sample =
    route === null &&
    settings.data !== undefined &&
    settings.data.onboarded &&
    !settings.data.sampleOffered &&
    settings.data.crewModel !== null;
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
          <NavContext value={{ route: shown, go: setRoute }}>
            <div className="flex h-screen flex-col overflow-hidden">
              <TitleBar route={shown} welcome={welcome || sample} />
              <div className="flex min-h-0 flex-1">
                <Sidebar />
                <main className="relative min-w-0 flex-1 overflow-y-auto">
                  <div className="pointer-events-none absolute top-[-260px] left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(185,167,255,0.13),transparent)] blur-2xl" />
                  {!settings.data ? null : welcome ? (
                    <Onboarding />
                  ) : sample ? (
                    <SampleOffer />
                  ) : (
                    <Page route={shown} />
                  )}
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
  switch (route.page) {
    case 'home':
      return <HomePage />;
    case 'draft':
      return (
        <DraftChat
          key={`${route.projectId ?? ''}:${route.clankId}`}
          clankId={route.clankId}
          projectId={route.projectId ?? null}
        />
      );
    case 'chat':
      return <LiveChat key={route.id} id={route.id} />;
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
      return <NewProjectPage />;
    case 'models':
      return <ModelsPage />;
    case 'marketplace':
      return <MarketplacePage open={route.open ?? null} />;
    case 'settings':
      return <SettingsPage />;
  }
}

/** The window has no native frame; this bar drags it and leaves room for the window controls. */
function TitleBar({ route, welcome }: { route: Route; welcome: boolean }) {
  const conversations = useConversations();
  const clank = useClank(route.page === 'draft' || route.page === 'crew' ? route.clankId : null);
  const conversation =
    route.page === 'chat' ? conversations?.find((c) => c.id === route.id) : undefined;
  const project = useProject(
    route.page === 'project'
      ? route.id
      : route.page === 'draft'
        ? route.projectId
        : conversation?.projectId,
  );
  let title: string;
  if (welcome) title = 'Welcome';
  else if (route.page === 'chat') title = conversation?.title ?? 'Chat';
  else if (route.page === 'draft') title = clank ? `New chat with ${clank.name}` : 'New chat';
  else if (route.page === 'crew') title = clank?.name ?? 'Crew';
  else if (route.page === 'project') {
    title = {
      board: 'Board',
      spec: 'Spec',
      design: 'Studio',
      routines: 'Routines',
      context: 'Context',
      settings: 'Settings',
    }[route.tab];
  } else {
    title = {
      home: 'Home',
      'new-clank': 'New clank',
      'new-project': 'New project',
      models: 'Models',
      marketplace: 'Marketplace',
      settings: 'Settings',
    }[route.page];
  }

  return (
    <header className="titlebar app-drag flex h-10 shrink-0 items-center border-b border-line font-mono text-[13px] text-dim">
      <span className="truncate">
        clanks <span className="text-white/25">·</span>{' '}
        {project && (
          <>
            {project.name} <span className="text-white/25">·</span>{' '}
          </>
        )}
        {title}
      </span>
    </header>
  );
}
