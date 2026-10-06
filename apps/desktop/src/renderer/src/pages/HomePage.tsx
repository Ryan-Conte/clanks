import type { ClankSummary, ProjectSummary } from '@clanks/core';
import { Avatar } from '../components/Avatar';
import { Dot, PlusIcon } from '../components/ui';
import { useClankModel, useCrew, useProviders, whereItRuns } from '../lib/crew';
import { useNav } from '../lib/nav';
import { useProjects } from '../lib/projects';

/** Your projects, and a chat with anyone in the crew. */
export function HomePage() {
  const crew = useCrew();
  const projects = useProjects();
  const { go } = useNav();
  return (
    <div className="relative mx-auto flex max-w-4xl flex-col gap-8 px-10 py-12">
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
      <span className="mt-auto flex flex-wrap items-center gap-3 font-mono text-[11px] text-dim">
        <span>
          {open} open · {counts.done} done
        </span>
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
