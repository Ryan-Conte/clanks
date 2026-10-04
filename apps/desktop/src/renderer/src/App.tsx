import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTRPC } from './lib/trpc';

export function App() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar title="Settings" />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          <div className="pointer-events-none absolute top-[-260px] left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(185,167,255,0.13),transparent)] blur-2xl" />
          <SettingsPage />
        </main>
      </div>
    </div>
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

function Sidebar() {
  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-line bg-panel/50 px-3 py-4">
      <div className="flex items-center gap-2.5 px-2 pb-6">
        <Logo />
        <span className="text-[17px] font-semibold tracking-tight">clanks</span>
      </div>

      <Eyebrow>Projects</Eyebrow>
      <p className="px-2 text-sm text-dim">No projects yet.</p>

      <div className="flex-1" />

      <div
        aria-current="page"
        className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.06] px-3 py-2.5 text-sm text-white"
      >
        <SlidersIcon />
        Settings
      </div>
    </nav>
  );
}

function SettingsPage() {
  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-8 px-10 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Settings</h1>
        <p className="text-dim">How clanks runs on this machine.</p>
      </header>
      <MachinePanel />
      <BackgroundPanel />
    </div>
  );
}

function MachinePanel() {
  const trpc = useTRPC();
  const info = useQuery(trpc.app.info.queryOptions());
  const secrets = useQuery(trpc.secrets.status.queryOptions());

  return (
    <Panel title="This machine">
      {info.error ? (
        <ErrorText>{info.error.message}</ErrorText>
      ) : !info.data ? (
        <p className="text-sm text-dim">Loading…</p>
      ) : (
        <dl data-testid="app-info" className="divide-y divide-line text-sm">
          <Row label="Version">
            {info.data.version}
            {info.data.packaged ? '' : <span className="text-dim"> (from source)</span>}
          </Row>
          <Row label="Platform">
            {info.data.platform} {info.data.arch}
          </Row>
          <Row label="Runtime">
            Electron {info.data.versions.electron}, Chromium {info.data.versions.chrome}, Node{' '}
            {info.data.versions.node}
          </Row>
          <Row label="Data folder">
            <span className="font-mono text-[13px] break-all">{info.data.dataDir}</span>
          </Row>
          <Row label="Database">
            SQLite {info.data.store.sqliteVersion}, {info.data.store.migrations}{' '}
            {info.data.store.migrations === 1 ? 'migration' : 'migrations'} applied
          </Row>
          <Row label="Keychain">
            {!secrets.data ? (
              <span className="text-dim">…</span>
            ) : (
              <span className="flex items-center gap-2">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${secrets.data.available ? 'animate-pulse-dot bg-accent-2' : 'bg-rose-400'}`}
                />
                {secrets.data.available
                  ? `Available (${secrets.data.backend})`
                  : `Unavailable (${secrets.data.backend}), so API keys can't be saved`}
              </span>
            )}
          </Row>
        </dl>
      )}
    </Panel>
  );
}

function BackgroundPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
    }),
  );

  return (
    <Panel title="In the background">
      {settings.error ? (
        <ErrorText>{settings.error.message}</ErrorText>
      ) : !settings.data ? (
        <p className="text-sm text-dim">Loading�</p>
      ) : (
        <Toggle
          label="Keep running in the tray"
          description="Closing the window leaves clanks running, so the crew keeps working. Quit from the tray icon."
          checked={settings.data.closeToTray}
          disabled={update.isPending}
          onChange={(closeToTray) => update.mutate({ closeToTray })}
        />
      )}
      {update.error && <ErrorText>{update.error.message}</ErrorText>}
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-line bg-panel/60 p-7 backdrop-blur-xl">
      <h2 className="text-lg font-medium tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-4 py-3 first:pt-0 last:pb-0">
      <dt className="text-dim">{label}</dt>
      <dd className="min-w-0 text-white/90">{children}</dd>
    </div>
  );
}

function Toggle(props: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-8">
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium">{props.label}</span>
        <span className="text-sm text-dim">{props.description}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-line bg-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50 aria-checked:border-transparent aria-checked:bg-accent"
      >
        <span
          className={`absolute top-0.5 left-0.5 size-[18px] rounded-full bg-white shadow transition-transform ${props.checked ? 'translate-x-5' : ''}`}
        />
      </button>
    </label>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-1 pb-2 text-[11px] font-medium tracking-[0.15em] text-dim uppercase">
      {children}
    </p>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-rose-300">{children}</p>;
}

/** The clanks mark: a 2×2 grid on a white tile. */
function Logo() {
  return (
    <div className="grid size-7 place-items-center rounded-lg bg-white">
      <div className="grid grid-cols-2 gap-[3px]">
        <span className="size-[5px] rounded-[1.5px] bg-black" />
        <span className="size-[5px] rounded-[1.5px] bg-black/40" />
        <span className="size-[5px] rounded-[1.5px] bg-black/40" />
        <span className="size-[5px] rounded-[1.5px] bg-black" />
      </div>
    </div>
  );
}

function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.5h6m3 0h2m-11 7h2m3 0h6M8.5 3v3m-3 4v3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
