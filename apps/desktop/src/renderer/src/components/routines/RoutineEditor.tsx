import {
  type Budget,
  type MissedPolicy,
  ROUTINE_EVENTS,
  ROUTINE_EVENT_INFO,
  type Routine,
  type RoutineConcurrency,
  type RoutineDefinition,
  type RoutineEventName,
  type RoutineStep,
} from '@clanks/core';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { TYPE_LABELS } from '../../lib/board';
import { useCrew } from '../../lib/crew';
import { useIntegrations } from '../../lib/integrations';
import { useProject } from '../../lib/projects';
import { timeIn, useNow, when } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText, IconButton, PlusIcon, TrashIcon, inputClass } from '../ui';
import { Dialog, Field, Heading } from './shared';

type StartKind = 'schedule' | 'event' | 'manual';

/** A routine while it's being edited: its steps' payloads as text, its lists as lines. */
interface Draft {
  name: string;
  description: string;
  start: StartKind;
  /** The schedule as typed: plain words, or cron. */
  words: string;
  event: RoutineEventName;
  filters: Record<string, string>;
  timeZone: string;
  inputs: { name: string; value: string }[];
  steps: StepDraft[];
  remindBefore: string;
  reviewBuffer: string;
  policy: MissedPolicy | '';
  grace: string;
  concurrency: RoutineConcurrency;
  runTokens: string;
  monthTokens: string;
}

interface StepDraft {
  id: string;
  kind: 'ticket' | 'action';
  dependsOn: string[];
  clank: string;
  type: string;
  title: string;
  description: string;
  criteria: string;
  integration: string;
  operation: string;
  at: string;
  deliver: 'at_time' | 'hand_off';
  payload: { name: string; value: string }[];
}

const small = `${inputClass} h-9 text-[13px]`;

function toDraft(definition: RoutineDefinition | null, crew: string[]): Draft {
  const trigger = definition?.trigger;
  return {
    name: definition?.name ?? '',
    description: definition?.description ?? '',
    start: trigger?.kind === 'event' ? 'event' : trigger?.kind === 'manual' ? 'manual' : 'schedule',
    words:
      trigger?.kind === 'cron'
        ? trigger.cron
        : trigger?.kind === 'once'
          ? trigger.at.replace('T', ' ')
          : '',
    event: trigger?.kind === 'event' ? trigger.event : 'git.tag',
    filters: trigger?.kind === 'event' ? { ...trigger.filters } : {},
    timeZone: definition?.timeZone ?? '',
    inputs: Object.entries(definition?.inputs ?? {}).map(([name, value]) => ({ name, value })),
    steps: (definition?.steps ?? []).map((step) => stepDraft(step, crew)),
    remindBefore: definition?.approval.remindBefore ?? '30m',
    reviewBuffer: definition?.timing.reviewBuffer ?? '1h',
    policy: definition?.missed.policy ?? '',
    grace: definition?.missed.grace ?? '15m',
    concurrency: definition?.concurrency ?? 'skip',
    runTokens: definition?.budget.perRun?.tokens ? String(definition.budget.perRun.tokens) : '',
    monthTokens: definition?.budget.perMonth?.tokens
      ? String(definition.budget.perMonth.tokens)
      : '',
  };
}

function stepDraft(step: RoutineStep | null, crew: string[], id = ''): StepDraft {
  return {
    id: step?.id ?? id,
    kind: step?.action ? 'action' : 'ticket',
    dependsOn: step?.dependsOn ?? [],
    clank: step?.ticket?.clank ?? crew[0] ?? '',
    type: step?.ticket?.type ?? '',
    title: step?.ticket?.title ?? '',
    description: step?.ticket?.description ?? '',
    criteria: (step?.ticket?.criteria ?? []).join('\n'),
    integration: step?.action?.integration ?? '',
    operation: step?.action?.operation ?? '',
    at: step?.action?.at ?? step?.ticket?.due ?? '17:00',
    deliver: step?.action?.deliver ?? 'at_time',
    payload: Object.entries(step?.action?.payload ?? {}).map(([name, value]) => ({
      name,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })),
  };
}

/** A budget of tokens alone, which is what a routine's is nearly always given in. */
function tokens(text: string): Budget | null {
  const n = Number(text.replace(/[,_\s]/g, ''));
  return text.trim() && Number.isFinite(n) && n >= 1000
    ? { tokens: Math.round(n), minutes: null, dollars: null }
    : null;
}

/** What's sent to be checked and saved. The service reads it and says what's wrong. */
function toDefinition(draft: Draft, trigger: unknown): Record<string, unknown> {
  return {
    name: draft.name,
    description: draft.description,
    trigger:
      draft.start === 'manual'
        ? { kind: 'manual' }
        : draft.start === 'event'
          ? {
              kind: 'event',
              event: draft.event,
              filters: Object.fromEntries(
                Object.entries(draft.filters).filter(([, value]) => value.trim() !== ''),
              ),
            }
          : (trigger ?? { kind: 'cron', cron: draft.words }),
    timeZone: draft.timeZone,
    inputs: Object.fromEntries(
      draft.inputs.filter((i) => i.name.trim()).map((i) => [i.name.trim(), i.value]),
    ),
    steps: draft.steps.map((step) => ({
      id: step.id.trim(),
      dependsOn: step.dependsOn,
      ...(step.kind === 'ticket'
        ? {
            ticket: {
              clank: step.clank,
              type: step.type,
              title: step.title,
              description: step.description,
              criteria: step.criteria
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            },
          }
        : {
            action: {
              integration: step.integration,
              operation: step.operation,
              at: step.at.trim(),
              deliver: step.deliver,
              payload: Object.fromEntries(
                step.payload.filter((p) => p.name.trim()).map((p) => [p.name.trim(), p.value]),
              ),
            },
          }),
    })),
    approval: { remindBefore: draft.remindBefore.trim() },
    timing: { reviewBuffer: draft.reviewBuffer.trim() },
    missed: { policy: draft.policy || null, grace: draft.grace.trim() },
    concurrency: draft.concurrency,
    budget: { perRun: tokens(draft.runTokens), perMonth: tokens(draft.monthTokens) },
  };
}

/** A value that lags what's typed, so a query isn't asked on every key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The routine editor: what starts it, its inputs, its steps as a small flow, and its rules, with
 * the next runs and each step's time worked out as it's changed. Saving keeps a draft; nothing is
 * scheduled until it's activated.
 */
export function RoutineEditor(props: {
  projectId: string;
  /** The routine being changed. Without one, a new routine. */
  routine?: Routine | undefined;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const now = useNow();
  const project = useProject(props.projectId);
  const crew = useCrew().filter((c) => project?.crew.some((m) => m.clankId === c.id));
  const makers = crew.filter((c) => c.kind === 'maker' && c.outputs.length > 0);
  const integrations = (useIntegrations()?.integrations ?? []).filter(
    (i) => i.kind === 'declarative' && !i.disabled,
  );
  const [draft, setDraft] = useState<Draft>(() =>
    toDraft(
      props.routine?.definition ?? null,
      makers.map((c) => c.id),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (index: number, patch: Partial<StepDraft>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));

  const words = useSettled(draft.words, 350);
  const zone = useSettled(draft.timeZone, 350);
  const schedule = useQuery(
    trpc.routines.previewSchedule.queryOptions(
      { words, zone },
      { enabled: draft.start === 'schedule', placeholderData: keepPreviousData },
    ),
  );
  const trigger = draft.start === 'schedule' ? (schedule.data?.trigger ?? null) : null;
  // As text, so it settles on what it says and not on being a new object each time.
  const written = useSettled(JSON.stringify(toDefinition(draft, trigger)), 350);
  const definition = useMemo(() => JSON.parse(written) as Record<string, unknown>, [written]);
  const check = useQuery(
    trpc.routines.check.queryOptions(
      { projectId: props.projectId, definition },
      { placeholderData: keepPreviousData },
    ),
  );
  const options = { onError: (e: { message: string }) => setError(e.message) };
  const create = useMutation(trpc.routines.create.mutationOptions(options));
  const update = useMutation(trpc.routines.update.mutationOptions(options));
  const activate = useMutation(trpc.routines.activate.mutationOptions(options));
  const saving = create.isPending || update.isPending || activate.isPending;

  const save = async (thenActivate: boolean) => {
    setError(null);
    const sent = toDefinition(draft, trigger);
    try {
      const saved = props.routine
        ? await update.mutateAsync({ id: props.routine.id, definition: sent })
        : await create.mutateAsync({ projectId: props.projectId, definition: sent });
      if (thenActivate) await activate.mutateAsync(saved.id);
      props.onClose();
    } catch {
      // What went wrong is shown below.
    }
  };

  const addStep = (kind: 'ticket' | 'action') => {
    const taken = new Set(draft.steps.map((s) => s.id));
    let id = kind === 'ticket' ? 'step' : 'publish';
    for (let n = 2; taken.has(id); n++) id = `${kind === 'ticket' ? 'step' : 'publish'}_${n}`;
    const step = stepDraft(
      null,
      makers.map((c) => c.id),
      id,
    );
    const first = makers[0];
    set({
      steps: [
        ...draft.steps,
        {
          ...step,
          kind,
          type: first?.outputs[0] ?? '',
          integration: integrations[0]?.id ?? '',
          operation: integrations[0]?.operations.find((o) => o.risk !== 'read')?.id ?? '',
          // An action usually sends what the steps before it made.
          dependsOn:
            kind === 'action'
              ? draft.steps.filter((s) => s.kind === 'ticket').map((s) => s.id)
              : [],
        },
      ],
    });
  };

  const problems = check.data?.problems ?? [];
  const usesZone = draft.start === 'schedule' || draft.steps.some((s) => s.kind === 'action');
  const active = props.routine?.status === 'active';

  return (
    <Dialog
      wide
      title={props.routine ? `Edit ${props.routine.definition.name}` : 'New routine'}
      onClose={props.onClose}
      actions={
        <>
          {!active && (
            <Button
              size="sm"
              disabled={saving || draft.name.trim() === ''}
              onClick={() => void save(false)}
            >
              Save as a draft
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={saving || problems.length > 0 || draft.name.trim() === ''}
            onClick={() => void save(!active)}
          >
            {active ? 'Save' : 'Save and activate'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-7">
        <section className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <input
              className={small}
              value={draft.name}
              placeholder="Weekend promo"
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="What it's for">
            <input
              className={small}
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
        </section>

        <section className="flex flex-col gap-3">
          <Heading>Starts</Heading>
          <span className="flex flex-wrap gap-1" role="tablist" aria-label="What starts it">
            {(
              [
                ['schedule', 'At a time, or on repeat'],
                ['event', 'When something happens'],
                ['manual', 'Only when I run it'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={draft.start === id}
                onClick={() => set({ start: id })}
                className={`rounded-full px-3 py-1 text-[13px] ${draft.start === id ? 'bg-white/[0.08] text-white' : 'text-dim hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </span>
          {draft.start === 'schedule' && (
            <>
              <Field
                label="When"
                hint={
                  'In plain words or cron: "every weekday at 9", "first Monday of the month", "tomorrow at 5pm", "0 13 * * 5".'
                }
              >
                <input
                  className={small}
                  value={draft.words}
                  placeholder="every Friday at 1pm"
                  onChange={(e) => set({ words: e.target.value })}
                />
              </Field>
              {schedule.data?.problem && <ErrorText>{schedule.data.problem}</ErrorText>}
              {schedule.data?.trigger && (
                <div className="flex flex-col gap-1.5 rounded-xl border border-line bg-black/20 px-3.5 py-3 text-[13px]">
                  <p>
                    <span className="text-white">{schedule.data.text}</span>
                    {schedule.data.trigger.kind === 'cron' && (
                      <code className="ml-2 font-mono text-[12px] text-dim">
                        {schedule.data.trigger.cron}
                      </code>
                    )}
                    {schedule.data.byModel && (
                      <span className="ml-2 text-[12px] text-amber-200">
                        Atlas read this one: check it says what you meant.
                      </span>
                    )}
                  </p>
                  {schedule.data.nextRuns.length > 0 ? (
                    <ol className="flex flex-col font-mono text-[12px] text-dim">
                      {schedule.data.nextRuns.map((run) => (
                        <li key={+run}>{when(run, check.data?.zone ?? 'UTC', now)}</li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-[12px] text-amber-200">That time has passed.</p>
                  )}
                </div>
              )}
            </>
          )}
          {draft.start === 'event' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="When" className="sm:col-span-3">
                <select
                  className={small}
                  value={draft.event}
                  onChange={(e) => set({ event: e.target.value as RoutineEventName, filters: {} })}
                >
                  {ROUTINE_EVENTS.map((event) => (
                    <option key={event} value={event}>
                      {ROUTINE_EVENT_INFO[event].when}
                    </option>
                  ))}
                </select>
              </Field>
              {ROUTINE_EVENT_INFO[draft.event].filters.map((filter) => (
                <Field key={filter.id} label={`${filter.label}, if only some`}>
                  <input
                    className={small}
                    value={draft.filters[filter.id] ?? ''}
                    placeholder={filter.hint}
                    onChange={(e) =>
                      set({ filters: { ...draft.filters, [filter.id]: e.target.value } })
                    }
                  />
                </Field>
              ))}
            </div>
          )}
          {usesZone && (
            <Field
              label="Time zone"
              hint={`Times are this zone's own, so 09:00 stays 09:00 when the clocks change. Empty uses yours${check.data ? `: ${check.data.zone}` : ''}.`}
            >
              <input
                className={small}
                value={draft.timeZone}
                placeholder="Australia/Sydney"
                onChange={(e) => set({ timeZone: e.target.value })}
              />
            </Field>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <Heading>Inputs</Heading>
          <p className="text-[12px] text-dim">
            Values the steps read as <code className="font-mono">{'{{inputs.name}}'}</code>. A run
            uses these unless you change them for that run.
          </p>
          {draft.inputs.map((input, i) => (
            <span key={i} className="flex items-center gap-2">
              <input
                aria-label="Name"
                className={`${small} w-40 font-mono`}
                value={input.name}
                placeholder="offer"
                onChange={(e) =>
                  set({
                    inputs: draft.inputs.map((x, j) =>
                      j === i ? { ...x, name: e.target.value } : x,
                    ),
                  })
                }
              />
              <input
                aria-label="Value"
                className={`${small} min-w-0 flex-1`}
                value={input.value}
                placeholder="20% off all longboards this weekend"
                onChange={(e) =>
                  set({
                    inputs: draft.inputs.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  })
                }
              />
              <IconButton
                label="Remove this input"
                onClick={() => set({ inputs: draft.inputs.filter((_, j) => j !== i) })}
              >
                <TrashIcon />
              </IconButton>
            </span>
          ))}
          <span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ inputs: [...draft.inputs, { name: '', value: '' }] })}
            >
              <PlusIcon /> Add an input
            </Button>
          </span>
        </section>

        <section className="flex flex-col gap-3">
          <Heading>Steps</Heading>
          <ol className="flex flex-col gap-3">
            {draft.steps.map((step, index) => {
              const timing = check.data?.timings.find((t) => t.stepId === step.id.trim());
              const earlier = draft.steps.slice(0, index);
              const maker = makers.find((c) => c.id === step.clank);
              const integration = integrations.find((i) => i.id === step.integration);
              return (
                <li
                  key={index}
                  className="flex flex-col gap-3 rounded-2xl border border-line bg-black/20 p-4"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label="The step's id"
                      className={`${small} w-36 font-mono`}
                      value={step.id}
                      onChange={(e) => {
                        const id = e.target.value;
                        // Steps that wait on it follow its new name.
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, i) =>
                            i === index
                              ? { ...s, id }
                              : {
                                  ...s,
                                  dependsOn: s.dependsOn.map((dep) => (dep === step.id ? id : dep)),
                                },
                          ),
                        }));
                      }}
                    />
                    <span className="text-[13px] text-dim">
                      {step.kind === 'ticket' ? 'A ticket for a clank' : 'An action at a set time'}
                    </span>
                    {timing?.at && check.data && (
                      <span
                        className="font-mono text-[12px] text-white/75"
                        title={timing.why ?? undefined}
                      >
                        {step.kind === 'action' ? 'goes out' : 'due'}{' '}
                        {timeIn(timing.at, check.data.zone)}
                      </span>
                    )}
                    <span className="ml-auto flex items-center">
                      <IconButton
                        label="Remove this step"
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            steps: d.steps
                              .filter((_, i) => i !== index)
                              .map((s) => ({
                                ...s,
                                dependsOn: s.dependsOn.filter((dep) => dep !== step.id),
                              })),
                          }))
                        }
                      >
                        <TrashIcon />
                      </IconButton>
                    </span>
                  </span>
                  {earlier.length > 0 && (
                    <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-dim">
                      Waits on
                      {earlier.map((other) => {
                        const on = step.dependsOn.includes(other.id);
                        return (
                          <button
                            key={other.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              setStep(index, {
                                dependsOn: on
                                  ? step.dependsOn.filter((d) => d !== other.id)
                                  : [...step.dependsOn, other.id],
                              })
                            }
                            className={`rounded-full border px-2.5 py-0.5 font-mono ${on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-dim hover:text-white'}`}
                          >
                            {other.id || '?'}
                          </button>
                        );
                      })}
                    </span>
                  )}
                  {step.kind === 'ticket' ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Who makes it">
                        <select
                          className={small}
                          value={step.clank}
                          onChange={(e) => {
                            const next = makers.find((c) => c.id === e.target.value);
                            setStep(index, {
                              clank: e.target.value,
                              type: next?.outputs.includes(step.type as never)
                                ? step.type
                                : (next?.outputs[0] ?? ''),
                            });
                          }}
                        >
                          {!maker && <option value={step.clank}>{step.clank || 'Pick one'}</option>}
                          {makers.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}, {c.role}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="What it makes">
                        <select
                          className={small}
                          value={step.type}
                          onChange={(e) => setStep(index, { type: e.target.value })}
                        >
                          {(maker?.outputs ?? []).map((type) => (
                            <option key={type} value={type}>
                              {TYPE_LABELS[type]}
                            </option>
                          ))}
                          {!maker?.outputs.includes(step.type as never) && (
                            <option value={step.type}>{step.type || 'Pick one'}</option>
                          )}
                        </select>
                      </Field>
                      <Field label="Title" className="sm:col-span-2">
                        <input
                          className={small}
                          value={step.title}
                          placeholder="Promo banner: {{inputs.offer}}"
                          onChange={(e) => setStep(index, { title: e.target.value })}
                        />
                      </Field>
                      <Field
                        label="What it needs to know"
                        className="sm:col-span-2"
                        hint="The clank sees only its ticket and what the steps it waits on handed in."
                      >
                        <textarea
                          className={`${inputClass} h-20 py-2 text-[13px]`}
                          value={step.description}
                          onChange={(e) => setStep(index, { description: e.target.value })}
                        />
                      </Field>
                      <Field label="Done when, one per line" className="sm:col-span-2">
                        <textarea
                          className={`${inputClass} h-16 py-2 text-[13px]`}
                          value={step.criteria}
                          onChange={(e) => setStep(index, { criteria: e.target.value })}
                        />
                      </Field>
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label="Service">
                        <select
                          className={small}
                          value={step.integration}
                          onChange={(e) => {
                            const next = integrations.find((i) => i.id === e.target.value);
                            setStep(index, {
                              integration: e.target.value,
                              operation: next?.operations.find((o) => o.risk !== 'read')?.id ?? '',
                            });
                          }}
                        >
                          {!integration && (
                            <option value={step.integration}>
                              {step.integration || 'Pick one'}
                            </option>
                          )}
                          {integrations.map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="What it does">
                        <select
                          className={small}
                          value={step.operation}
                          onChange={(e) => setStep(index, { operation: e.target.value })}
                        >
                          {!integration?.operations.some((o) => o.id === step.operation) && (
                            <option value={step.operation}>{step.operation || 'Pick one'}</option>
                          )}
                          {(integration?.operations ?? []).map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.id.replace(/_/g, ' ')}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="When" hint='"17:00", or "+4h" after the run starts'>
                        <input
                          className={`${small} font-mono`}
                          value={step.at}
                          onChange={(e) => setStep(index, { at: e.target.value })}
                        />
                      </Field>
                      <div className="flex flex-col gap-2 sm:col-span-3">
                        <span className="text-[12px] text-dim">
                          What it sends. Use what the steps it waits on handed in, such as{' '}
                          <code className="font-mono">{'{{steps.copy.output.text}}'}</code> for a
                          campaign's post, or{' '}
                          <code className="font-mono">{'{{steps.banner.output.image}}'}</code> for a
                          design's picture.
                        </span>
                        {step.payload.map((entry, i) => (
                          <span key={i} className="flex items-center gap-2">
                            <input
                              aria-label="Field"
                              className={`${small} w-32 font-mono`}
                              value={entry.name}
                              placeholder="text"
                              onChange={(e) =>
                                setStep(index, {
                                  payload: step.payload.map((p, j) =>
                                    j === i ? { ...p, name: e.target.value } : p,
                                  ),
                                })
                              }
                            />
                            <input
                              aria-label="Value"
                              className={`${small} min-w-0 flex-1 font-mono`}
                              value={entry.value}
                              onChange={(e) =>
                                setStep(index, {
                                  payload: step.payload.map((p, j) =>
                                    j === i ? { ...p, value: e.target.value } : p,
                                  ),
                                })
                              }
                            />
                            <IconButton
                              label="Remove this field"
                              onClick={() =>
                                setStep(index, { payload: step.payload.filter((_, j) => j !== i) })
                              }
                            >
                              <TrashIcon />
                            </IconButton>
                          </span>
                        ))}
                        <span className="flex flex-wrap items-center gap-3">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setStep(index, {
                                payload: [...step.payload, { name: '', value: '' }],
                              })
                            }
                          >
                            <PlusIcon /> Add a field
                          </Button>
                          <label className="flex items-center gap-2 text-[12px] text-dim">
                            <input
                              type="checkbox"
                              checked={step.deliver === 'hand_off'}
                              onChange={(e) =>
                                setStep(index, {
                                  deliver: e.target.checked ? 'hand_off' : 'at_time',
                                })
                              }
                            />
                            Hand it to the service when approved, to send at its time with this
                            computer off
                          </label>
                        </span>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <span className="flex flex-wrap gap-2">
            <Button size="sm" disabled={makers.length === 0} onClick={() => addStep('ticket')}>
              <PlusIcon /> A ticket for a clank
            </Button>
            <Button
              size="sm"
              disabled={integrations.length === 0}
              onClick={() => addStep('action')}
            >
              <PlusIcon /> An action at a set time
            </Button>
          </span>
        </section>

        <section className="flex flex-col gap-3">
          <Heading>Rules</Heading>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Remind me before the first action">
              <input
                className={`${small} font-mono`}
                value={draft.remindBefore}
                onChange={(e) => set({ remindBefore: e.target.value })}
              />
            </Field>
            <Field label="Time to review, before an action">
              <input
                className={`${small} font-mono`}
                value={draft.reviewBuffer}
                onChange={(e) => set({ reviewBuffer: e.target.value })}
              />
            </Field>
            <Field label="How late is still on time">
              <input
                className={`${small} font-mono`}
                value={draft.grace}
                onChange={(e) => set({ grace: e.target.value })}
              />
            </Field>
            <Field label="A run missed while clanks was off">
              <select
                className={small}
                value={draft.policy}
                onChange={(e) => set({ policy: e.target.value as Draft['policy'] })}
              >
                <option value="">
                  The usual: skipped if it sends anything, started late if not
                </option>
                <option value="skip">Is skipped, and recorded</option>
                <option value="run_late">Starts late, once</option>
                <option value="ask">Asks me</option>
              </select>
            </Field>
            <Field label="If the run before is still going">
              <select
                className={small}
                value={draft.concurrency}
                onChange={(e) => set({ concurrency: e.target.value as RoutineConcurrency })}
              >
                <option value="skip">Skip this one</option>
                <option value="queue">Start when it finishes</option>
                <option value="parallel">Run both</option>
              </select>
            </Field>
            <span className="grid grid-cols-2 gap-3">
              <Field label="Tokens per run">
                <input
                  className={`${small} font-mono`}
                  value={draft.runTokens}
                  placeholder="No limit"
                  onChange={(e) => set({ runTokens: e.target.value })}
                />
              </Field>
              <Field label="Per month">
                <input
                  className={`${small} font-mono`}
                  value={draft.monthTokens}
                  placeholder="No limit"
                  onChange={(e) => set({ monthTokens: e.target.value })}
                />
              </Field>
            </span>
          </div>
          <p className="text-[12px] text-dim">
            Lengths of time are written like 30m, 1h or 2d. Whatever the rule for missed runs, an
            action never goes out later than that on its own.
          </p>
        </section>

        {(problems.length > 0 || (check.data?.warnings.length ?? 0) > 0 || error) && (
          <section className="flex flex-col gap-1.5">
            {problems.map((problem) => (
              <p key={problem} className="text-[13px] text-rose-300">
                {problem}
              </p>
            ))}
            {check.data?.warnings.map((warning) => (
              <p key={warning} className="text-[13px] text-amber-200">
                {warning}
              </p>
            ))}
            {error && <ErrorText>{error}</ErrorText>}
          </section>
        )}
      </div>
    </Dialog>
  );
}
