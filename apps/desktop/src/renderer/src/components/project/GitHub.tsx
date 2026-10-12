import type { GitHubRepo, GitHubStatus } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatAgo } from '../../lib/format';
import { useGitHub } from '../../lib/github';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, Dot, ErrorText, Switch, inputClass } from '../ui';

const NEW_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo&description=clanks';

/** Signing in: with a code on github.com when the app can, or with a token. */
export function GitHubSignIn() {
  const trpc = useTRPC();
  const status = useGitHub();
  const [token, setToken] = useState('');
  const withToken = useMutation(
    trpc.github.signInWithToken.mutationOptions({ onSuccess: () => setToken('') }),
  );
  const start = useMutation(trpc.github.startDeviceFlow.mutationOptions());
  const cancel = useMutation(trpc.github.cancelDeviceFlow.mutationOptions());
  if (!status) return null;
  const device = status.device;
  const error = withToken.error ?? start.error;

  return (
    <div className="flex flex-col gap-3">
      {status.deviceFlow &&
        (device ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-accent/25 bg-accent/[0.06] p-4">
            <p className="flex items-center gap-2 text-sm text-white/90">
              <Dot tone="lavender" live /> Enter this code on GitHub, then come back:
            </p>
            <p className="font-mono text-2xl tracking-[0.25em] text-white select-all">
              {device.userCode}
            </p>
            <span className="flex gap-2">
              <a
                href={device.verificationUri}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-8 items-center rounded-full bg-white px-3 text-[13px] font-medium text-black hover:bg-white/90"
              >
                Open github.com
              </a>
              <Button size="sm" variant="ghost" onClick={() => cancel.mutate()}>
                Cancel
              </Button>
            </span>
          </div>
        ) : (
          <Button
            variant="primary"
            className="self-start"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            Sign in with GitHub
          </Button>
        ))}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) withToken.mutate(token.trim());
        }}
      >
        <p className="text-sm text-dim">
          {status.deviceFlow ? 'Or paste' : 'Paste'} a GitHub token with access to the repositories
          you want the crew to work on.{' '}
          <a
            href={NEW_TOKEN_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            Make one on github.com
          </a>{' '}
          with the <code className="font-mono text-[12px] text-white">repo</code> scope. It's kept
          in your keychain and only ever sent to GitHub.
        </p>
        <span className="flex gap-2">
          <input
            type="password"
            aria-label="GitHub token"
            placeholder="ghp_… or github_pat_…"
            autoComplete="off"
            className={`${inputClass} flex-1 font-mono`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <Button type="submit" disabled={!token.trim() || withToken.isPending}>
            {withToken.isPending ? 'Checking…' : 'Sign in'}
          </Button>
        </span>
      </form>
      {error && <ErrorText>{error.message}</ErrorText>}
      {status.error && <ErrorText>{status.error}</ErrorText>}
    </div>
  );
}

/** The signed-in account, with a way out. */
export function GitHubAccount({ status }: { status: GitHubStatus }) {
  const trpc = useTRPC();
  const signOut = useMutation(trpc.github.signOut.mutationOptions());
  return (
    <span className="flex items-center gap-2 text-sm text-dim">
      <Dot tone="mint" />
      Signed in as <span className="text-white">@{status.login}</span>
      <Button size="sm" variant="ghost" onClick={() => signOut.mutate()}>
        Sign out
      </Button>
    </span>
  );
}

/** Picks one of the user's repositories, or makes a new one. Signs in first if it must. */
export function RepoPicker(props: {
  value: GitHubRepo | null;
  onChange: (repo: GitHubRepo) => void;
  /** A name for a new repository. */
  suggestedName: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useGitHub();
  const repos = useQuery(
    trpc.github.repos.queryOptions(undefined, { enabled: !!status?.signedIn }),
  );
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState(true);
  const create = useMutation(
    trpc.github.createRepo.mutationOptions({
      onSuccess: (repo) => {
        setCreating(false);
        queryClient.setQueryData(trpc.github.repos.queryKey(), (list: GitHubRepo[] | undefined) => [
          repo,
          ...(list ?? []),
        ]);
        props.onChange(repo);
      },
    }),
  );
  if (!status) return null;
  if (!status.signedIn) return <GitHubSignIn />;

  const shown = (repos.data ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <GitHubAccount status={status} />
        <Button
          size="sm"
          onClick={() => {
            setName(props.suggestedName);
            setCreating((c) => !c);
          }}
        >
          New repository
        </Button>
      </div>
      {creating && (
        <form
          className="flex flex-col gap-3 rounded-2xl border border-line bg-black/20 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name: name.trim(), description: '', private: secret });
          }}
        >
          <span className="flex gap-2">
            <input
              autoFocus
              aria-label="Repository name"
              className={`${inputClass} flex-1 font-mono`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
              {create.isPending ? 'Making it…' : 'Make it'}
            </Button>
          </span>
          <label className="flex items-center gap-3 text-sm text-dim">
            <Switch checked={secret} onChange={setSecret} label="Private" /> Private, so only you
            and people you invite see it
          </label>
          {create.error && <ErrorText>{create.error.message}</ErrorText>}
        </form>
      )}
      <input
        aria-label="Find a repository"
        placeholder="Find a repository"
        className={inputClass}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {repos.error && <ErrorText>{repos.error.message}</ErrorText>}
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
        {!repos.data && !repos.error && <li className="text-sm text-dim">Loading…</li>}
        {repos.data && shown.length === 0 && (
          <li className="text-sm text-dim">No repositories match.</li>
        )}
        {shown.map((repo) => {
          const picked = props.value?.fullName === repo.fullName;
          return (
            <li key={repo.fullName}>
              <button
                type="button"
                aria-pressed={picked}
                onClick={() => props.onChange(repo)}
                className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${picked ? 'border-accent/50 bg-accent/[0.08]' : 'border-line hover:bg-white/[0.04]'}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                  {repo.fullName}
                </span>
                {repo.private && <Badge>private</Badge>}
                {repo.pushedAt && (
                  <span className="shrink-0 font-mono text-[11px] text-dim">
                    {formatAgo(repo.pushedAt)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
