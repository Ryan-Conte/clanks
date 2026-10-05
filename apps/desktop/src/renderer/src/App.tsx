import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ConversationsProvider } from './components/ConversationsProvider';
import { ModelsProvider } from './components/ModelsProvider';
import { Sidebar } from './components/Sidebar';
import { useClank, useConversations } from './lib/crew';
import { NavContext, type Route } from './lib/nav';
import { useTRPC } from './lib/trpc';
import { DraftChat, LiveChat } from './pages/ChatPage';
import { ClankPage, CrewPage } from './pages/CrewPage';
import { HomePage } from './pages/HomePage';
import { ModelsPage } from './pages/ModelsPage';
import { Onboarding } from './pages/Onboarding';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  // Null until the user goes somewhere. Until then first run shows, if it isn't done yet.
  const [route, setRoute] = useState<Route | null>(null);
  const welcome = route === null && settings.data !== undefined && !settings.data.onboarded;
  const shown: Route = route ?? { page: 'home' };

  return (
    <ModelsProvider>
      <ConversationsProvider>
        <NavContext value={{ route: shown, go: setRoute }}>
          <div className="flex h-screen flex-col overflow-hidden">
            <TitleBar route={shown} welcome={welcome} />
            <div className="flex min-h-0 flex-1">
              <Sidebar />
              <main className="relative min-w-0 flex-1 overflow-y-auto">
                <div className="pointer-events-none absolute top-[-260px] left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(185,167,255,0.13),transparent)] blur-2xl" />
                {!settings.data ? null : welcome ? <Onboarding /> : <Page route={shown} />}
              </main>
            </div>
          </div>
        </NavContext>
      </ConversationsProvider>
    </ModelsProvider>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'home':
      return <HomePage />;
    case 'draft':
      return <DraftChat key={route.clankId} clankId={route.clankId} />;
    case 'chat':
      return <LiveChat key={route.id} id={route.id} />;
    case 'crew':
      return route.clankId ? (
        <ClankPage key={route.clankId} clankId={route.clankId} />
      ) : (
        <CrewPage />
      );
    case 'models':
      return <ModelsPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

/** The window has no native frame; this bar drags it and leaves room for the window controls. */
function TitleBar({ route, welcome }: { route: Route; welcome: boolean }) {
  const conversations = useConversations();
  const clank = useClank(route.page === 'draft' || route.page === 'crew' ? route.clankId : null);
  let title: string;
  if (welcome) title = 'Welcome';
  else if (route.page === 'chat')
    title = conversations?.find((c) => c.id === route.id)?.title ?? 'Chat';
  else if (route.page === 'draft') title = clank ? `New chat with ${clank.name}` : 'New chat';
  else if (route.page === 'crew') title = clank?.name ?? 'Crew';
  else title = { home: 'Chat', models: 'Models', settings: 'Settings' }[route.page];

  return (
    <header className="titlebar app-drag flex h-10 shrink-0 items-center border-b border-line font-mono text-[13px] text-dim">
      <span className="truncate">
        clanks <span className="text-white/25">·</span> {title}
      </span>
    </header>
  );
}
