import type { McpServerInput, McpServerStatus, Settings } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useState } from 'react';
import { useCrew } from '../../lib/crew';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { Badge, Button, Dot, ErrorText, Panel, inputClass } from '../ui';

const SEARCH_KEYS = { brave: 'search:brave', tavily: 'search:tavily' } as const;

/** Where `web_search` searches. Without one, clanks get no search tool. */
export function WebSearchPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
    }),
  );
  const [url, setUrl] = useState<string | null>(null);
  const backend = settings.data?.webSearch ?? 'none';
  if (!settings.data) return null;

  return (
    <Panel
      title="Web search"
      description="For clanks' web_search tool. Without a backend, clanks can still fetch pages they know the address of."
    >
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Search backend">
        {(
          [
            ['none', 'None'],
            ['searxng', 'SearXNG'],
            ['brave', 'Brave Search'],
            ['tavily', 'Tavily'],
          ] as [Settings['webSearch'], string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={backend === value}
            onClick={() => update.mutate({ webSearch: value })}
            className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors ${backend === value ? 'border-accent/50 bg-accent/10 text-white' : 'border-line text-dim hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {backend === 'searxng' && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url !== null) update.mutate({ searxngUrl: url.trim() });
          }}
        >
          <input
            aria-label="SearXNG address"
            className={`${inputClass} flex-1 font-mono text-[13px]`}
            placeholder="http://localhost:8888"
            value={url ?? settings.data.searxngUrl}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button type="submit" disabled={url === null || url.trim() === settings.data.searxngUrl}>
            Save
          </Button>
        </form>
      )}
      {(backend === 'brave' || backend === 'tavily') && (
        <SearchKey refName={SEARCH_KEYS[backend]} />
      )}
      {backend === 'searxng' && (
        <p className="text-[13px] text-dim">
          Your own instance, with the JSON format turned on in its settings.
        </p>
      )}
      {update.error && <ErrorText>{update.error.message}</ErrorText>}
    </Panel>
  );
}

function SearchKey({ refName }: { refName: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const has = useQuery(trpc.secrets.has.queryOptions(refName));
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.secrets.has.queryKey(refName) });
  const save = useMutation(
    trpc.secrets.set.mutationOptions({
      onSuccess: () => {
        setKey('');
        refresh();
      },
    }),
  );
  const remove = useMutation(trpc.secrets.delete.mutationOptions({ onSuccess: refresh }));
  return has.data ? (
    <div className="flex items-center justify-between gap-4">
      <p className="flex items-center gap-2 text-sm">
        <Dot tone="mint" /> A key is saved in your keychain.
      </p>
      <Button size="sm" variant="ghost" onClick={() => remove.mutate(refName)}>
        Remove
      </Button>
    </div>
  ) : (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ ref: refName, value: key.trim() });
      }}
    >
      <input
        type="password"
        aria-label="API key"
        autoComplete="off"
        className={`${inputClass} flex-1 font-mono text-[13px]`}
        placeholder="API key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <Button type="submit" disabled={!key.trim() || save.isPending}>
        Save
      </Button>
      {save.error && <ErrorText>{save.error.message}</ErrorText>}
    </form>
  );
}

/** Every "always allow" given from an approval prompt, by project. */
export function RulesPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const rules = useQuery(trpc.tools.rules.queryOptions());
  const remove = useMutation(
    trpc.tools.deleteRule.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.tools.rules.queryKey() }),
    }),
  );
  return (
    <Panel
      title="Always allowed"
      description="What you allowed for good from an approval prompt. Each applies to every clank, in that project only. * matches anything."
    >
      {rules.data?.length === 0 ? (
        <p className="text-sm text-dim">
          Nothing yet. Choose "Always allow" on an approval to add one.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {rules.data?.map((rule) => (
            <li key={rule.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-sm">
                  <code className="font-mono text-[12.5px]">{rule.tool}</code>
                  <code className="truncate rounded-md bg-white/[0.06] px-1.5 font-mono text-[12px] text-white/85">
                    {rule.pattern}
                  </code>
                </span>
                <span className="truncate text-[12px] text-dim" title={rule.scope}>
                  in {rule.scope}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(rule.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** MCP servers: tools from other programs, attached to the clanks that should have them. */
export function McpPanel() {
  const trpc = useTRPC();
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [editing, setEditing] = useState<McpServerStatus | 'new' | null>(null);
  useSubscription(trpc.mcp.live.subscriptionOptions(undefined, { onData: setServers }));

  return (
    <Panel
      title="MCP servers"
      description="Give clanks tools from any MCP server: a program clanks starts, or one at an address. A server runs code on your machine, so add only ones you trust. Its tools ask before every call unless you change that on the clank's profile."
      actions={
        editing === null && (
          <Button size="sm" onClick={() => setEditing('new')}>
            Add a server
          </Button>
        )
      }
    >
      {servers.length === 0 && editing === null && <p className="text-sm text-dim">None yet.</p>}
      <ul className="flex flex-col gap-3">
        {servers.map((server) =>
          editing !== 'new' && editing?.id === server.id ? (
            <li key={server.id}>
              <McpForm server={server} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <McpRow key={server.id} server={server} onEdit={() => setEditing(server)} />
          ),
        )}
      </ul>
      {editing === 'new' && <McpForm server={null} onDone={() => setEditing(null)} />}
    </Panel>
  );
}

function McpRow({ server, onEdit }: { server: McpServerStatus; onEdit: () => void }) {
  const trpc = useTRPC();
  const crew = useCrew();
  const test = useMutation(trpc.mcp.test.mutationOptions());
  const tone = { idle: 'dim', connecting: 'lavender', ready: 'mint', failed: 'rose' } as const;
  const stateText = {
    idle: 'Starts when a clank needs it',
    connecting: 'Starting…',
    ready: `${server.tools.length} tools`,
    failed: 'Failed to start',
  }[server.state];
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-line bg-black/20 px-4 py-3">
      <div className="flex items-center gap-3">
        <Dot tone={tone[server.state]} live={server.state === 'connecting'} />
        <span className="text-sm font-medium">{server.name}</span>
        <span className="text-[12px] text-dim">{stateText}</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={test.isPending}
          onClick={() => test.mutate(server.id)}
        >
          {server.state === 'ready' ? 'Restart' : 'Start'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
      </div>
      <code
        className="truncate font-mono text-[12px] text-dim"
        title={
          server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url
        }
      >
        {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
      </code>
      <div className="flex flex-wrap items-center gap-1.5">
        {server.clanks.length === 0 ? (
          <span className="text-[12px] text-amber-200">Not attached to any clank yet.</span>
        ) : (
          server.clanks.map((id) => {
            const clank = crew.find((c) => c.id === id);
            return clank ? (
              <span
                key={id}
                className="flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-[12px]"
              >
                <Avatar colour={clank.avatar} size="xs" />
                {clank.name}
              </span>
            ) : null;
          })
        )}
        {server.tools.slice(0, 8).map((tool) => (
          <Badge key={tool.fullName}>{tool.name}</Badge>
        ))}
        {server.tools.length > 8 && (
          <span className="text-[12px] text-dim">+{server.tools.length - 8}</span>
        )}
      </div>
      {server.error && <ErrorText>{server.error}</ErrorText>}
    </li>
  );
}

function McpForm({ server, onDone }: { server: McpServerStatus | null; onDone: () => void }) {
  const trpc = useTRPC();
  const crew = useCrew();
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(
    server ? [server.command, ...server.args].map(quote).join(' ') : '',
  );
  const [url, setUrl] = useState(server?.url ?? '');
  const [secrets, setSecrets] = useState<string | null>(server ? null : '');
  const [clanks, setClanks] = useState<string[]>(server?.clanks ?? ['forge']);
  const add = useMutation(trpc.mcp.add.mutationOptions({ onSuccess: onDone }));
  const update = useMutation(trpc.mcp.update.mutationOptions({ onSuccess: onDone }));
  const remove = useMutation(trpc.mcp.remove.mutationOptions({ onSuccess: onDone }));
  const error = [add, update, remove].find((m) => m.error)?.error;

  const submit = () => {
    const [cmd = '', ...args] = splitCommand(command);
    const input: McpServerInput = {
      name: name.trim(),
      transport,
      command: transport === 'stdio' ? cmd : '',
      args: transport === 'stdio' ? args : [],
      url: transport === 'http' ? url.trim() : '',
      secrets: secrets === null ? null : parseSecrets(secrets, transport === 'http' ? ':' : '='),
      clanks,
    };
    if (server) update.mutate({ id: server.id, server: input });
    else add.mutate(input);
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-2xl border border-accent/30 bg-black/20 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex gap-2">
        <input
          autoFocus
          aria-label="Name"
          placeholder="Name, such as GitHub"
          className={`${inputClass} flex-1`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          aria-label="How clanks reaches it"
          className={`${inputClass} w-44`}
          value={transport}
          onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
        >
          <option value="stdio">A command to run</option>
          <option value="http">An address</option>
        </select>
      </div>
      {transport === 'stdio' ? (
        <input
          aria-label="Command"
          placeholder="npx -y @modelcontextprotocol/server-github"
          className={`${inputClass} font-mono text-[13px]`}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
      ) : (
        <input
          aria-label="Address"
          placeholder="https://example.com/mcp"
          className={`${inputClass} font-mono text-[13px]`}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      )}
      {secrets === null ? (
        <p className="flex items-center gap-2 text-[13px] text-dim">
          {server?.secretNames.length
            ? `Kept in your keychain: ${server.secretNames.join(', ')}.`
            : `No ${transport === 'stdio' ? 'environment variables' : 'headers'}.`}
          <button
            type="button"
            className="text-white/80 hover:text-white"
            onClick={() => setSecrets('')}
          >
            Replace
          </button>
        </p>
      ) : (
        <textarea
          aria-label={transport === 'stdio' ? 'Environment variables' : 'Headers'}
          placeholder={
            transport === 'stdio'
              ? 'Environment variables, one per line: GITHUB_TOKEN=…'
              : 'Headers, one per line: Authorization: Bearer …'
          }
          rows={3}
          spellCheck={false}
          className="rounded-xl border border-line bg-black/30 px-3.5 py-2.5 font-mono text-[12.5px] text-white placeholder:text-white/30 focus:border-accent/60 focus:outline-none"
          value={secrets}
          onChange={(e) => setSecrets(e.target.value)}
        />
      )}
      <fieldset className="flex flex-wrap gap-1.5">
        <legend className="mb-1.5 text-[12px] text-dim">Clanks that get its tools</legend>
        {crew.map((clank) => {
          const on = clanks.includes(clank.id);
          return (
            <button
              key={clank.id}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setClanks(on ? clanks.filter((c) => c !== clank.id) : [...clanks, clank.id])
              }
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${on ? 'border-accent/50 bg-accent/10 text-white' : 'border-line text-dim hover:text-white'}`}
            >
              <Avatar colour={clank.avatar} size="xs" />
              {clank.name}
            </button>
          );
        })}
      </fieldset>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!name.trim() || add.isPending || update.isPending}
        >
          {server ? 'Save' : 'Add'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <span className="flex-1" />
        {server && (
          <Button size="sm" variant="danger" onClick={() => remove.mutate(server.id)}>
            Remove
          </Button>
        )}
      </div>
      {error && <ErrorText>{error.message}</ErrorText>}
    </form>
  );
}

/** A command line split into words, honouring quotes. */
function splitCommand(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3]!);
  }
  return words;
}

function quote(word: string): string {
  return /\s/.test(word) ? `"${word}"` : word;
}

/** `KEY=value` or `Header: value` lines. */
function parseSecrets(text: string, separator: '=' | ':'): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    secrets[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return secrets;
}
