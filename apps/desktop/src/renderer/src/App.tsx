import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ModelsProvider } from './components/ModelsProvider';
import { ChipIcon, Dot, Eyebrow, Logo, SlidersIcon } from './components/ui';
import { useModels } from './lib/models';
import { useTRPC } from './lib/trpc';
import { ModelsPage } from './pages/ModelsPage';
import { Onboarding } from './pages/Onboarding';
import { SettingsPage } from './pages/SettingsPage';

type Page = 'models' | 'settings';

const TITLES: Record<Page | 'welcome', string> = {
  welcome: 'Welcome',
  models: 'Models',
  settings: 'Settings',
};

export function App() {
  const trpc = useTRPC();
  const settings = useQuery(trpc.settings.get.queryOptions());
  // Null until the user picks a page. Until then first run shows, if it isn't done yet.
  const [page, setPage] = useState<Page | null>(null);
  const shown = page ?? (settings.data && !settings.data.onboarded ? 'welcome' : 'models');

  return (
    <ModelsProvider>
      <div className="flex h-screen flex-col overflow-hidden">
        <TitleBar title={TITLES[shown]} />
        <div className="flex min-h-0 flex-1">
          <Sidebar page={shown === 'welcome' ? null : shown} onPage={setPage} />
          <main className="relative min-w-0 flex-1 overflow-y-auto">
            <div className="pointer-events-none absolute top-[-260px] left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(185,167,255,0.13),transparent)] blur-2xl" />
            {!settings.data ? null : shown === 'welcome' ? (
              <Onboarding />
            ) : shown === 'models' ? (
              <ModelsPage />
            ) : (
              <SettingsPage />
            )}
          </main>
        </div>
      </div>
    </ModelsProvider>
  );
}

/** The window has no native frame; this bar drags it and leaves room for the window controls. */
function TitleBar({ title }: { title: string }) {
  return (
    <header className="titlebar app-drag flex h-10 shrink-0 items-center border-b border-line font-mono text-[13px] text-dim">
      <span className="truncate">
        clanks <span className="text-white/25">·</span> {title}
      </span>
    </header>
  );
}

function Sidebar({ page, onPage }: { page: Page | null; onPage: (page: Page) => void }) {
  const snapshot = useModels();
  const working = snapshot?.runtime.loaded.some((l) => l.inUse > 0) ?? false;
  const loaded = (snapshot?.runtime.loaded.length ?? 0) > 0;
  const pulling = snapshot?.pulls.some((p) => p.state === 'downloading' || p.state === 'verifying');

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-line bg-panel/50 px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <Logo />
        <span className="text-[17px] font-semibold tracking-tight">clanks</span>
      </div>

      <Eyebrow>Projects</Eyebrow>
      <p className="px-2 text-sm text-dim">No projects yet.</p>

      <div className="flex-1" />

      <div className="flex flex-col gap-1">
        <NavItem active={page === 'models'} onClick={() => onPage('models')} icon={<ChipIcon />}>
          Models
          {(loaded || pulling) && (
            <span className="ml-auto">
              <Dot tone={pulling ? 'lavender' : 'mint'} live={working || pulling} />
            </span>
          )}
        </NavItem>
        <NavItem
          active={page === 'settings'}
          onClick={() => onPage('settings')}
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
