import type { ConnectInput, ConnectionInfo, IntegrationInfo } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useCrew } from '../../lib/crew';
import { useIntegrations } from '../../lib/integrations';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { Publish } from '../integrations/Publish';
import { Heading, Hosts, ModeBadge, Operations, Source } from '../integrations/shared';
import { Badge, Button, Dot, ErrorText, Panel, Switch, inputClass } from '../ui';

const SOURCES: Record<IntegrationInfo['source'], string> = {
  bundled: 'Built in',
  marketplace: 'Marketplace',
  local: 'Yours',
};

/**
 * The services the crew can use, and the accounts connected to each. Connecting one only makes it
 * available: which projects and clanks use it is set in each project.
 */
export function IntegrationsPanel() {
  const trpc = useTRPC();
  const { go } = useNav();
  const snapshot = useIntegrations();
  const add = useMutation(trpc.integrations.addFromFolder.mutationOptions());

  return (
    <Panel
      title="Integrations"
      description="Services the crew can use: payments, docs, chat, hosting, analytics. A key you connect stays in your keychain, goes only to the hosts listed, and never reaches a model. Reads run; changes ask; anything that spends money, publishes or contacts people asks every time. Turn each on per project, in the project's settings."
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => go({ page: 'marketplace' })}>
            Marketplace
          </Button>
          <Button size="sm" disabled={add.isPending} onClick={() => add.mutate()}>
            Add from a folder
          </Button>
        </>
      }
      testId="integrations"
    >
      {add.error && (
        <p className="text-sm whitespace-pre-wrap text-rose-300">{add.error.message}</p>
      )}
      {snapshot?.problems.map((problem) => (
        <p
          key={problem}
          className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-200"
        >
          An installed integration can't be read. {problem}
        </p>
      ))}
      {!snapshot ? (
        <p className="text-sm text-dim">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {snapshot.integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              signingIn={
                snapshot.oauth?.integrationId === integration.id ? snapshot.oauth.url : null
              }
              oauthError={snapshot.oauthError}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function IntegrationCard(props: {
  integration: IntegrationInfo;
  signingIn: string | null;
  oauthError: string | null;
}) {
  const { integration } = props;
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  // How many accounts there were when the form was opened: it closes itself once another is
  // there, which is how a sign-in that finishes in the browser closes it.
  const [opened, setOpened] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const remove = useMutation(trpc.integrations.remove.mutationOptions());
  const connected = integration.connections.length;
  const connecting = opened === connected;
  const server = integration.server;

  return (
    <li
      data-integration={integration.id}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-black/20 px-4 py-3.5"
    >
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{integration.name}</span>
            <Badge tone={integration.source === 'local' ? 'mint' : 'dim'}>
              {SOURCES[integration.source]}
              {integration.version ? ` ${integration.version}` : ''}
            </Badge>
            {integration.kind === 'mcp' && <Badge tone="amber">Runs code</Badge>}
            {connected > 0 && (
              <span className="flex items-center gap-1.5 text-[12px] text-accent-2">
                <Dot tone="mint" /> {connected === 1 ? '1 account' : `${connected} accounts`}
              </span>
            )}
          </span>
          <span className="text-[13px] text-dim">{integration.summary}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Less' : 'Details'}
        </Button>
        {integration.kind === 'declarative' && !connecting && !integration.disabled && (
          <Button size="sm" onClick={() => setOpened(connected)}>
            Connect{connected > 0 ? ' another' : ''}
          </Button>
        )}
      </div>

      {integration.disabled && <ErrorText>{integration.disabled}</ErrorText>}

      {integration.connections.map((connection) => (
        <ConnectionRow key={connection.id} connection={connection} integration={integration} />
      ))}

      {connecting && (
        <ConnectForm
          integration={integration}
          signingIn={props.signingIn}
          oauthError={props.oauthError}
          onDone={() => setOpened(null)}
        />
      )}

      {server && !integration.disabled && <ServerSetup integration={integration} />}

      {open && (
        <div className="flex flex-col gap-4 border-t border-line pt-3.5">
          <div className="flex flex-col gap-1.5">
            <Heading>Hosts it calls, and nothing else</Heading>
            <Hosts hosts={integration.hosts} />
            {integration.kind === 'mcp' && (
              <p className="text-[12px] text-amber-200">
                It runs a program on this computer, which can reach anything a program can. The
                hosts above are what its author says it talks to; they can't be enforced.
              </p>
            )}
          </div>
          {integration.operations.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Heading>What clanks can do with it</Heading>
              <Operations operations={integration.operations} />
            </div>
          )}
          {integration.guide && (
            <div className="flex flex-col gap-1.5">
              <Heading>
                What clanks are told about it · about {integration.guideTokens} tokens
              </Heading>
              <Source text={integration.guide} />
            </div>
          )}
          {integration.source === 'local' && (
            <div className="flex flex-col gap-3">
              <span className="flex gap-2">
                <Button size="sm" onClick={() => setPublishing((p) => !p)}>
                  {publishing ? 'Close' : 'Publish to the marketplace…'}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(integration.id)}
                >
                  Remove
                </Button>
              </span>
              {publishing && <Publish kind="integration" id={integration.id} />}
              {remove.error && <ErrorText>{remove.error.message}</ErrorText>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ConnectionRow(props: { connection: ConnectionInfo; integration: IntegrationInfo }) {
  const { connection, integration } = props;
  const trpc = useTRPC();
  const check = useMutation(trpc.integrations.check.mutationOptions());
  const disconnect = useMutation(trpc.integrations.disconnect.mutationOptions());
  const setMode = useMutation(trpc.integrations.setMode.mutationOptions());
  const allow = useMutation(trpc.integrations.allowHosts.mutationOptions());
  const [confirming, setConfirming] = useState(false);
  const error = disconnect.error ?? setMode.error ?? allow.error ?? check.error;

  return (
    <div
      data-connection={connection.id}
      className="flex flex-col gap-2 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <Dot tone="mint" />
        <span className="text-sm">{connection.label}</span>
        <ModeBadge mode={connection.mode} />
        {connection.account && connection.account !== connection.label && (
          <span className="text-[12px] text-dim">as {connection.account}</span>
        )}
        <span className="flex-1" />
        {!integration.auth.detectsMode && (
          <button
            type="button"
            disabled={setMode.isPending}
            onClick={() =>
              setMode.mutate({
                id: connection.id,
                mode: connection.mode === 'live' ? 'test' : 'live',
              })
            }
            className="text-[12px] text-dim hover:text-white"
            title={`${integration.name} can't tell a test account from a real one, so you say which this is.`}
          >
            {connection.mode === 'live' ? "It's a test account" : "It's the real account"}
          </button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={check.isPending}
          onClick={() => check.mutate(connection.id)}
        >
          {check.isPending ? 'Checking…' : 'Check it works'}
        </Button>
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="danger"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(connection.id)}
            >
              Disconnect
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Disconnect…
          </Button>
        )}
      </div>
      {connection.newHosts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-amber-200">
          <span>
            This version of {integration.name} also calls hosts it didn't when you connected. Your
            key isn't sent to them until you say so:
          </span>
          <Hosts hosts={connection.newHosts} fresh={connection.newHosts} />
          <Button size="sm" disabled={allow.isPending} onClick={() => allow.mutate(connection.id)}>
            Allow them
          </Button>
        </div>
      )}
      {check.data && (
        <p className={`text-[13px] ${check.data.ok ? 'text-accent-2' : 'text-rose-300'}`}>
          {check.data.message}
        </p>
      )}
      {error && <ErrorText>{error.message}</ErrorText>}
    </div>
  );
}

function ConnectForm(props: {
  integration: IntegrationInfo;
  signingIn: string | null;
  oauthError: string | null;
  onDone: () => void;
}) {
  const { integration } = props;
  const trpc = useTRPC();
  const { auth } = integration;
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [test, setTest] = useState(false);
  const connect = useMutation(
    trpc.integrations.connect.mutationOptions({ onSuccess: props.onDone }),
  );
  const start = useMutation(trpc.integrations.startOAuth.mutationOptions());
  const cancel = useMutation(trpc.integrations.cancelOAuth.mutationOptions());
  const oauth = auth.type === 'oauth2';
  const input: ConnectInput = {
    integrationId: integration.id,
    label: label.trim(),
    secret: secret.trim(),
    username: username.trim(),
    settings,
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    ...(auth.detectsMode ? {} : { mode: test ? 'test' : 'live' }),
  };
  const ready = oauth
    ? !auth.ownClient || clientId.trim() !== ''
    : auth.type === 'none' || secret.trim() !== '';
  const error = connect.error ?? start.error;

  if (props.signingIn) {
    return (
      <div className="flex flex-col gap-3 rounded-2xl border border-accent/25 bg-accent/[0.06] p-4">
        <p className="flex items-center gap-2 text-sm text-white/90">
          <Dot tone="lavender" live /> Finish signing in to {integration.name} in your browser. This
          closes by itself when you have.
        </p>
        <span className="flex gap-2">
          <a
            href={props.signingIn}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-8 items-center rounded-full bg-white px-3 text-[13px] font-medium text-black hover:bg-white/90"
          >
            Open the sign-in page again
          </a>
          <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        </span>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-accent/30 bg-black/20 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (oauth) start.mutate(input, { onSuccess: () => undefined });
        else connect.mutate(input);
      }}
    >
      {auth.hint && <p className="text-[13px] text-dim">{auth.hint}</p>}
      {integration.settings.map((setting) => (
        <label key={setting.id} className="flex flex-col gap-1 text-[13px]">
          <span className="text-dim">
            {setting.label}
            {setting.hint ? `. ${setting.hint}` : ''}
          </span>
          <input
            className={inputClass}
            placeholder={setting.placeholder}
            value={settings[setting.id] ?? ''}
            onChange={(e) => setSettings({ ...settings, [setting.id]: e.target.value })}
          />
        </label>
      ))}
      {auth.type === 'basic' && (
        <input
          aria-label="User name"
          placeholder="User name"
          autoComplete="off"
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      )}
      {(auth.type === 'api_key' || auth.type === 'basic') && (
        <input
          type="password"
          autoFocus
          aria-label={auth.label}
          placeholder={auth.label}
          autoComplete="off"
          className={`${inputClass} font-mono text-[13px]`}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      )}
      {oauth && auth.ownClient && (
        <div className="flex gap-2">
          <input
            aria-label="OAuth client id"
            placeholder="Client id"
            autoComplete="off"
            className={`${inputClass} flex-1 font-mono text-[13px]`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            type="password"
            aria-label="OAuth client secret"
            placeholder="Client secret, if it has one"
            autoComplete="off"
            className={`${inputClass} flex-1 font-mono text-[13px]`}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
      )}
      {oauth && auth.scopes.length > 0 && (
        <p className="text-[12px] text-dim">
          It asks for: <span className="font-mono text-white/70">{auth.scopes.join(', ')}</span>
        </p>
      )}
      <input
        aria-label="A name for this account"
        placeholder="A name for this account, such as Surf shop. Optional."
        className={inputClass}
        maxLength={60}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      {auth.detectsMode ? (
        <p className="text-[12px] text-dim">
          {integration.name} keys say whether they're for test mode or the real account, and clanks
          shows which on every ticket and approval.
        </p>
      ) : (
        <label className="flex items-start justify-between gap-6">
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] text-white/90">This is a test account</span>
            <span className="text-[12px] text-dim">
              {integration.name} can't tell, so you say. Unless you turn this on it's treated as the
              real thing, where every change asks you first, every time.
            </span>
          </span>
          <Switch checked={test} label="This is a test account" onChange={setTest} />
        </label>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!ready || connect.isPending || start.isPending}
        >
          {oauth
            ? `Sign in to ${integration.name}`
            : connect.isPending
              ? 'Checking it…'
              : 'Connect'}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
      {(error ?? props.oauthError) && (
        <p className="text-sm whitespace-pre-wrap text-rose-300">
          {error?.message ?? props.oauthError}
        </p>
      )}
    </form>
  );
}

/** An MCP integration's server: what it needs, who gets its tools, and whether it runs in Docker. */
function ServerSetup({ integration }: { integration: IntegrationInfo }) {
  const trpc = useTRPC();
  const crew = useCrew();
  const server = integration.server!;
  const servers = useQuery(trpc.mcp.list.queryOptions());
  const existing = servers.data?.find((s) => s.id === server.serverId);
  const docker = useQuery(trpc.projects.docker.queryOptions());
  const [editing, setEditing] = useState(false);
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [clanks, setClanks] = useState<string[] | null>(null);
  const [inDocker, setInDocker] = useState<boolean | null>(null);
  const setUp = useMutation(
    trpc.integrations.setUpServer.mutationOptions({
      onSuccess: () => {
        setEditing(false);
        setEnv(null);
        void servers.refetch();
      },
    }),
  );
  const chosen = clanks ?? existing?.clanks ?? [];
  const useDocker = inDocker ?? server.docker;

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5">
        <code
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim"
          title={server.command}
        >
          {server.command}
        </code>
        {existing ? (
          <span className="text-[12px] text-accent-2">
            Set up{server.docker ? ', in Docker' : ''}, for{' '}
            {existing.clanks.length === 0 ? 'no clank yet' : `${existing.clanks.length} clanks`}
          </span>
        ) : (
          <span className="text-[12px] text-amber-200">Not set up yet</span>
        )}
        <Button size="sm" onClick={() => setEditing(true)}>
          {existing ? 'Change' : 'Set up'}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-accent/30 bg-black/20 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setUp.mutate({
          integrationId: integration.id,
          env: existing && env === null ? null : (env ?? {}),
          clanks: chosen,
          docker: useDocker,
        });
      }}
    >
      <p className="text-[13px] text-amber-100/90">
        This runs <code className="font-mono text-[12px] text-white">{server.pinned}</code> on your
        computer, pinned to that exact version and checked against npm when it was installed. Its
        tools ask before every call unless you change that on a clank's profile.
      </p>
      {server.env.map((variable) => (
        <label key={variable.name} className="flex flex-col gap-1 text-[13px]">
          <span className="text-dim">
            {variable.label} <code className="font-mono text-[11px]">{variable.name}</code>
          </span>
          <input
            type={variable.secret ? 'password' : 'text'}
            autoComplete="off"
            className={`${inputClass} font-mono text-[13px]`}
            placeholder={
              existing && env === null ? 'Kept in your keychain. Type to replace it.' : ''
            }
            value={env?.[variable.name] ?? ''}
            onChange={(e) => setEnv({ ...(env ?? {}), [variable.name]: e.target.value })}
          />
        </label>
      ))}
      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="mb-1.5 text-[12px] text-dim">Clanks that get its tools</legend>
        {crew.map((clank) => {
          const on = chosen.includes(clank.id);
          return (
            <button
              key={clank.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setClanks(on ? chosen.filter((c) => c !== clank.id) : [...chosen, clank.id])
              }
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${on ? 'border-accent/50 bg-accent/10 text-white' : 'border-line text-dim hover:text-white'}`}
            >
              <Avatar colour={clank.avatar} size="xs" />
              {clank.name}
            </button>
          );
        })}
      </fieldset>
      <label className="flex items-start justify-between gap-6">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] text-white/90">Run it in Docker</span>
          <span className="text-[12px] text-dim">
            In a container from <code className="font-mono">{server.dockerImage}</code>, with none
            of your files in it.{' '}
            {docker.data?.running ? '' : (docker.data?.problem ?? 'Looking for Docker…')}
          </span>
        </span>
        <Switch
          checked={useDocker}
          disabled={!useDocker && !docker.data?.running}
          label="Run it in Docker"
          onChange={setInDocker}
        />
      </label>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={setUp.isPending}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
      {setUp.error && <ErrorText>{setUp.error.message}</ErrorText>}
    </form>
  );
}
