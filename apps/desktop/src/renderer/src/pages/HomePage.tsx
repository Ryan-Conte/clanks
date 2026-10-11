import type { ClankSummary, HomeSnapshot, ProjectSummary } from '@clanks/core';
import { useQuery } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { RoutinesHome } from '../components/routines/RoutinesHome';
import { Dot, PlusIcon } from '../components/ui';
import { usageText } from '../lib/board';
import { useClankModel, useCrew, useProviders, whereItRuns } from '../lib/crew';
import { formatBytes, formatRate, formatSeconds } from '../lib/format';
import { useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { useProjects } from '../lib/projects';
import { useTRPC } from '../lib/trpc';

/** Everything that needs you and everything the crew is doing, across every project. */
export function HomePage() {
  const trpc = useTRPC();
  const crew = useCrew();
  const projects = useProjects();
  const { go } = useNav();
  const [live, setLive] = useState<HomeSnapshot | null>(null);
  const initial = useQuery(trpc.home.get.queryOptions());
  useSubscription(trpc.home.live.subscriptionOptions(undefined, { onData: setLive }));
  const home = live ?? initial.data;
  const busy = (home?.needsYou.length ?? 0) + (home?.working.length ?? 0) > 0;

  return (
    <div className="relative mx-auto flex max-w-5xl flex-col gap-8 px-10 py-12">
      {home && busy && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <NeedsYou home={home} />
          <WorkingNow home={home} />
        </div>
      )}
      <RoutinesHome />
      {home && (home.upNext.length > 0 || home.today.length > 0 || busy) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <UpNext home={home} />
          <Machine home={home} />
          <Today home={home} />
        </div>
      )}
      <section className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">Projects</p>
        <ul className="grid grid-cols-2 gap-3">
          {projects?.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} />
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => go({ page: 'new-project' })}
              className="flex h-full min-h-28 w-full flex-col justify-center gap-1 rounded-2xl border border-dashed border-line p-5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.03]"
            >
              <span className="flex items-center gap-2 font-medium">
                <PlusIcon /> New project
              </span>
              <span className="text-[13px] text-dim">
                Give it a crew, and turn an idea into a spec and a board.
              </span>
            </button>
          </li>
        </ul>
      </section>
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">New chat</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Who do you want to talk to?</h1>
        <p className="text-dim">
          Not sure? Start with Atlas, the lead. Chats are saved on this machine, and pick up where
          you left off.
        </p>
      </header>
      <ul className="grid grid-cols-2 gap-3">
        {crew.map((clank) => (
          <li key={clank.id}>
            <ClankCard clank={clank} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card(props: {
  title: string;
  tone?: 'amber' | 'mint';
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-panel/60 p-5">
      <p
        className={`flex items-center gap-2 font-mono text-xs tracking-[0.2em] uppercase ${props.tone === 'amber' ? 'text-amber-200' : 'text-accent'}`}
      >
        {props.title}
        {props.count !== undefined && props.count > 0 && (
          <span className="text-white/60">{props.count}</span>
        )}
      </p>
      {props.children}
    </section>
  );
}

function NeedsYou({ home }: { home: HomeSnapshot }) {
  const { go } = useNav();
  return (
    <Card title="Needs you" tone="amber" count={home.needsYou.length}>
      {home.needsYou.length === 0 ? (
        <p className="text-[13px] text-dim">Nothing. The crew has what it needs.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {home.needsYou.map((item) => (
            <li key={`${item.ticketId}:${item.kind}`}>
              <button
                type="button"
                onClick={() =>
                  item.kind === 'approval' && item.conversationId
                    ? go({ page: 'chat', id: item.conversationId })
                    : go({
                        page: 'project',
                        id: item.projectId,
                        tab: 'board',
                        ticket: item.ticketId,
                      })
                }
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.04]"
              >
                <span className="font-mono text-[11px] text-dim">{item.key}</span>
                <span className="min-w-0 flex-1 truncate text-amber-100">{item.text}</span>
                <span className="text-[11px] text-dim">{item.projectName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
    <Card title="Working now" count={home.working.length}>
      {home.working.length === 0 ? (
        <p className="text-[13px] text-dim">Nobody is working right now.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {home.working.map((run) => {
            const clank = crew.find((c) => c.id === run.clankId);
            return (
              <li key={run.conversationId}>
                <button
                  type="button"
                  onClick={() => go({ page: 'chat', id: run.conversationId })}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/[0.04]"
                >
                  <Avatar colour={clank?.avatar ?? 'slate'} size="xs" live={!run.asking} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-2">
                      <span className="text-white">{clank?.name ?? run.clankId}</span>
                      <span className="font-mono text-[11px] text-dim">
                        {run.key ?? 'chat'} · {run.projectName}
                      </span>
                    </span>
                    <span
                      className={`truncate font-mono text-[11px] ${run.asking ? 'text-amber-200' : 'text-white/60'}`}
                    >
                      {run.label.replace(/`/g, '')}
                    </span>
                  </span>
                  <span className="flex flex-col items-end font-mono text-[11px] text-dim">
                    <span>{formatSeconds(Math.max(0, now - +run.since))}</span>
                    {run.model && <span className="max-w-32 truncate">{run.model.model}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function UpNext({ home }: { home: HomeSnapshot }) {
  const { go } = useNav();
  return (
    <Card title="Coming up" count={home.upNext.length}>
      {home.upNext.length === 0 ? (
        <p className="text-[13px] text-dim">Nothing waiting for a slot.</p>
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
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[11px] text-dim">{item.key}</span>
                  <span className="truncate">{item.title}</span>
                </span>
                <span className="truncate text-[11px] text-dim">◐ {item.reason}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
    <Card title="Machine">
      {loaded.length === 0 ? (
        <p className="text-[13px] text-dim">No model is loaded.</p>
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
              <span className="pl-3.5 font-mono text-[11px] text-dim">
                {model.state === 'ready'
                  ? `${Math.min(model.inUse, model.slots)}/${model.slots} slots · ${formatRate(model.tokensPerSecond)}`
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
          {waiting} {waiting === 1 ? 'run waits' : 'runs wait'} for a model.
        </p>
      )}
    </Card>
  );
}

function Today({ home }: { home: HomeSnapshot }) {
  return (
    <Card title="Today">
      {home.today.length === 0 ? (
        <p className="text-[13px] text-dim">Nothing spent yet today.</p>
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
    </Card>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { go } = useNav();
  const { counts } = project;
  const open = counts.backlog + counts.build + counts.review + counts.ready;
  return (
    <button
      type="button"
      onClick={() => go({ page: 'project', id: project.id, tab: 'board' })}
      className="flex h-full w-full flex-col gap-2 rounded-2xl border border-line bg-panel/60 p-5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.03]"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{project.name}</span>
        <span className="font-mono text-[11px] text-dim">{project.key}</span>
      </span>
      {project.brief && <span className="text-[13px] text-white/70">{project.brief}</span>}
      <span className="font-mono text-[11px] text-dim">
        {counts.backlog} backlog · {counts.build} build · {counts.review} review · {counts.ready}{' '}
        ready · {counts.done} done
      </span>
      <span className="mt-auto flex flex-wrap items-center gap-3 font-mono text-[11px] text-dim">
        <span>{open} open</span>
        {project.working > 0 && (
          <span className="flex items-center gap-1 text-accent-2">
            <Dot tone="mint" live /> {project.working} working
          </span>
        )}
        {project.needsYou > 0 && (
          <span className="flex items-center gap-1 text-amber-200">
            <Dot tone="amber" live /> {project.needsYou} need you
          </span>
        )}
        {project.held && <span className="text-amber-200">‖ holding new work</span>}
        {project.spend.reached && (
          <span className="text-amber-200">budget spent: {project.spend.reached}</span>
        )}
      </span>
    </button>
  );
}

function ClankCard({ clank }: { clank: ClankSummary }) {
  const { go } = useNav();
  const model = useClankModel(clank);
  const providers = useProviders();
  return (
    <button
      type="button"
      onClick={() => go({ page: 'draft', clankId: clank.id })}
      className="flex h-full w-full flex-col gap-3 rounded-2xl border border-line bg-panel/60 p-5 text-left transition-colors hover:border-white/15 hover:bg-white/[0.03]"
    >
      <span className="flex items-center gap-3">
        <Avatar colour={clank.avatar} size="md" />
        <span className="flex flex-col">
          <span className="font-medium">{clank.name}</span>
          <span className="text-[12px] text-dim">{clank.role}</span>
        </span>
      </span>
      <span className="text-[13px] leading-relaxed text-white/70">{clank.summary}</span>
      <span className="mt-auto truncate font-mono text-[11px] text-dim">
        {model ? `${model.model} · ${whereItRuns(model, providers)}` : 'No model yet'}
      </span>
    </button>
  );
}
