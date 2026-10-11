import {
  type ClankPreview,
  type IntegrationPreview,
  type MarketplaceEntry,
  PACKAGE_KIND_NAMES,
  type PackageKind,
  type PackagePreview,
} from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Heading, Hosts, Operations, Source } from '../components/integrations/shared';
import { Badge, Button, Dot, ErrorText, Panel, inputClass } from '../components/ui';
import { type DiffHandle, MonacoDiff } from '../components/workbench/MonacoDiff';
import { useCrew } from '../lib/crew';
import { indexLabel, useMarketplace } from '../lib/integrations';
import { type PackageRef, useNav } from '../lib/nav';
import { useTRPC } from '../lib/trpc';

const KINDS: [PackageKind | 'all', string][] = [
  ['all', 'Everything'],
  ['clank', 'Clanks'],
  ['integration', 'Integrations'],
  ['crew', 'Crews'],
  ['routine', 'Routines'],
];

/** The marketplace: what people have shared, what's installed from it, and each package in full. */
export function MarketplacePage({ open }: { open: PackageRef | null }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const snapshot = useMarketplace();
  const refresh = useMutation(trpc.marketplace.refresh.mutationOptions());
  const [tab, setTab] = useState<'browse' | 'installed'>('browse');
  const [kind, setKind] = useState<PackageKind | 'all'>('all');
  const [query, setQuery] = useState('');
  // Browsing needs the indexes read; opening the page is what asks for them.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    refresh.mutate();
  }, [refresh]);

  if (open) {
    return (
      <PackagePage
        key={`${open.index}:${open.kind}:${open.id}`}
        target={open}
        onBack={() => go({ page: 'marketplace' })}
      />
    );
  }

  const entries = snapshot?.entries ?? [];
  const words = query.trim().toLowerCase();
  const shown = entries.filter(
    (entry) =>
      (kind === 'all' || entry.kind === kind) &&
      (words === '' ||
        `${entry.name} ${entry.summary} ${entry.publisher} ${entry.id}`
          .toLowerCase()
          .includes(words)),
  );
  const installed = snapshot?.installed ?? [];
  const updates = installed.filter((p) => p.status === 'update_available').length;
  const failing = snapshot?.indexes.filter((index) => index.error) ?? [];

  return (
    <div className="relative mx-auto flex max-w-4xl flex-col gap-6 px-10 py-12">
      <header className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Marketplace</h1>
          <p className="text-dim">
            Clanks, integrations and crews people have shared. Free to install and free to publish,
            with no account. You see everything a package is before it's installed.
          </p>
        </div>
        <Button
          disabled={refresh.isPending || snapshot?.refreshing}
          onClick={() => refresh.mutate()}
        >
          {snapshot?.refreshing ? 'Reading…' : 'Refresh'}
        </Button>
      </header>

      {failing.map((index) => (
        <p
          key={index.url}
          className="rounded-xl border border-amber-300/25 bg-amber-300/[0.06] px-4 py-3 text-sm text-amber-100"
        >
          {index.name} couldn't be read{index.fetchedAt ? ', so this is what it had before' : ''}:{' '}
          {index.error}. What you've installed works without it.
        </p>
      ))}

      <div className="flex items-center gap-2" role="tablist">
        {(
          [
            ['browse', 'Browse'],
            ['installed', `Installed${installed.length ? ` · ${installed.length}` : ''}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm transition-colors ${tab === value ? 'border-line bg-white/[0.07] text-white' : 'border-transparent text-dim hover:text-white'}`}
          >
            {label}
            {value === 'installed' && updates > 0 && <Dot tone="lavender" live />}
          </button>
        ))}
      </div>

      {tab === 'browse' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Search the marketplace"
              placeholder="Search"
              className={`${inputClass} h-9 w-64`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {KINDS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className={`rounded-full border px-3 py-1 text-[13px] transition-colors ${kind === value ? 'border-accent/50 bg-accent/10 text-white' : 'border-line text-dim hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <p className="rounded-3xl border border-line bg-panel/60 px-7 py-10 text-center text-sm text-dim">
              {!snapshot || snapshot.refreshing
                ? 'Reading the marketplace…'
                : entries.length === 0
                  ? "Nothing's listed yet."
                  : 'Nothing matches that.'}
            </p>
          ) : (
            <ul data-testid="marketplace-entries" className="grid grid-cols-2 gap-3">
              {shown.map((entry) => (
                <li key={`${entry.index}:${entry.kind}:${entry.id}`}>
                  <EntryCard
                    entry={entry}
                    onOpen={() =>
                      go({
                        page: 'marketplace',
                        open: { index: entry.index, kind: entry.kind, id: entry.id },
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <InstalledList />
      )}
    </div>
  );
}

function StatusBadges({ entry }: { entry: MarketplaceEntry }) {
  return (
    <>
      {entry.revoked && <Badge tone="rose">Taken down</Badge>}
      {entry.installed?.status === 'update_available' && (
        <Badge tone="lavender">Update to {entry.installed.latest}</Badge>
      )}
      {entry.installed && entry.installed.status !== 'update_available' && (
        <Badge tone="mint">Installed {entry.installed.version}</Badge>
      )}
      {entry.builtin && !entry.installed && <Badge>Built in</Badge>}
      {entry.runsCode && <Badge tone="amber">Runs code</Badge>}
      {entry.reviewed && <Badge tone="mint">Reviewed</Badge>}
    </>
  );
}

function EntryCard({ entry, onOpen }: { entry: MarketplaceEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full w-full flex-col gap-2 rounded-3xl border border-line bg-panel/60 p-5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-[11px] tracking-[0.2em] text-accent uppercase">
          {PACKAGE_KIND_NAMES[entry.kind]}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-dim">{entry.latest}</span>
      </span>
      <span className="text-[15px] font-medium">{entry.name}</span>
      <span className="line-clamp-3 flex-1 text-[13px] text-white/65">{entry.summary}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-dim">by {entry.publisher}</span>
        <StatusBadges entry={entry} />
      </span>
    </button>
  );
}

function InstalledList() {
  const trpc = useTRPC();
  const { go } = useNav();
  const snapshot = useMarketplace();
  const uninstall = useMutation(trpc.marketplace.uninstall.mutationOptions());
  const pin = useMutation(trpc.marketplace.setPinned.mutationOptions());
  const installed = snapshot?.installed ?? [];
  const error = uninstall.error ?? pin.error;
  if (installed.length === 0) {
    return (
      <p className="rounded-3xl border border-line bg-panel/60 px-7 py-10 text-center text-sm text-dim">
        Nothing installed from a marketplace yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-line rounded-3xl border border-line bg-panel/60">
        {installed.map((item) => (
          <li key={`${item.kind}:${item.id}`} className="flex items-center gap-3 px-6 py-3.5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{item.name}</span>
                <Badge>{PACKAGE_KIND_NAMES[item.kind]}</Badge>
                <span className="font-mono text-[12px] text-dim">{item.version}</span>
                {item.status === 'update_available' && (
                  <Badge tone="lavender">{item.latest} is out</Badge>
                )}
                {item.status === 'revoked' && <Badge tone="rose">Taken down</Badge>}
                {item.pinned && <Badge>Staying on this version</Badge>}
              </span>
              <span className="truncate text-[12px] text-dim">
                by {item.publisher} · {item.licence} · from {indexLabel(item.index)}
              </span>
              {item.status === 'revoked' && (
                <span className="text-[12px] text-rose-300">
                  It's off: its marketplace took it down{item.notice ? `. ${item.notice}` : '.'}
                </span>
              )}
            </span>
            {item.status === 'update_available' && (
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  go({
                    page: 'marketplace',
                    open: { index: item.index, kind: item.kind, id: item.id },
                  })
                }
              >
                See what changed
              </Button>
            )}
            {(item.status === 'update_available' || item.pinned) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={pin.isPending}
                onClick={() => pin.mutate({ kind: item.kind, id: item.id, pinned: !item.pinned })}
              >
                {item.pinned ? 'Tell me about updates' : `Stay on ${item.version}`}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={uninstall.isPending}
              onClick={() => uninstall.mutate({ kind: item.kind, id: item.id })}
            >
              Uninstall
            </Button>
          </li>
        ))}
      </ul>
      {error && <ErrorText>{error.message}</ErrorText>}
    </div>
  );
}

/** One package, in full: everything it is, and for an update, everything that changes. */
function PackagePage({ target, onBack }: { target: PackageRef; onBack: () => void }) {
  const trpc = useTRPC();
  const [version, setVersion] = useState<string | null>(null);
  const preview = useQuery(
    trpc.marketplace.preview.queryOptions(
      { ...target, ...(version ? { version } : {}) },
      { staleTime: 0, gcTime: 0, retry: false },
    ),
  );
  const install = useMutation(
    trpc.marketplace.install.mutationOptions({ onSuccess: () => void preview.refetch() }),
  );
  const uninstall = useMutation(trpc.marketplace.uninstall.mutationOptions({ onSuccess: onBack }));
  const pin = useMutation(
    trpc.marketplace.setPinned.mutationOptions({ onSuccess: () => void preview.refetch() }),
  );
  const data = preview.data;
  const entry = data?.entry;
  const installed = entry?.installed ?? null;
  const same = installed !== null && installed.version === data?.version;
  const error = install.error ?? uninstall.error ?? pin.error;

  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm text-dim transition-colors hover:text-white"
      >
        ← Marketplace
      </button>
      {preview.error ? (
        <p className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-200">
          {preview.error.message}
        </p>
      ) : !data || !entry ? (
        <p className="text-sm text-dim">Fetching it and checking it against its checksum…</p>
      ) : (
        <>
          <header className="flex flex-col gap-3">
            <span className="font-mono text-xs tracking-[0.2em] text-accent uppercase">
              {PACKAGE_KIND_NAMES[entry.kind]}
            </span>
            <div className="flex items-start justify-between gap-6">
              <div className="flex flex-col gap-1.5">
                <h1 className="text-3xl font-semibold tracking-[-0.03em]">{entry.name}</h1>
                <p className="text-dim">{entry.summary}</p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                {entry.kind === 'routine' ? null : same ? (
                  <Badge tone="mint">Installed</Badge>
                ) : (
                  <Button
                    variant="primary"
                    disabled={data.problems.length > 0 || install.isPending}
                    onClick={() =>
                      install.mutate({ ...target, version: data.version, sha256: data.sha256 })
                    }
                  >
                    {install.isPending
                      ? 'Installing…'
                      : installed
                        ? `Update to ${data.version}`
                        : `Install ${data.version}`}
                  </Button>
                )}
                {installed && !same && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pin.isPending}
                    onClick={() =>
                      pin.mutate({ kind: entry.kind, id: entry.id, pinned: !installed.pinned })
                    }
                  >
                    {installed.pinned ? 'Tell me about updates' : `Stay on ${installed.version}`}
                  </Button>
                )}
              </div>
            </div>
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusBadges entry={entry} />
              <Badge>{entry.licence}</Badge>
              <span className="text-[12px] text-dim">
                by {entry.publisher} · from {entry.indexName} ({indexLabel(entry.index)})
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2 text-[12px] text-dim">
              <label htmlFor="package-version">Version</label>
              <select
                id="package-version"
                className={`${inputClass} h-8 w-28 font-mono text-[12px]`}
                value={data.version}
                onChange={(e) => setVersion(e.target.value)}
              >
                {[...entry.versions].reverse().map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <span title={data.sha256} className="font-mono">
                checked against sha256 {data.sha256.slice(0, 12)}…
              </span>
            </span>
          </header>

          {data.problems.length > 0 && (
            <div className="flex flex-col gap-2 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4">
              <p className="text-sm font-medium text-rose-200">It can't be installed as it is</p>
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] whitespace-pre-wrap text-rose-100/90">
                {data.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="text-sm whitespace-pre-wrap text-rose-300">{error.message}</p>}

          {data.changes && !same && <Changes preview={data} />}
          {data.clank && <ClankDetails clank={data.clank} />}
          {data.integration && (
            <IntegrationDetails
              integration={data.integration}
              freshHosts={data.changes?.newHosts ?? []}
              freshOperations={data.changes?.newOperations ?? []}
            />
          )}
          {data.crew && (
            <>
              <Panel
                title="What's in this crew"
                description="Installing it installs each clank and integration below that you don't have. You pick the crew when you start a project."
              >
                <CrewNames ids={data.crew.premade} />
                {data.crew.missing.length > 0 && (
                  <ErrorText>Not in this marketplace: {data.crew.missing.join(', ')}.</ErrorText>
                )}
              </Panel>
              {data.crew.clanks.map((clank) => (
                <ClankDetails key={clank.id} clank={clank} />
              ))}
              {data.crew.integrations.map((integration) => (
                <IntegrationDetails
                  key={integration.id}
                  integration={integration}
                  freshHosts={[]}
                  freshOperations={[]}
                />
              ))}
            </>
          )}
          {installed && (
            <Panel
              title={`Uninstall ${entry.name}`}
              description={
                entry.kind === 'clank'
                  ? "It goes from your library, with its chats. Take it out of each project's crew first."
                  : entry.kind === 'integration'
                    ? entry.builtin
                      ? 'It goes back to the version that ships with the app, and keeps its accounts.'
                      : 'Its accounts are disconnected and their keys deleted from your keychain.'
                    : 'The clanks and integrations it brought stay; only the crew goes.'
              }
            >
              <Button
                variant="danger"
                className="self-start"
                disabled={uninstall.isPending}
                onClick={() => uninstall.mutate({ kind: entry.kind, id: entry.id })}
              >
                Uninstall
              </Button>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

/** The clanks that ship with the app, by name. */
function CrewNames({ ids }: { ids: string[] }) {
  const crew = useCrew();
  if (ids.length === 0) return null;
  return (
    <p className="text-sm text-white/85">
      With {ids.map((id) => crew.find((c) => c.id === id)?.name ?? id).join(', ')}, who ship with
      the app.
    </p>
  );
}

/** What an update changes that's worth reading before accepting it. */
function Changes({ preview }: { preview: PackagePreview }) {
  const changes = preview.changes!;
  const flagged =
    changes.newTools.length +
    changes.raisedTools.length +
    changes.newHosts.length +
    changes.newOperations.length +
    changes.loweredRisks.length;
  return (
    <Panel
      title={`What changes from ${changes.from}`}
      description="Nothing changes until you accept it. Staying on the version you have is fine."
    >
      {flagged === 0 ? (
        <p className="text-sm text-dim">
          {changes.files.length === 0
            ? "It's the same as what you have: nothing in it differs."
            : 'No new tools, hosts or permissions: only what the files below show.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-4 text-[13px] text-amber-100">
          {changes.newTools.length > 0 && (
            <li>
              New tools: <Mono items={changes.newTools} />. Above read, each starts at ask.
            </li>
          )}
          {changes.raisedTools.length > 0 && (
            <li>
              Its doc now asks for more of: <Mono items={changes.raisedTools} />. What you set on
              its profile stays.
            </li>
          )}
          {changes.newHosts.length > 0 && (
            <li>
              It calls hosts it didn't: <Mono items={changes.newHosts} />. Your key isn't sent to
              them until you allow it, in Settings.
            </li>
          )}
          {changes.newOperations.length > 0 && (
            <li>
              New operations: <Mono items={changes.newOperations} />.
            </li>
          )}
          {changes.loweredRisks.map((lowered) => (
            <li key={lowered.operation}>
              <code className="font-mono text-[12px] text-white">{lowered.operation}</code> was
              rated {lowered.from} and is now {lowered.to}, so it asks less often.
            </li>
          ))}
        </ul>
      )}
      {changes.files.map((file) => (
        <FileDiff key={file.name} file={file} />
      ))}
    </Panel>
  );
}

/** One file of a package, as it is now against as it would be. */
function FileDiff({ file }: { file: { name: string; before: string; after: string } }) {
  const handle = useRef<DiffHandle | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <Heading>{file.name}</Heading>
      <div className="h-[22rem] overflow-hidden rounded-2xl border border-line">
        <MonacoDiff
          path={file.name}
          original={file.before}
          modified={file.after}
          sideBySide={false}
          editable={false}
          wrap={file.name.endsWith('.md')}
          hunks={[]}
          activeHunk={null}
          onSelectHunk={() => {}}
          onDirty={() => {}}
          onSave={() => {}}
          handle={handle}
        />
      </div>
    </div>
  );
}

function Mono({ items }: { items: string[] }) {
  return <code className="font-mono text-[12px] text-white">{items.join(', ')}</code>;
}

const LEVELS = { allow: 'Runs', ask: 'Asks first', deny: 'Refused', off: 'Off' } as const;

function ClankDetails({ clank }: { clank: ClankPreview }) {
  const place =
    clank.kind === 'maker'
      ? `Makes ${clank.outputs.join(', ')} tickets, in the ${clank.stage} stage.`
      : `Checks ${clank.appliesTo.join(', ')} tickets${clank.after ? `, after ${clank.after}` : ''}, in a stage of its own called ${clank.stage}.`;
  const backTo = clank.bounceTo.map((who) => (who === 'maker' ? "the ticket's maker" : who));
  const capped = clank.tools.filter((tool) => tool.asks === 'allow' && tool.starts === 'ask');
  return (
    <>
      <Panel
        title={`${clank.name}, ${clank.role}`}
        description={`${place}${backTo.length ? ` It can send work back to ${backTo.join(', ')}.` : ''}`}
      >
        <div className="flex flex-col gap-1.5">
          <Heading>Tools it asks for, and how each starts here</Heading>
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
            {clank.tools.map((tool) => (
              <li key={tool.name} className="flex items-center gap-3 px-3.5 py-1.5">
                <code className="flex-1 font-mono text-[12.5px] text-white">{tool.name}</code>
                {tool.asks !== tool.starts && (
                  <span className="text-[11px] text-dim">its doc says {tool.asks}</span>
                )}
                <Badge tone={tool.starts === 'allow' ? 'dim' : 'lavender'}>
                  {LEVELS[tool.starts]}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-dim">
            {capped.length > 0
              ? `Its doc allows ${capped.length} ${capped.length === 1 ? 'tool' : 'tools'} that change things. A clank from a marketplace can't give itself that: they start at ask, and you can change each on its profile.`
              : 'Nothing above read starts higher than ask, whatever a doc says. You can change each on its profile.'}{' '}
            With approvals set to risky calls only, a tool that asks still runs everyday work in its
            own worktree without stopping.
          </p>
        </div>
        <p className="text-[13px] text-dim">
          It wants a model with {clank.needs.join(' and ') || 'no special abilities'} and{' '}
          {Math.round(clank.minContext / 1024)}K of context. Its prompt is about{' '}
          {clank.tokens.toLocaleString('en')} tokens with the crew rules.
          {clank.integrations.length > 0 &&
            ` It expects these integrations: ${clank.integrations.join(', ')}.`}
        </p>
      </Panel>
      <Panel
        title="Its priming doc, in full"
        description="Everything it's told. The part between the --- lines configures the app and never reaches the model."
      >
        <Source text={clank.doc} tall />
      </Panel>
    </>
  );
}

function IntegrationDetails(props: {
  integration: IntegrationPreview;
  freshHosts: string[];
  freshOperations: string[];
}) {
  const { integration } = props;
  return (
    <>
      <Panel
        title={`${integration.name}: what it can reach`}
        description={
          integration.kind === 'mcp'
            ? 'It runs a program on your computer. clanks pins it to one exact version and checks it against npm, but a program can do anything a program can.'
            : 'A manifest over an OpenAPI description: no code from the package runs. Your key goes only to these hosts.'
        }
      >
        <div className="flex flex-col gap-1.5">
          <Heading>Hosts</Heading>
          <Hosts hosts={integration.hosts} fresh={props.freshHosts} />
        </div>
        <p className="text-[13px] text-dim">Signing in: {integration.auth}.</p>
        {integration.command && (
          <div className="flex flex-col gap-1.5">
            <Heading>The command it runs</Heading>
            <Source text={integration.command} />
          </div>
        )}
        {integration.operations.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Heading>Operations, and what each takes</Heading>
            <Operations
              operations={integration.operations}
              fresh={props.freshOperations}
              limit={12}
            />
          </div>
        )}
      </Panel>
      {integration.guide && (
        <Panel
          title="What clanks are told about it"
          description="Added to the prompt of each clank you let use it."
        >
          <Source text={integration.guide} />
        </Panel>
      )}
      <Panel title="Its manifest, as written">
        <Source text={integration.manifest} tall />
      </Panel>
    </>
  );
}
