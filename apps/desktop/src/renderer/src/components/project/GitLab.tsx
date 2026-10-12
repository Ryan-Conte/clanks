import { DEFAULT_GITLAB_URL, type GitHubRepo, type GitLabStatus } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatAgo } from '../../lib/format';
import { useGitLab } from '../../lib/github';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, Dot, ErrorText, Switch, inputClass } from '../ui';

/** Signing in with a token, on gitlab.com or a GitLab a team hosts. */
export function GitLabSignIn() {
  const trpc = useTRPC();
  const [token, setToken] = useState('');
  const [own, setOwn] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const signIn = useMutation(trpc.gitlab.signIn.mutationOptions({ onSuccess: () => setToken('') }));
  const host = (own && baseUrl.trim()) || DEFAULT_GITLAB_URL;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim())
          signIn.mutate({ token: token.trim(), baseUrl: own ? baseUrl.trim() : '' });
      }}
    >
      <p className="text-sm text-dim">
        Paste a GitLab access token with access to the projects you want the crew to work on.{' '}
        <a
          href={`${host.replace(/\/+$/, '')}/-/user_settings/personal_access_tokens?name=clanks&scopes=api,write_repository`}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent hover:underline"
        >
          Make one on {host.replace(/^https?:\/\//, '')}
        </a>{' '}
        with the <code className="font-mono text-[12px] text-white">api</code> and{' '}
        <code className="font-mono text-[12px] text-white">write_repository</code> scopes. It's kept
        in your keychain and only ever sent to that GitLab.
      </p>
      <label className="flex items-center gap-3 text-sm text-dim">
        <Switch checked={own} onChange={setOwn} label="A GitLab of our own" /> It's a GitLab we
        host, not gitlab.com
      </label>
      {own && (
        <input
          aria-label="GitLab address"
          placeholder="https://gitlab.example.com"
          className={`${inputClass} font-mono`}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      )}
      <span className="flex gap-2">
        <input
          type="password"
          aria-label="GitLab token"
          placeholder="glpat-…"
          autoComplete="off"
          className={`${inputClass} flex-1 font-mono`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button
          type="submit"
          disabled={!token.trim() || signIn.isPending || (own && !baseUrl.trim())}
        >
          {signIn.isPending ? 'Checking…' : 'Sign in'}
        </Button>
      </span>
      {signIn.error && <ErrorText>{signIn.error.message}</ErrorText>}
    </form>
  );
}

/** The signed-in account, with a way out. */
export function GitLabAccount({ status }: { status: GitLabStatus }) {
  const trpc = useTRPC();
  const signOut = useMutation(trpc.gitlab.signOut.mutationOptions());
  return (
    <span className="flex items-center gap-2 text-sm text-dim">
      <Dot tone="mint" />
      Signed in as <span className="text-white">@{status.login}</span>
      {status.baseUrl !== DEFAULT_GITLAB_URL && (
        <span className="font-mono text-[12px]">
          on {status.baseUrl.replace(/^https?:\/\//, '')}
        </span>
      )}
      <Button size="sm" variant="ghost" onClick={() => signOut.mutate()}>
        Sign out
      </Button>
    </span>
  );
}

/** Picks one of the user's GitLab projects, or makes a new one. Signs in first if it must. */
export function GitLabRepoPicker(props: {
  value: GitHubRepo | null;
  onChange: (repo: GitHubRepo) => void;
  /** A name for a new project. */
  suggestedName: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useGitLab();
  const repos = useQuery(
    trpc.gitlab.repos.queryOptions(undefined, { enabled: !!status?.signedIn }),
  );
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState(true);
  const create = useMutation(
    trpc.gitlab.createRepo.mutationOptions({
      onSuccess: (repo) => {
        setCreating(false);
        queryClient.setQueryData(trpc.gitlab.repos.queryKey(), (list: GitHubRepo[] | undefined) => [
          repo,
          ...(list ?? []),
        ]);
        props.onChange(repo);
      },
    }),
  );
  if (!status) return null;
  if (!status.signedIn) return <GitLabSignIn />;

  const shown = (repos.data ?? []).filter((r) =>
    r.fullName.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <GitLabAccount status={status} />
        <Button
          size="sm"
          onClick={() => {
            setName(props.suggestedName);
            setCreating((c) => !c);
          }}
        >
          New project
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
              aria-label="Project name"
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
        aria-label="Find a project"
        placeholder="Find a project"
        className={inputClass}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {repos.error && <ErrorText>{repos.error.message}</ErrorText>}
      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
        {!repos.data && !repos.error && <li className="text-sm text-dim">Loading…</li>}
        {repos.data && shown.length === 0 && (
          <li className="text-sm text-dim">No projects match.</li>
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
