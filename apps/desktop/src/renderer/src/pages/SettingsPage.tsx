import type { Settings, SettingsPatch } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { GitHubAccount, GitHubSignIn } from '../components/project/GitHub';
import { LocalApiPanel } from '../components/settings/LocalApiPanel';
import { ProfilePanel } from '../components/settings/ProfilePanel';
import { CloudPanel, ServersPanel } from '../components/settings/ProvidersPanels';
import {
  ApprovalsPanel,
  McpPanel,
  RulesPanel,
  WebSearchPanel,
} from '../components/settings/ToolsPanels';
import { Button, Dot, ErrorText, Panel, Row, Toggle, inputClass } from '../components/ui';
import { formatTokens } from '../lib/format';
import { useGitHub } from '../lib/github';
import { BACKEND_NAMES, useModels } from '../lib/models';
import { useTRPC } from '../lib/trpc';

const HF_TOKEN = 'hf:token';

export function SettingsPage() {
  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-8 px-10 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Settings</h1>
        <p className="text-dim">Who you are, and how clanks runs on this machine.</p>
      </header>
      <ProfilePanel />
      <ModelSettingsPanel />
      <CloudPanel />
      <ServersPanel />
      <McpPanel />
      <WebSearchPanel />
      <ApprovalsPanel />
      <RulesPanel />
      <LocalApiPanel />
      <GitHubPanel />
      <HuggingFacePanel />
      <BackgroundPanel />
      <AppPanel />
    </div>
  );
}

function useSettings() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
    }),
  );
  return { settings, update: (patch: SettingsPatch) => update.mutate(patch), mutation: update };
}

/** The GitHub account projects clone their repositories from. */
function GitHubPanel() {
  const status = useGitHub();
  return (
    <Panel
      title="GitHub"
      description="For projects on a GitHub repository: listing and making repositories, and cloning them. The token stays in your keychain and only goes to GitHub."
    >
      {status?.signedIn ? <GitHubAccount status={status} /> : <GitHubSignIn />}
    </Panel>
  );
}

function AppPanel() {
  const trpc = useTRPC();
  const info = useQuery(trpc.app.info.queryOptions());
  const secrets = useQuery(trpc.secrets.status.queryOptions());

  return (
    <Panel title="This app">
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
                <Dot
                  tone={secrets.data.available ? 'mint' : 'rose'}
                  live={secrets.data.available}
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
  const { settings, update, mutation } = useSettings();
  return (
    <Panel title="In the background">
      {settings.error ? (
        <ErrorText>{settings.error.message}</ErrorText>
      ) : !settings.data ? (
        <p className="text-sm text-dim">Loading…</p>
      ) : (
        <Toggle
          label="Keep running in the tray"
          description="Closing the window leaves clanks running, so the crew keeps working. Quit from the tray icon."
          checked={settings.data.closeToTray}
          disabled={mutation.isPending}
          onChange={(closeToTray) => update({ closeToTray })}
        />
      )}
      {mutation.error && <ErrorText>{mutation.error.message}</ErrorText>}
    </Panel>
  );
}

function ModelSettingsPanel() {
  const { settings, update, mutation } = useSettings();
  const snapshot = useModels();
  const s = settings.data;
  if (!s) return null;
  const builds = snapshot?.runtime.builds ?? [];

  return (
    <Panel
      title="Running models"
      description="Changes apply the next time a model loads. Changing the build or memory unloads everything."
    >
      <div className="flex flex-col gap-4">
        <Field label="Unload a model after" hint="Unless it's kept loaded.">
          <Select
            value={String(s.modelIdleMinutes)}
            options={[5, 10, 30, 60, 240].map((m) => [
              String(m),
              m < 60 ? `${m} minutes idle` : `${m / 60} ${m === 60 ? 'hour' : 'hours'} idle`,
            ])}
            onChange={(v) => update({ modelIdleMinutes: Number(v) })}
          />
        </Field>
        <Field
          label="Context per slot"
          hint="More remembers more of a conversation, and needs more memory."
        >
          <Select
            value={String(s.contextPerSlot)}
            options={[8192, 16384, 32768, 65536, 131072].map((n) => [
              String(n),
              `${formatTokens(n)} tokens`,
            ])}
            onChange={(v) => update({ contextPerSlot: Number(v) })}
          />
        </Field>
        <Field label="Parallel slots" hint="How many clanks can share one loaded model at once.">
          <Select
            value={s.parallelSlots === null ? 'auto' : String(s.parallelSlots)}
            options={[
              ['auto', 'Automatic'],
              ...[1, 2, 3, 4].map((n) => [String(n), String(n)] as [string, string]),
            ]}
            onChange={(v) => update({ parallelSlots: v === 'auto' ? null : Number(v) })}
          />
        </Field>
        <Field label="Run models on" hint="Automatic picks the fastest build that sees your GPU.">
          <Select
            value={s.runtimeBackend}
            options={[
              ['auto', 'Automatic'],
              ...builds.map((b) => [b.backend, BACKEND_NAMES[b.backend]] as [string, string]),
            ]}
            onChange={(v) => update({ runtimeBackend: v as Settings['runtimeBackend'] })}
          />
        </Field>
        <Field
          label="Memory for models"
          hint="In GB. Leave empty to size it from what this machine has."
        >
          <span className="flex gap-2">
            <BudgetInput
              label="GPU"
              mib={s.gpuBudgetMiB}
              onSave={(gpuBudgetMiB) => update({ gpuBudgetMiB })}
            />
            <BudgetInput
              label="System"
              mib={s.systemBudgetMiB}
              onSave={(systemBudgetMiB) => update({ systemBudgetMiB })}
            />
          </span>
        </Field>
      </div>
      {mutation.error && <ErrorText>{mutation.error.message}</ErrorText>}
    </Panel>
  );
}

function HuggingFacePanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const status = useQuery(trpc.secrets.status.queryOptions());
  const has = useQuery(trpc.secrets.has.queryOptions(HF_TOKEN));
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.secrets.has.queryKey(HF_TOKEN) });
  const save = useMutation(
    trpc.secrets.set.mutationOptions({
      onSuccess: () => {
        setToken('');
        void refresh();
      },
    }),
  );
  const remove = useMutation(
    trpc.secrets.delete.mutationOptions({ onSuccess: () => void refresh() }),
  );
  const available = status.data?.available ?? false;

  return (
    <Panel
      title="Hugging Face"
      description="Only needed for gated or private models. The token stays in your keychain and goes only to huggingface.co."
    >
      {has.data ? (
        <div className="flex items-center justify-between gap-4">
          <p className="flex items-center gap-2 text-sm">
            <Dot tone="mint" /> A token is saved.
          </p>
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(HF_TOKEN)}>
            Remove
          </Button>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ ref: HF_TOKEN, value: token.trim() });
          }}
        >
          <input
            type="password"
            aria-label="Hugging Face token"
            className={`${inputClass} w-full font-mono`}
            placeholder={available ? 'hf_…' : 'No keychain, so a token can’t be saved'}
            disabled={!available}
            value={token}
            autoComplete="off"
            onChange={(e) => setToken(e.target.value)}
          />
          <Button type="submit" disabled={!available || !token.trim() || save.isPending}>
            Save
          </Button>
        </form>
      )}
      {(save.error ?? remove.error) && (
        <ErrorText>{(save.error ?? remove.error)!.message}</ErrorText>
      )}
    </Panel>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[13px] text-dim">{hint}</span>
      </span>
      {children}
    </div>
  );
}

function Select(props: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <select
      className={`${inputClass} w-52 shrink-0`}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

function BudgetInput(props: {
  label: string;
  mib: number | null;
  onSave: (mib: number | null) => void;
}) {
  const shown = props.mib === null ? '' : String(Math.round((props.mib / 1024) * 10) / 10);
  const [draft, setDraft] = useState(shown);
  const commit = () => {
    const value = draft.trim() === '' ? null : Math.round(Number(draft) * 1024);
    if (value !== null && (!Number.isFinite(value) || value < 0)) return setDraft(shown);
    if (value !== props.mib) props.onSave(value);
  };
  return (
    <input
      aria-label={`${props.label} memory for models, in GB`}
      className={`${inputClass} w-[6.25rem]`}
      inputMode="decimal"
      placeholder={props.label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}
