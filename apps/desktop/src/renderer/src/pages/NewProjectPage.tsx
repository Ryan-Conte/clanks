import {
  DEFAULT_PROJECT_CREW,
  type GitHubRepo,
  LEAD_CLANK,
  type ModelChoice,
  suggestKey,
} from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { ModelPicker } from '../components/ModelPicker';
import { RepoPicker } from '../components/project/GitHub';
import { GitLabRepoPicker } from '../components/project/GitLab';
import { Button, ErrorText, FolderIcon, Switch, inputClass } from '../components/ui';
import { useCrew } from '../lib/crew';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { joinPath } from '../lib/projects';
import { useTRPC } from '../lib/trpc';

const FOLDER_NOTES = {
  ready: 'A git repository. The crew works on copies of it, each on a branch of its own.',
  not_repo:
    "Not a git repository yet. clanks will make it one and commit what's in it, so the crew can work on copies.",
  no_commits: "A repository with nothing committed yet. clanks will commit what's in it.",
  no_git: "git isn't installed. The crew needs it to work on copies of the folder.",
  missing: "That folder isn't there.",
} as const;

/** Name it, pick a workspace, pick the crew, pick the models. */
export function NewProjectPage() {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const snapshot = useModels();
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const shownKey = key ?? suggestKey(name || 'Project');
  const [source, setSource] = useState<'folder' | 'github' | 'gitlab'>('folder');
  const [folder, setFolder] = useState<string | null>(null);
  const [repo, setRepo] = useState<GitHubRepo | null>(null);
  const [into, setInto] = useState<string | null>(null);
  const [members, setMembers] = useState<Set<string>>(new Set(DEFAULT_PROJECT_CREW));
  // Crews installed from a marketplace: a set of clanks for a kind of project.
  const crews = useQuery(trpc.marketplace.crews.queryOptions()).data ?? [];
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [perClank, setPerClank] = useState(false);
  const [models, setModels] = useState<Record<string, ModelChoice>>({});

  const check = useQuery(
    trpc.projects.checkFolder.queryOptions(folder ?? '', { enabled: folder !== null }),
  );
  const cloneFolder = useQuery(
    trpc.projects.cloneFolder.queryOptions(repo?.name ?? 'repo', { enabled: repo !== null }),
  );
  const chooseFolder = useMutation(
    trpc.projects.chooseFolder.mutationOptions({ onSuccess: (path) => path && setFolder(path) }),
  );
  const chooseParent = useMutation(
    trpc.projects.chooseFolder.mutationOptions({
      onSuccess: (path) => path && repo && setInto(joinPath(path, repo.name)),
    }),
  );
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: (project) => go({ page: 'project', id: project.id, tab: 'board' }),
    }),
  );

  const clonePath = into ?? cloneFolder.data ?? null;
  const keyValid = /^[A-Z][A-Z0-9]{1,5}$/.test(shownKey);
  const workspaceReady =
    source === 'folder'
      ? folder !== null &&
        check.data !== undefined &&
        !['no_git', 'missing'].includes(check.data.status)
      : repo !== null && clonePath !== null;
  const ready = name.trim() !== '' && keyValid && workspaceReady && !create.isPending;
  const chosen = crew.filter((c) => c.id === LEAD_CLANK || members.has(c.id));

  const submit = () =>
    create.mutate({
      name: name.trim(),
      brief: brief.trim(),
      key: shownKey,
      workspace:
        source === 'folder'
          ? { kind: 'folder', path: folder! }
          : { kind: source, repo: repo!.fullName, into: clonePath! },
      crew: chosen.map((c) => c.id),
      model,
      models: perClank
        ? Object.fromEntries(
            Object.entries(models).filter(([id]) => chosen.some((c) => c.id === id)),
          )
        : {},
    });

  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">New project</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">
          Every project gets its own crew
        </h1>
        <p className="text-dim">
          Name it, give it a workspace, and pick who works on it. Atlas leads, and talks the idea
          through with you before anything is built.
        </p>
      </header>

      <Step number={1} title="Name it">
        <div className="grid grid-cols-[1fr_8rem] gap-3">
          <input
            autoFocus
            aria-label="Project name"
            placeholder="Surf shop"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="Ticket key letters"
            title="Tickets in this project are numbered with these letters"
            className={`${inputClass} font-mono uppercase`}
            value={shownKey}
            onChange={(e) =>
              setKey(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, '')
                  .slice(0, 6),
              )
            }
          />
        </div>
        <input
          aria-label="What you're making"
          placeholder="A line about what you're making: a website that sells surf boards"
          className={inputClass}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        <p className="text-[12px] text-dim">
          Tickets will be numbered{' '}
          <span className="font-mono text-white/80">{keyValid ? `${shownKey}-1` : '…'}</span>,{' '}
          <span className="font-mono text-white/80">{keyValid ? `${shownKey}-2` : '…'}</span>.
          {!keyValid && ' Use 2 to 6 letters or digits, starting with a letter.'}
        </p>
      </Step>

      <Step number={2} title="Pick a workspace">
        <div className="grid grid-cols-3 gap-2">
          <Choice active={source === 'folder'} onClick={() => setSource('folder')} title="A folder">
            A folder on this computer, for code or anything else.
          </Choice>
          {(
            [
              ['github', 'GitHub'],
              ['gitlab', 'GitLab'],
            ] as const
          ).map(([host, title]) => (
            <Choice
              key={host}
              active={source === host}
              onClick={() => {
                setSource(host);
                // A repository picked on one host isn't on the other.
                if (source !== host) setRepo(null);
              }}
              title={title}
            >
              One of your repositories, or a new one, cloned here.
            </Choice>
          ))}
        </div>
        {source === 'folder' ? (
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-3">
              <Button onClick={() => chooseFolder.mutate({ title: 'Project folder' })}>
                <FolderIcon /> {folder ? 'Choose another' : 'Choose a folder'}
              </Button>
              {folder && <span className="min-w-0 truncate font-mono text-[13px]">{folder}</span>}
            </span>
            {check.data && (
              <p
                className={`text-sm ${['no_git', 'missing'].includes(check.data.status) ? 'text-rose-300' : 'text-dim'}`}
              >
                {FOLDER_NOTES[check.data.status]}
              </p>
            )}
            {chooseFolder.error && <ErrorText>{chooseFolder.error.message}</ErrorText>}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {source === 'gitlab' ? (
              <GitLabRepoPicker
                value={repo}
                onChange={(next) => {
                  setRepo(next);
                  setInto(null);
                }}
                suggestedName={(name.trim() || 'project')
                  .toLowerCase()
                  .replace(/[^a-z0-9._-]+/g, '-')}
              />
            ) : (
              <RepoPicker
                value={repo}
                onChange={(next) => {
                  setRepo(next);
                  setInto(null);
                }}
                suggestedName={(name.trim() || 'project')
                  .toLowerCase()
                  .replace(/[^a-z0-9._-]+/g, '-')}
              />
            )}
            {repo && clonePath && (
              <span className="flex items-center gap-3 text-sm">
                <span className="text-dim">Clone into</span>
                <span className="min-w-0 truncate font-mono text-[13px]">{clonePath}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => chooseParent.mutate({ title: `Clone ${repo.name} into` })}
                >
                  Change
                </Button>
              </span>
            )}
          </div>
        )}
      </Step>

      <Step number={3} title="Pick the crew">
        {crews.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-dim">Start from a crew:</span>
            {crews.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => setMembers(new Set(preset.clanks))}
                title={`${preset.clanks.length} clanks${preset.integrations.length ? `, expecting ${preset.integrations.join(', ')}` : ''}`}
                className="rounded-full border border-line px-3 py-1 text-[13px] text-dim transition-colors hover:border-accent/50 hover:text-white"
              >
                {preset.name}
              </button>
            ))}
          </div>
        )}
        <ul className="grid grid-cols-2 gap-2">
          {crew.map((clank) => {
            const lead = clank.id === LEAD_CLANK;
            const on = lead || members.has(clank.id);
            return (
              <li key={clank.id}>
                <label
                  className={`flex h-full cursor-pointer items-start gap-3 rounded-2xl border p-3 transition-colors ${on ? 'border-accent/40 bg-accent/[0.06]' : 'border-line hover:bg-white/[0.03]'} ${lead ? 'cursor-default' : ''}`}
                >
                  <Avatar colour={clank.avatar} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-2 text-sm">
                      <span className="font-medium">{clank.name}</span>
                      <span className="text-[12px] text-dim">{clank.role}</span>
                    </span>
                    <span className="text-[12px] leading-snug text-white/60">
                      {lead ? 'Leads every project, so always in.' : clank.summary}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    className="mt-1 accent-[#b9a7ff]"
                    checked={on}
                    disabled={lead}
                    onChange={(e) =>
                      setMembers((current) => {
                        const next = new Set(current);
                        if (e.target.checked) next.add(clank.id);
                        else next.delete(clank.id);
                        return next;
                      })
                    }
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </Step>

      <Step number={4} title="Pick the models">
        <p className="text-sm text-dim">
          One model for the whole crew, or a different one for each clank. You can change these any
          time in the project's settings.
        </p>
        <ModelPicker
          value={model}
          onChange={setModel}
          emptyLabel={`Each clank's own, or the crew's model${snapshot?.crewModel ? ` (${snapshot.crewModel})` : ''}`}
        />
        <label className="flex items-center gap-3 text-sm">
          <Switch checked={perClank} onChange={setPerClank} label="A model per clank" />A model per
          clank
        </label>
        {perClank && (
          <ul className="flex flex-col gap-2">
            {chosen.map((clank) => (
              <li key={clank.id} className="grid grid-cols-[8rem_1fr] items-center gap-3">
                <span className="flex items-center gap-2 text-sm">
                  <Avatar colour={clank.avatar} size="xs" /> {clank.name}
                </span>
                <ModelPicker
                  value={models[clank.id] ?? null}
                  onChange={(choice) =>
                    setModels((current) => {
                      const next = { ...current };
                      if (choice) next[clank.id] = choice;
                      else delete next[clank.id];
                      return next;
                    })
                  }
                  emptyLabel="The project's model"
                />
              </li>
            ))}
          </ul>
        )}
      </Step>

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!ready} onClick={submit}>
          {create.isPending
            ? source !== 'folder'
              ? `Cloning ${repo?.name ?? ''}…`
              : 'Setting it up…'
            : 'Start the project'}
        </Button>
        <Button variant="ghost" onClick={() => go({ page: 'home' })}>
          Cancel
        </Button>
      </div>
      {create.error && <ErrorText>{create.error.message}</ErrorText>}
    </div>
  );
}

function Step(props: { number: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-line bg-panel/60 p-7 backdrop-blur-xl">
      <h2 className="flex items-center gap-3 text-lg font-medium tracking-tight">
        <span className="grid size-6 place-items-center rounded-full border border-line font-mono text-[11px] text-dim">
          {props.number}
        </span>
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function Choice(props: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`flex flex-col gap-1 rounded-2xl border p-4 text-left transition-colors ${props.active ? 'border-accent/50 bg-accent/[0.08]' : 'border-line hover:bg-white/[0.03]'}`}
    >
      <span className="text-sm font-medium">{props.title}</span>
      <span className="text-[13px] text-white/60">{props.children}</span>
    </button>
  );
}
