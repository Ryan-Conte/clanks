import { type HomeSnapshot, LEAD_CLANK, type ProjectSummary, SAMPLE_TEMPLATE } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { AddPictures, PictureTray } from '../components/chat/Pictures';
import { RoutinesHome } from '../components/routines/RoutinesHome';
import {
  ArrowUpIcon,
  Button,
  Chip,
  Disclosure,
  Dot,
  ErrorText,
  ProgressBar,
  SectionCard,
} from '../components/ui';
import { usageText } from '../lib/board';
import { useClank, useClankModel, useCrew } from '../lib/crew';
import { formatBytes, formatRate, formatSeconds } from '../lib/format';
import { useModels, useSetup } from '../lib/models';
import { useNav } from '../lib/nav';
import { toSend, usePictures } from '../lib/pictures';
import { useProjects } from '../lib/projects';
import { useTRPC } from '../lib/trpc';

/** A template's name, short enough for a chip. One from a marketplace keeps its own. */
const TEMPLATE_CHIPS: Record<string, string> = {
  'ship-a-feature': 'A feature for my app',
  'landing-page': 'A landing page',
  'plan-a-launch': 'A launch plan',
  'question-to-report': 'A researched report',
};

/** Ideas to start from, for a box that's empty. */
const EXAMPLES = [
  'A simple website for my bakery, with our menu and opening hours',
  'Compare three ways for a small shop to take payments online',
  'A week of social posts to announce our new opening hours',
];

/** Say what you want; under it, what needs you and what the crew is doing, across every project. */
export function HomePage() {
  const trpc = useTRPC();
  const projects = useProjects();
  const settings = useQuery(trpc.settings.get.queryOptions()).data;
  const [live, setLive] = useState<HomeSnapshot | null>(null);
  const initial = useQuery(trpc.home.get.queryOptions());
  useSubscription(trpc.home.live.subscriptionOptions(undefined, { onData: setLive }));
  const home = live ?? initial.data;
  const lead = useClank(LEAD_CLANK);
  const model = useClankModel(lead);
  const name = settings?.profile.name.trim();

  return (
    <div className="relative mx-auto flex max-w-4xl flex-col gap-10 px-10 pt-16 pb-14">
      <header className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-4xl font-semibold tracking-[-0.03em]">
          {greeting()}
          {name ? `, ${name}` : ''}
        </h1>
        <p className="text-[17px] text-dim">What would you like the crew to make?</p>
      </header>

      {model ? <IdeaBox /> : <NeedsModel />}

      {settings && !settings.sampleOffered && model && <SampleOffer />}

      {home && home.needsYou.length > 0 && <NeedsYou home={home} />}
      <RoutinesHome />
      {home && home.working.length > 0 && <WorkingNow home={home} />}

      {projects && projects.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-dim">Your projects</h2>
          <ul className="grid grid-cols-2 gap-3">
            {projects.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {home && (home.upNext.length > 0 || home.today.length > 0 || home.working.length > 0) && (
        <Disclosure summary="Behind the scenes">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <UpNext home={home} />
            <Machine home={home} />
            <Today home={home} />
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 5
    ? 'Still up'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';
}

/**
 * The one box: what the user wants, in their words. Sending it makes the project, with its folder
 * and crew, and puts them in a conversation with Atlas about it.
 */
function IdeaBox() {
  const trpc = useTRPC();
  const { go } = useNav();
  const [idea, setIdea] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ projectId: string; notes: string[] } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // A sketch, a screenshot of a site to match, a photo of the shop: they go to Atlas with it.
  const { pictures, error, add, remove, onPaste, onDrop, onDragOver } = usePictures();
  const templates = (useQuery(trpc.projects.templates.queryOptions()).data ?? []).filter(
    (t) => t.id !== SAMPLE_TEMPLATE,
  );
  const template = templates.find((t) => t.id === templateId) ?? null;
  const start = useMutation(
    trpc.projects.quickStart.mutationOptions({
      onSuccess: (started) => {
        // Something couldn't be started: say so before moving on, since the project is there.
        if (started.notes.length > 0) {
          setNotes({ projectId: started.project.id, notes: started.notes });
        } else if (started.conversationId) {
          go({ page: 'chat', id: started.conversationId, projectId: started.project.id });
        } else go({ page: 'project', id: started.project.id, tab: 'overview' });
      },
    }),
  );

  // Grow with the text, up to a point.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [idea]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!idea.trim() || start.isPending) return;
    start.mutate({ idea, templateId, images: toSend(pictures) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  if (notes) {
    return (
      <section className="flex flex-col gap-3 rounded-3xl border border-amber-300/25 bg-amber-300/[0.05] p-6">
        <h2 className="font-medium">The project is made, with one thing to sort out</h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-amber-100">
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
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={submit}
        onDrop={onDrop}
        onDragOver={onDragOver}
        className="flex flex-col gap-3 rounded-[28px] border border-line bg-raised/80 p-4 shadow-2xl shadow-black/40 transition-colors focus-within:border-white/25"
      >
        {pictures.length > 0 && (
          <div className="px-2">
            <PictureTray pictures={pictures} onRemove={remove} />
          </div>
        )}
        <textarea
          id="idea"
          ref={box}
          autoFocus
          rows={2}
          value={idea}
          disabled={start.isPending}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="What you want the crew to make"
          placeholder={
            template?.ask
              ? `${template.ask}${template.example ? ` For example: ${template.example}` : ''}`
              : 'Describe it in your own words. A sentence is enough to start.'
          }
          className="min-h-14 w-full resize-none bg-transparent px-2 pt-1.5 text-[16px] leading-relaxed text-white outline-none placeholder:text-white/35 disabled:opacity-60"
        />
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <AddPictures disabled={start.isPending} onAdd={(files) => void add(files)} />
            {templates.map((t) => (
              <Chip
                key={t.id}
                active={templateId === t.id}
                title={t.summary}
                onClick={() => {
                  setTemplateId((current) => (current === t.id ? null : t.id));
                  box.current?.focus();
                }}
              >
                {TEMPLATE_CHIPS[t.id] ?? t.name}
              </Chip>
            ))}
          </div>
          <button
            type="submit"
            aria-label="Start"
            title="Start"
            disabled={!idea.trim() || start.isPending}
            className="grid size-10 shrink-0 place-items-center rounded-full bg-white text-black transition-colors hover:bg-white/85 disabled:opacity-30"
          >
            <ArrowUpIcon />
          </button>
        </div>
      </form>
      {start.error && <ErrorText>{start.error.message}</ErrorText>}
      {error && <p className="text-center text-[12px] text-amber-200/90">{error}</p>}
      {start.isPending ? (
        <p className="flex items-center justify-center gap-2 text-sm text-dim">
          <Dot tone="lavender" live /> Setting up the project and telling Atlas…
        </p>
      ) : template ? (
        <p className="text-center text-[13px] text-dim">{template.summary}</p>
      ) : idea.trim() === '' ? (
        <ul className="flex flex-col items-center gap-1 text-[13px] text-dim">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button
                type="button"
                className="rounded-lg px-2 py-0.5 text-left transition-colors hover:text-white"
                onClick={() => {
                  setIdea(example);
                  box.current?.focus();
                }}
              >
                <span className="text-white/30">Try:</span> {example}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-center text-[13px] text-dim">
          Atlas, who leads the crew, takes it from here and asks before anything important. The
          project gets a folder of its own on this computer.{' '}
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => go({ page: 'new-project', idea, templateId })}
          >
            More options
          </button>
        </p>
      )}
    </div>
  );
}

/** No model yet, so nothing can start: the way to get one, or how far along it is. */
function NeedsModel() {
  const { go } = useNav();
  const setup = useSetup();
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-accent/25 bg-accent/[0.06] p-6">
      {setup ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="flex items-center gap-2 font-medium">
              <Dot tone="lavender" live={setup.state === 'downloading'} /> Getting the crew ready
            </h2>
            <p className="text-sm text-dim">
              {setup.title} is downloading. You can start as soon as it lands.
            </p>
          </div>
          <ProgressBar value={setup.progress} />
          <div>
            <Button size="sm" onClick={() => go({ page: 'setup' })}>
              See the download
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-6">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">The crew isn't set up yet</h2>
            <p className="text-sm text-dim">
              It needs an AI model to think with, which runs on this computer. It's one download.
            </p>
          </div>
          <Button variant="primary" onClick={() => go({ page: 'setup' })}>
            Set up the crew
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * Offered once, to someone new: a small sample project to watch the crew work, from two tickets
 * to something to approve.
 */
function SampleOffer() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { go } = useNav();
  const skip = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
    }),
  );
  const start = useMutation(
    trpc.projects.createSample.mutationOptions({
      onSuccess: (started) => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() });
        go({ page: 'project', id: started.project.id, tab: 'overview' });
      },
    }),
  );
  return (
    <section className="flex flex-col gap-3 rounded-3xl border border-line bg-panel/60 p-6">
      <div className="flex items-center justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">New here? Watch the crew make something small first</h2>
          <p className="text-sm leading-relaxed text-dim">
            A sample project: Quill writes a one-page website for a coffee cart, Forge builds it,
            Gauge checks it, and you say yes at the end. It takes a few minutes and stays on this
            computer.
          </p>
        </div>
        <span className="flex shrink-0 gap-2">
          <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Setting it up…' : 'Run the sample'}
          </Button>
          <Button
            variant="ghost"
            disabled={skip.isPending}
            onClick={() => skip.mutate({ sampleOffered: true })}
          >
            No thanks
          </Button>
        </span>
      </div>
      {(start.error ?? skip.error) && <ErrorText>{(start.error ?? skip.error)!.message}</ErrorText>}
    </section>
  );
}

function NeedsYou({ home }: { home: HomeSnapshot }) {
  const { go } = useNav();
  return (
    <SectionCard title="Waiting for you" tone="amber" count={home.needsYou.length}>
      <ul className="flex flex-col gap-1">
        {home.needsYou.map((item) => (
          <li key={`${item.ticketId}:${item.kind}`}>
            <button
              type="button"
              // It's waiting in that project's conversation with the lead, whoever asked.
              onClick={() => go({ page: 'project', id: item.projectId, tab: 'overview' })}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-white/[0.05]"
            >
              <span className="min-w-0 flex-1 truncate text-white">
                {item.text.replace(/^Ready for you: /, '')}
              </span>
              <span className="shrink-0 text-[12px] text-dim">{item.projectName}</span>
              <span className="shrink-0 rounded-full bg-white px-3 py-1 text-[12px] font-medium text-black">
                {item.kind === 'question' ? 'Answer' : 'Look'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/** Re-renders every second, for elapsed times. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function WorkingNow({ home }: { home: HomeSnapshot }) {
  const { go } = useNav();
  const crew = useCrew();
  const now = useNow();
  return (
    <SectionCard title="Working now" count={home.working.length}>
      <ul className="flex flex-col gap-1">
        {home.working.map((run) => {
          const clank = crew.find((c) => c.id === run.clankId);
          return (
            <li key={run.conversationId}>
              <button
                type="button"
                title="Watch"
                onClick={() => go({ page: 'chat', id: run.conversationId })}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-white/[0.05]"
              >
                <Avatar colour={clank?.avatar ?? 'slate'} live={!run.asking} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">
                    <span className="font-medium text-white">{clank?.name ?? run.clankId}</span>{' '}
                    <span className="text-dim">
                      on {run.key ? run.title.replace(/^[^:]+:\s*/, '') : run.projectName}
                    </span>
                  </span>
                  <span
                    className={`truncate text-[12px] ${run.asking ? 'text-amber-200' : 'text-white/60'}`}
                  >
                    {run.label.replace(/`/g, '')}
                  </span>
                </span>
                <span className="tabular flex shrink-0 flex-col items-end text-[12px] text-dim">
                  <span>{formatSeconds(Math.max(0, now - +run.since))}</span>
                  <span>{run.projectName}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

function UpNext({ home }: { home: HomeSnapshot }) {
  const { go } = useNav();
  return (
    <SectionCard title="Coming up" count={home.upNext.length}>
      {home.upNext.length === 0 ? (
        <p className="text-[13px] text-dim">Nothing is waiting its turn.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {home.upNext.slice(0, 8).map((item) => (
            <li key={item.ticketId}>
              <button
                type="button"
                onClick={() =>
                  go({ page: 'project', id: item.projectId, tab: 'board', ticket: item.ticketId })
                }
                className="flex w-full flex-col rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.04]"
              >
                <span className="truncate">{item.title}</span>
                <span className="truncate text-[11px] text-dim">{item.reason}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function Machine({ home }: { home: HomeSnapshot }) {
  const models = useModels();
  const loaded = models?.runtime.loaded ?? [];
  // The scheduler's own words: "Waiting for gemma4:26b: …" or "Waiting for room to load …".
  const waiting = home.upNext.filter(
    (u) => u.reason.startsWith('Waiting for') && !u.reason.startsWith('Waiting for a free run'),
  ).length;
  return (
    <SectionCard title="This computer">
      {loaded.length === 0 ? (
        <p className="text-[13px] text-dim">No model is loaded right now.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {loaded.map((model) => (
            <li key={model.modelId} className="flex flex-col gap-0.5 text-[13px]">
              <span className="flex items-center gap-2">
                <Dot
                  tone={
                    model.state === 'ready' ? 'mint' : model.state === 'failed' ? 'rose' : 'amber'
                  }
                  live={model.inUse > 0}
                />
                <span className="truncate font-mono text-[12px]">{model.modelId}</span>
              </span>
              <span className="tabular pl-3.5 text-[11px] text-dim">
                {model.state === 'ready'
                  ? `${Math.min(model.inUse, model.slots)} of ${model.slots} in use · ${formatRate(model.tokensPerSecond)}`
                  : model.state}
                {model.memory &&
                  ` · ${formatBytes(model.memory.gpuBytes + model.memory.systemBytes)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {waiting > 0 && (
        <p className="text-[12px] text-dim">
          {waiting} {waiting === 1 ? 'piece of work waits' : 'pieces of work wait'} for a model.
        </p>
      )}
    </SectionCard>
  );
}

function Today({ home }: { home: HomeSnapshot }) {
  return (
    <SectionCard title="Used today">
      {home.today.length === 0 ? (
        <p className="text-[13px] text-dim">Nothing yet today.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {home.today.map((day) => (
            <li key={day.projectId} className="flex flex-col text-[13px]">
              <span>{day.projectName}</span>
              <span className="text-[11px] text-dim">{usageText(day.usage)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { go } = useNav();
  const crew = useCrew();
  const { counts } = project;
  const total = counts.backlog + counts.build + counts.review + counts.ready + counts.done;
  const members = crew.filter((c) => project.crew.some((m) => m.clankId === c.id));
  return (
    <button
      type="button"
      onClick={() => go({ page: 'project', id: project.id, tab: 'overview' })}
      className="flex h-full w-full flex-col gap-3 rounded-3xl border border-line bg-panel/60 p-5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.03]"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="font-medium">{project.name}</span>
        <span className="flex shrink-0 -space-x-1.5">
          {members.slice(0, 6).map((clank) => (
            <span key={clank.id} className="rounded-full ring-2 ring-panel">
              <Avatar colour={clank.avatar} size="xs" />
            </span>
          ))}
        </span>
      </span>
      {project.brief && (
        <span className="line-clamp-2 text-[13px] leading-relaxed text-white/65">
          {project.brief}
        </span>
      )}
      <span className="mt-auto flex flex-col gap-2">
        {total > 0 && <ProgressBar value={counts.done / total} tone="mint" />}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-dim">
          {project.needsYou > 0 && (
            <span className="flex items-center gap-1.5 text-amber-200">
              <Dot tone="amber" live /> {project.needsYou} waiting for you
            </span>
          )}
          {project.working > 0 && (
            <span className="flex items-center gap-1.5 text-accent-2">
              <Dot tone="mint" live /> {project.working} working
            </span>
          )}
          <span className="tabular">
            {total === 0 ? 'Nothing planned yet' : `${counts.done} of ${total} done`}
          </span>
          {project.held && <span className="text-amber-200">Paused</span>}
          {project.spend.reached && (
            <span className="text-amber-200">Budget used up: {project.spend.reached}</span>
          )}
        </span>
      </span>
    </button>
  );
}
