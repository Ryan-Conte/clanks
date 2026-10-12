import {
  DEFAULT_PROJECT_CREW,
  type GitHubRepo,
  LEAD_CLANK,
  type ModelChoice,
  type NewProject,
  SAMPLE_TEMPLATE,
  suggestFolder,
  suggestKey,
  suggestName,
} from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { ModelPicker } from '../components/ModelPicker';
import { RepoPicker } from '../components/project/GitHub';
import { GitLabRepoPicker } from '../components/project/GitLab';
import {
  Button,
  Chip,
  Disclosure,
  ErrorText,
  FolderIcon,
  PageHeader,
  Switch,
  inputClass,
} from '../components/ui';
import { plainJob, useCrew } from '../lib/crew';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { joinPath } from '../lib/projects';
import { useTRPC } from '../lib/trpc';

const FOLDER_NOTES = {
  ready:
    "Good to go. The crew works on its own copies of it, so nothing in it changes until you've approved it.",
  not_repo:
    'clanks will start keeping track of changes in this folder (with git), so the crew can work on copies of it and you approve each change.',
  no_commits:
    "clanks will save what's in this folder as its starting point, so the crew can work on copies of it.",
  no_git:
    "This computer doesn't have git yet, a free tool the crew uses to keep track of its changes. Install it from git-scm.com, then choose the folder again.",
  missing: "That folder isn't there.",
} as const;

type Source = 'new' | 'folder' | 'github' | 'gitlab';

/**
 * A project with every choice on show, for when Home's one box isn't enough: where it lives, who's
 * on it and what they run on. Only what it's about is asked for; the rest has an answer already.
 */
export function NewProjectPage(props: { idea: string; templateId: string | null }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const snapshot = useModels();
  const [brief, setBrief] = useState(props.idea);
  const [typedName, setName] = useState<string | null>(null);
  const name = typedName ?? (brief.trim() ? suggestName(brief) : '');
  const [key, setKey] = useState<string | null>(null);
  const shownKey = key ?? suggestKey(name || 'Project');
  const [source, setSource] = useState<Source>('new');
  const [folder, setFolder] = useState<string | null>(null);
  const [repo, setRepo] = useState<GitHubRepo | null>(null);
  const [into, setInto] = useState<string | null>(null);
  const [members, setMembers] = useState<Set<string>>(new Set(DEFAULT_PROJECT_CREW));
  // Crews installed from a marketplace: a set of clanks for a kind of project.
  const crews = useQuery(trpc.marketplace.crews.queryOptions()).data ?? [];
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [perClank, setPerClank] = useState(false);
  const [models, setModels] = useState<Record<string, ModelChoice>>({});
  // A kind of project to start from: it suggests the crew and words what Atlas is asked first.
  const templates = (useQuery(trpc.projects.templates.queryOptions()).data ?? []).filter(
    (t) => t.id !== SAMPLE_TEMPLATE,
  );
  const [templateId, setTemplateId] = useState<string | null>(props.templateId);
  const template = templates.find((t) => t.id === templateId) ?? null;
  const [notes, setNotes] = useState<{ projectId: string; notes: string[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const check = useQuery(
    trpc.projects.checkFolder.queryOptions(folder ?? '', { enabled: folder !== null }),
  );
  // Where a folder made for it would go, to say so before it's made.
  const slug = suggestFolder(name || 'project');
  const newFolder = useQuery(trpc.projects.cloneFolder.queryOptions(slug));
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
  const makeFolder = useMutation(trpc.projects.makeFolder.mutationOptions());
  const createBlank = useMutation(trpc.projects.create.mutationOptions());
  const createFromTemplate = useMutation(trpc.projects.createFromTemplate.mutationOptions());
  const startChat = useMutation(trpc.chat.start.mutationOptions());

  const clonePath = into ?? cloneFolder.data ?? null;
  const keyValid = /^[A-Z][A-Z0-9]{1,5}$/.test(shownKey);
  const workspaceReady =
    source === 'new'
      ? true
      : source === 'folder'
        ? folder !== null &&
          check.data !== undefined &&
          !['no_git', 'missing'].includes(check.data.status)
        : repo !== null && clonePath !== null;
  const ready = name.trim() !== '' && keyValid && workspaceReady && !starting;
  const chosen = crew.filter((c) => c.id === LEAD_CLANK || members.has(c.id));

  const submit = async () => {
    setStarting(true);
    setFailure(null);
    try {
      const project: NewProject = {
        name: name.trim(),
        brief: brief.trim().split(/\s+/).join(' ').slice(0, 500),
        key: shownKey,
        workspace:
          source === 'new'
            ? { kind: 'folder', path: await makeFolder.mutateAsync(name.trim()) }
            : source === 'folder'
              ? { kind: 'folder', path: folder! }
              : { kind: source, repo: repo!.fullName, into: clonePath! },
        crew: chosen.map((c) => c.id),
        model,
        models: perClank
          ? Object.fromEntries(
              Object.entries(models).filter(([id]) => chosen.some((c) => c.id === id)),
            )
          : {},
      };
      if (template) {
        const started = await createFromTemplate.mutateAsync({ project, templateId: template.id });
        // Something couldn't be started: say so before moving on, since the project is there.
        if (started.notes.length > 0) {
          setNotes({ projectId: started.project.id, notes: started.notes });
        } else if (started.conversationId) {
          go({ page: 'chat', id: started.conversationId, projectId: started.project.id });
        } else go({ page: 'project', id: started.project.id, tab: 'overview' });
        return;
      }
      const made = await createBlank.mutateAsync(project);
      // What it's about is the first thing Atlas hears, so the user lands in a conversation.
      if (brief.trim()) {
        try {
          const { conversation } = await startChat.mutateAsync({
            clankId: LEAD_CLANK,
            text: brief.trim(),
            projectId: made.id,
          });
          go({ page: 'chat', id: conversation.id, projectId: made.id });
          return;
        } catch {
          // The project is there all the same, and its overview says what Atlas needs.
        }
      }
      go({ page: 'project', id: made.id, tab: 'overview' });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  if (notes) {
    return (
      <div className="relative mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
        <PageHeader
          title="The project is made"
          description="Not everything it starts with could be done:"
        />
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-amber-100">
          {notes.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <div>
          <Button
            variant="primary"
            onClick={() => go({ page: 'project', id: notes.projectId, tab: 'overview' })}
          >
            Open the project
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
      <PageHeader
        title="Start a project"
        description="Say what you're making. Atlas, who leads the crew, talks it through with you before anything is made. Everything below has a sensible answer already, so change only what you want to."
      />

      <Step title="What are you making?">
        {templates.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={template === null} onClick={() => setTemplateId(null)}>
              Anything
            </Chip>
            {templates.map((t) => (
              <Chip
                key={t.id}
                active={template?.id === t.id}
                title={t.summary}
                onClick={() => {
                  setTemplateId(t.id);
                  // The crew it wants, which can still be changed below.
                  setMembers(new Set(t.crew));
                }}
              >
                {t.name}
              </Chip>
            ))}
          </div>
        )}
        <textarea
          autoFocus
          rows={3}
          aria-label="What you're making"
          placeholder={
            template?.ask
              ? `${template.ask}${template.example ? ` For example: ${template.example}` : ''}`
              : 'In your own words. For example: a website for my surf shop that shows our boards and takes bookings for lessons.'
          }
          className={`${inputClass} h-auto resize-none py-3 text-[15px] leading-relaxed`}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        {template && (
          <p className="text-[13px] text-dim">
            {template.summary}
            {template.source === 'marketplace' ? ' From the marketplace.' : ''}
          </p>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-dim">Its name</span>
          <input
            aria-label="Project name"
            placeholder="Surf shop"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </Step>

      <Step title="Where should it live?">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['new', 'A new folder'],
              ['folder', 'A folder I have'],
              ['github', 'GitHub'],
              ['gitlab', 'GitLab'],
            ] as const
          ).map(([id, label]) => (
            <Chip
              key={id}
              active={source === id}
              onClick={() => {
                // A repository picked on one host isn't on the other.
                if (source !== id) setRepo(null);
                setSource(id);
              }}
            >
              {label}
            </Chip>
          ))}
        </div>
        {source === 'new' ? (
          <p className="text-sm text-dim">
            clanks makes a folder for it
            {newFolder.data && (
              <>
                {' '}
                at <span className="font-mono text-[13px] text-white/80">{newFolder.data}</span>
              </>
            )}
            . Everything the crew makes ends up there.
          </p>
        ) : source === 'folder' ? (
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
            <p className="text-sm text-dim">
              One of your repositories, or a new one, copied to this computer. The crew opens a pull
              request for each piece of work.
            </p>
            {source === 'gitlab' ? (
              <GitLabRepoPicker
                value={repo}
                onChange={(next) => {
                  setRepo(next);
                  setInto(null);
                }}
                suggestedName={slug}
              />
            ) : (
              <RepoPicker
                value={repo}
                onChange={(next) => {
                  setRepo(next);
                  setInto(null);
                }}
                suggestedName={slug}
              />
            )}
            {repo && clonePath && (
              <span className="flex items-center gap-3 text-sm">
                <span className="text-dim">Copied into</span>
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

      <Step title="Who's on it?">
        {crews.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] text-dim">A ready-made crew:</span>
            {crews.map((preset) => (
              <Chip
                key={preset.id}
                onClick={() => setMembers(new Set(preset.clanks))}
                title={`${preset.clanks.length} clanks${preset.integrations.length ? `, expecting ${preset.integrations.join(', ')}` : ''}`}
              >
                {preset.name}
              </Chip>
            ))}
          </div>
        )}
        <ul className="grid grid-cols-2 gap-2">
          {crew.map((clank) => {
            const lead = clank.id === LEAD_CLANK;
            const on = lead || members.has(clank.id);
            return (
              <li key={clank.id}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  disabled={lead}
                  title={clank.summary}
                  onClick={() =>
                    setMembers((current) => {
                      const next = new Set(current);
                      if (on) next.delete(clank.id);
                      else next.add(clank.id);
                      return next;
                    })
                  }
                  className={`flex h-full w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors ${on ? 'border-accent/40 bg-accent/[0.06]' : 'border-line opacity-60 hover:opacity-100'} ${lead ? 'cursor-default' : ''}`}
                >
                  <Avatar colour={clank.avatar} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium">{clank.name}</span>
                    <span className="truncate text-[12px] text-dim">
                      {lead ? 'Leads every project' : plainJob(clank)}
                    </span>
                  </span>
                  <span
                    className={`grid size-5 shrink-0 place-items-center rounded-full border text-[11px] ${on ? 'border-accent bg-accent text-black' : 'border-line text-transparent'}`}
                  >
                    ✓
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Step>

      <Disclosure summary="More options: the model each clank runs on, and how tickets are numbered">
        <div className="flex flex-col gap-6 rounded-3xl border border-line bg-panel/60 p-7">
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Models</h3>
            <p className="text-sm text-dim">
              One model for the whole crew, or a different one for each clank. You can change these
              any time in the project's settings.
            </p>
            <ModelPicker
              value={model}
              onChange={setModel}
              emptyLabel={`Each clank's own, or the crew's model${snapshot?.crewModel ? ` (${snapshot.crewModel})` : ''}`}
            />
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={perClank} onChange={setPerClank} label="A model per clank" />A model
              per clank
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
          </div>
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Ticket numbers</h3>
            <div className="flex items-center gap-3">
              <input
                aria-label="Ticket key letters"
                className={`${inputClass} w-28 font-mono uppercase`}
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
              <p className="text-[13px] text-dim">
                Each piece of work gets a short number to call it by:{' '}
                <span className="font-mono text-white/80">{keyValid ? `${shownKey}-1` : '…'}</span>,{' '}
                <span className="font-mono text-white/80">{keyValid ? `${shownKey}-2` : '…'}</span>.
                {!keyValid && ' Use 2 to 6 letters or digits, starting with a letter.'}
              </p>
            </div>
          </div>
        </div>
      </Disclosure>

      <div className="flex items-center gap-3">
        <Button variant="primary" size="lg" disabled={!ready} onClick={() => void submit()}>
          {starting
            ? source === 'github' || source === 'gitlab'
              ? `Copying ${repo?.name ?? ''}…`
              : 'Setting it up…'
            : 'Start the project'}
        </Button>
        <Button variant="ghost" onClick={() => go({ page: 'home' })}>
          Cancel
        </Button>
      </div>
      {failure && <ErrorText>{failure}</ErrorText>}
    </div>
  );
}

function Step(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-line bg-panel/60 p-7 backdrop-blur-xl">
      <h2 className="text-lg font-medium tracking-tight">{props.title}</h2>
      {props.children}
    </section>
  );
}
