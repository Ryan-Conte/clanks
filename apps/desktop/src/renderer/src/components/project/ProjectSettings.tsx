import {
  type BoardSnapshot,
  type Budget,
  type BudgetStatus,
  LEAD_CLANK,
  type OutputType,
  type ProjectPatch,
} from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { TYPE_LABELS, usageText } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { useModels } from '../../lib/models';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { ModelPicker } from '../ModelPicker';
import { Button, Dot, ErrorText, Panel, Row, Switch, Toggle, inputClass } from '../ui';

/** A project's name, workspace, crew and models, how the crew works, and deleting it. */
export function ProjectSettings({ snapshot }: { snapshot: BoardSnapshot }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const models = useModels();
  const { project } = snapshot;
  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState(project.brief);
  const [base, setBase] = useState(project.baseBranch ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useMutation(trpc.projects.update.mutationOptions());
  const setMember = useMutation(trpc.projects.setMember.mutationOptions());
  const setMemberModel = useMutation(trpc.projects.setMemberModel.mutationOptions());
  const openFolder = useMutation(trpc.projects.openFolder.mutationOptions());
  const remove = useMutation(
    trpc.projects.delete.mutationOptions({ onSuccess: () => go({ page: 'home' }) }),
  );
  const patch = (changes: ProjectPatch) => update.mutate({ id: project.id, patch: changes });
  const changed = name.trim() !== project.name || brief.trim() !== project.brief;
  const crewError = setMember.error ?? setMemberModel.error;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-10 py-8">
        <Panel title="Project">
          <input
            aria-label="Name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="What you're making"
            placeholder="A line about what you're making"
            className={inputClass}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <span className="flex gap-2">
            <Button
              disabled={!changed || !name.trim() || update.isPending}
              onClick={() => patch({ name: name.trim(), brief: brief.trim() })}
            >
              Save
            </Button>
          </span>
          {update.error && <ErrorText>{update.error.message}</ErrorText>}
        </Panel>

        <Panel
          title="Workspace"
          description="The crew works on copies of it, each on a branch of its own. Your own checkout is never touched, except when you approve a ticket: then its work is merged into the base branch."
          actions={
            <Button size="sm" onClick={() => openFolder.mutate(project.id)}>
              Open folder
            </Button>
          }
        >
          <dl className="divide-y divide-line text-sm">
            <Row label="Folder">
              <span className="font-mono text-[13px] break-all">{project.folder}</span>
            </Row>
            {project.repo && (
              <Row label="GitHub">
                <a
                  href={project.repo.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-[13px] text-accent hover:underline"
                >
                  {project.repo.fullName}
                </a>
              </Row>
            )}
            <Row label="Base branch">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  patch({ baseBranch: base.trim() || null });
                }}
              >
                <input
                  aria-label="Base branch"
                  placeholder="The branch the folder has checked out"
                  className={`${inputClass} h-8 flex-1 font-mono text-[13px]`}
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                />
                {base.trim() !== (project.baseBranch ?? '') && (
                  <Button size="sm" type="submit">
                    Save
                  </Button>
                )}
              </form>
              <p className="pt-1 text-[12px] text-dim">
                Tickets start from it and merge into it.
                {project.repo &&
                  ' Their branches are pushed to GitHub with a pull request each, and approving one merges its pull request.'}
              </p>
            </Row>
            <Row label="Ticket keys">
              <span className="font-mono text-[13px]">
                {project.key}-1, {project.key}-2, …
              </span>
            </Row>
          </dl>
        </Panel>

        <Panel
          title="How the crew works"
          description="The crew picks up tickets whose dependencies are done, within these limits, and shares each loaded model's slots."
        >
          <Toggle
            label="Hold new work"
            description="The crew finishes what it has going, and starts nothing new until you turn this off."
            checked={project.held}
            onChange={(held) => patch({ held })}
          />
          <NumberSetting
            label="Runs at once"
            description="Clanks working in this project at the same time, Forge ×2 included. A local model's slots can limit it further."
            value={project.maxRuns}
            min={1}
            max={16}
            onSave={(maxRuns) => patch({ maxRuns })}
          />
          <NumberSetting
            label="Bounces before it comes to you"
            description="A ticket sent back more often than this stops looping and comes to you with its history."
            value={project.bounceLimit}
            min={1}
            max={20}
            onSave={(bounceLimit) => patch({ bounceLimit })}
          />
        </Panel>

        <ChecksPanel snapshot={snapshot} onChange={(optionalChecks) => patch({ optionalChecks })} />

        <BudgetsPanel snapshot={snapshot} onChange={patch} />

        <SandboxPanel snapshot={snapshot} onChange={(sandbox) => patch({ sandbox })} />

        <Panel
          title="Crew and models"
          description="Who works on this project, and the model each runs on here. Atlas leads every project, so it's always in."
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-dim">The crew's model in this project</span>
            <ModelPicker
              value={project.model}
              onChange={(model) => patch({ model })}
              emptyLabel={`Each clank's own, or the crew's model${models?.crewModel ? ` (${models.crewModel})` : ''}`}
            />
          </label>
          <ul className="flex flex-col divide-y divide-line">
            {crew.map((clank) => {
              const member = project.crew.find((m) => m.clankId === clank.id);
              const lead = clank.id === LEAD_CLANK;
              return (
                <li key={clank.id} className="grid grid-cols-[1fr_16rem] items-center gap-4 py-3">
                  <label className="flex items-center gap-3">
                    <Switch
                      checked={member !== undefined}
                      disabled={lead}
                      label={`${clank.name} in this project`}
                      onChange={(included) =>
                        setMember.mutate({ id: project.id, clankId: clank.id, included })
                      }
                    />
                    <Avatar colour={clank.avatar} size="xs" />
                    <span className="flex items-baseline gap-2 text-sm">
                      {clank.name}
                      <span className="text-[12px] text-dim">{clank.role}</span>
                    </span>
                  </label>
                  {member ? (
                    <ModelPicker
                      value={member.model}
                      onChange={(model) =>
                        setMemberModel.mutate({ id: project.id, clankId: clank.id, model })
                      }
                      emptyLabel="The project's model"
                    />
                  ) : (
                    <span className="text-[12px] text-dim">Not in this project</span>
                  )}
                </li>
              );
            })}
          </ul>
          {crewError && <ErrorText>{crewError.message}</ErrorText>}
        </Panel>

        <Panel
          title="Delete the project"
          description="Its board, spec, notes, chats and runs go. The folder stays, and so do the branches the crew worked on."
        >
          {confirmDelete ? (
            <span className="flex gap-2">
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(project.id)}
              >
                Delete {project.name}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </span>
          ) : (
            <Button variant="danger" className="self-start" onClick={() => setConfirmDelete(true)}>
              Delete project…
            </Button>
          )}
          {remove.error && <ErrorText>{remove.error.message}</ErrorText>}
        </Panel>
      </div>
    </div>
  );
}

function NumberSetting(props: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onSave: (value: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  const value = Number(text);
  const valid = Number.isInteger(value) && value >= props.min && value <= props.max;
  return (
    <label className="flex items-start justify-between gap-8">
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium">{props.label}</span>
        <span className="text-sm text-dim">{props.description}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <input
          type="number"
          aria-label={props.label}
          min={props.min}
          max={props.max}
          className={`${inputClass} h-8 w-20 text-[13px]`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {valid && value !== props.value && (
          <Button size="sm" onClick={() => props.onSave(value)}>
            Save
          </Button>
        )}
      </span>
    </label>
  );
}

/**
 * Which checks are required on each type of ticket. Atlas's sign-off always is; an optional check
 * can be skipped on a ticket, with a reason.
 */
function ChecksPanel(props: { snapshot: BoardSnapshot; onChange: (optional: string[]) => void }) {
  const crew = useCrew();
  const { project } = props.snapshot;
  const members = crew.filter((c) => project.crew.some((m) => m.clankId === c.id));
  const made = [...new Set(members.flatMap((c) => c.outputs))];
  const rows = members
    .filter((c) => c.kind === 'checker')
    .flatMap((c) =>
      (c.appliesTo.includes('all') ? made : c.appliesTo.filter((t): t is OutputType => t !== 'all'))
        .filter((type) => made.includes(type))
        .map((type) => ({ clank: c, type, key: `${c.id}:${type}` })),
    );
  return (
    <Panel
      title="Checks"
      description="The checks each type of ticket goes through, in order, before it comes to you. Atlas or you can skip an optional check on a ticket, with a reason shown on its card."
    >
      <ul className="flex flex-col divide-y divide-line">
        {rows.map(({ clank, type, key }) => {
          const signoff = clank.stage === 'signoff';
          const required = signoff || !project.optionalChecks.includes(key);
          return (
            <li key={key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <Avatar colour={clank.avatar} size="xs" />
              <span className="flex-1 text-sm">
                {clank.name} checks {TYPE_LABELS[type]} tickets
              </span>
              <span className="text-[12px] text-dim">
                {signoff ? 'Always required' : required ? 'Required' : 'Optional'}
              </span>
              <Switch
                checked={required}
                disabled={signoff}
                label={`${clank.name}'s check on ${TYPE_LABELS[type]} tickets is required`}
                onChange={(next) =>
                  props.onChange(
                    next
                      ? project.optionalChecks.filter((k) => k !== key)
                      : [...project.optionalChecks, key],
                  )
                }
              />
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="text-[13px] text-dim">Only Atlas's sign-off: the crew has no checkers.</li>
        )}
      </ul>
    </Panel>
  );
}

/** Limits on what the project, and each clank in it, spends. Runs pause when one is reached. */
function BudgetsPanel(props: { snapshot: BoardSnapshot; onChange: (patch: ProjectPatch) => void }) {
  const crew = useCrew();
  const { project } = props.snapshot;
  const members = crew.filter((c) => project.crew.some((m) => m.clankId === c.id));
  return (
    <Panel
      title="Budgets"
      description="When one is reached, runs pause between steps and the crew starts nothing new, until you raise it. Money counts cloud models only, at the prices you set in Settings; local models are free."
    >
      <BudgetRow
        label="The whole project"
        budget={project.budget}
        spend={project.spend}
        onSave={(budget) => props.onChange({ budget })}
      />
      {members.map((clank) => (
        <BudgetRow
          key={clank.id}
          label={clank.name}
          avatar={clank.avatar}
          budget={project.clankBudgets[clank.id] ?? null}
          spend={props.snapshot.clanks[clank.id]}
          onSave={(budget) => {
            const next = { ...project.clankBudgets };
            if (budget) next[clank.id] = budget;
            else delete next[clank.id];
            props.onChange({ clankBudgets: next });
          }}
        />
      ))}
    </Panel>
  );
}

function BudgetRow(props: {
  label: string;
  avatar?: Parameters<typeof Avatar>[0]['colour'];
  budget: Budget | null;
  spend: BudgetStatus | undefined;
  onSave: (budget: Budget | null) => void;
}) {
  const initial = (n: number | null | undefined) =>
    n === null || n === undefined ? '' : String(n);
  const [tokens, setTokens] = useState(initial(props.budget?.tokens));
  const [minutes, setMinutes] = useState(initial(props.budget?.minutes));
  const [dollars, setDollars] = useState(initial(props.budget?.dollars));
  const parse = (text: string) => (text.trim() === '' ? null : Number(text));
  const next: Budget = { tokens: parse(tokens), minutes: parse(minutes), dollars: parse(dollars) };
  const valid = Object.values(next).every((v) => v === null || (Number.isFinite(v) && v > 0));
  const dirty =
    next.tokens !== (props.budget?.tokens ?? null) ||
    next.minutes !== (props.budget?.minutes ?? null) ||
    next.dollars !== (props.budget?.dollars ?? null);
  const field = (label: string, value: string, set: (v: string) => void, unit: string) => (
    <label className="flex items-center gap-1.5 text-[12px] text-dim">
      <input
        aria-label={`${props.label}: ${label}`}
        inputMode="decimal"
        placeholder="no limit"
        className={`${inputClass} h-8 w-24 text-[13px]`}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
      {unit}
    </label>
  );
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <span className="flex items-center gap-2 text-sm">
        {props.avatar && <Avatar colour={props.avatar} size="xs" />}
        {props.label}
        {props.spend && (
          <span
            className={`ml-auto text-[12px] ${props.spend.reached ? 'text-amber-200' : 'text-dim'}`}
          >
            {props.spend.reached ? `Spent: ${props.spend.reached}. ` : 'Spent: '}
            {usageText(props.spend.usage)}
          </span>
        )}
      </span>
      <span className="flex flex-wrap items-center gap-3">
        {field('tokens', tokens, setTokens, 'tokens')}
        {field('minutes', minutes, setMinutes, 'minutes of model time')}
        {field('dollars', dollars, setDollars, 'dollars')}
        {dirty && (
          <Button size="sm" disabled={!valid} onClick={() => props.onSave(valid ? next : null)}>
            Save
          </Button>
        )}
      </span>
    </div>
  );
}

/** Where the crew's commands run: on this computer, or in a Docker container per run. */
function SandboxPanel(props: {
  snapshot: BoardSnapshot;
  onChange: (sandbox: BoardSnapshot['project']['sandbox']) => void;
}) {
  const trpc = useTRPC();
  const docker = useQuery(trpc.projects.docker.queryOptions());
  const { sandbox } = props.snapshot.project;
  const [image, setImage] = useState(sandbox.image);
  const status = docker.data;
  return (
    <Panel
      title="Commands"
      description="Where the crew's shell commands run. Files, git, the browser and the models stay with the app either way, so a container never sees a key."
    >
      <Toggle
        label="Run commands in Docker"
        description="Each run gets its own container with only its worktree in it. Recommended for unattended runs and code you don't trust."
        checked={sandbox.kind === 'docker'}
        disabled={sandbox.kind !== 'docker' && !status?.running}
        onChange={(on) => props.onChange({ ...sandbox, kind: on ? 'docker' : 'host' })}
      />
      <p className="flex items-center gap-2 text-[12px] text-dim">
        <Dot tone={status?.running ? 'mint' : status?.installed ? 'amber' : 'dim'} />
        {!status
          ? 'Looking for Docker…'
          : status.running
            ? `Docker ${status.version} is running.`
            : status.problem}
      </p>
      {sandbox.kind === 'docker' && (
        <>
          <Toggle
            label="Let containers reach the network"
            description="Off, nothing can be downloaded, so installing packages fails. On, commands can reach the internet."
            checked={sandbox.network}
            onChange={(network) => props.onChange({ ...sandbox, network })}
          />
          <label className="flex items-center gap-3 text-sm">
            <span className="text-dim">Image</span>
            <input
              aria-label="Image"
              className={`${inputClass} h-8 flex-1 font-mono text-[13px]`}
              value={image}
              onChange={(e) => setImage(e.target.value)}
            />
            {image.trim() && image.trim() !== sandbox.image && (
              <Button size="sm" onClick={() => props.onChange({ ...sandbox, image: image.trim() })}>
                Save
              </Button>
            )}
          </label>
        </>
      )}
    </Panel>
  );
}
