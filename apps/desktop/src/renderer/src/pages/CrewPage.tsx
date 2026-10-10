import type { Avatar as AvatarColour, ClankProfilePatch, ClankSummary } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Avatar } from '../components/Avatar';
import { ModelPicker } from '../components/ModelPicker';
import { BrowserPanel } from '../components/crew/BrowserPanel';
import { ToolsPanel } from '../components/crew/ToolsPanel';
import { Badge, Button, ErrorText, Panel, inputClass } from '../components/ui';
import {
  AVATAR_GRADIENTS,
  useClank,
  useClankModel,
  useCrew,
  useProviders,
  whereItRuns,
} from '../lib/crew';
import { useNav } from '../lib/nav';
import { useTRPC } from '../lib/trpc';

const STAGES: Record<string, string> = {
  spec: 'Spec',
  design: 'Design',
  build: 'Build',
  qa: 'QA',
  signoff: 'Sign-off',
};

/** The crew: every clank's profile. */
export function CrewPage() {
  const crew = useCrew();
  const trpc = useTRPC();
  const { go } = useNav();
  const providers = useProviders();
  const broken = useQuery(trpc.crew.broken.queryOptions()).data ?? [];
  return (
    <div className="relative mx-auto flex max-w-4xl flex-col gap-8 px-10 py-12">
      <header className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">The crew</h1>
          <p className="text-dim">
            Give a clank a name, a colour and a model of its own, change what it's told, or make one
            of your own.
          </p>
        </div>
        <Button variant="primary" onClick={() => go({ page: 'new-clank' })}>
          Make a clank
        </Button>
      </header>
      {broken.map((b) => (
        <p
          key={b.id}
          className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-200"
        >
          The custom clank <span className="font-mono">{b.id}</span> can't be used until its doc is
          fixed: {b.error}
        </p>
      ))}
      <ul className="flex flex-col divide-y divide-line rounded-3xl border border-line bg-panel/60">
        {crew.map((clank) => (
          <li key={clank.id}>
            <CrewRow
              clank={clank}
              providers={providers}
              onOpen={() => go({ page: 'crew', clankId: clank.id })}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CrewRow(props: {
  clank: ClankSummary;
  providers: ReturnType<typeof useProviders>;
  onOpen: () => void;
}) {
  const { clank } = props;
  const model = useClankModel(clank);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-white/[0.03]"
    >
      <Avatar colour={clank.avatar} size="md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="font-medium">{clank.name}</span>
          <span className="text-[12px] text-dim">{clank.role}</span>
          {clank.custom && <Badge tone="mint">Custom</Badge>}
          {clank.doc === 'edited' && !clank.custom && <Badge tone="lavender">Edited</Badge>}
          {clank.docError && <Badge tone="rose">Doc has problems</Badge>}
        </span>
        <span className="truncate text-[13px] text-white/60">{clank.summary}</span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-dim">
        {model ? `${model.model} · ${whereItRuns(model, props.providers)}` : 'No model yet'}
      </span>
    </button>
  );
}

/** One clank's profile: name, colour, model and priming doc. */
export function ClankPage({ clankId }: { clankId: string }) {
  const clank = useClank(clankId);
  const { go } = useNav();
  if (!clank) return null;

  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-8 px-10 py-12">
      <button
        type="button"
        onClick={() => go({ page: 'crew', clankId: null })}
        className="self-start text-sm text-dim transition-colors hover:text-white"
      >
        ← The crew
      </button>
      <header className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-5">
          <Avatar colour={clank.avatar} size="lg" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-3xl font-semibold tracking-[-0.03em]">{clank.name}</h1>
            <p className="text-dim">{clank.summary}</p>
            <span className="flex flex-wrap gap-1.5">
              <Badge>{clank.role}</Badge>
              {clank.custom && <Badge tone="mint">Custom</Badge>}
              <Badge>
                {clank.kind === 'maker' ? 'Maker' : 'Checker'} ·{' '}
                {STAGES[clank.stage] ?? clank.stage}
              </Badge>
              {clank.outputs.map((o) => (
                <Badge key={o} tone="lavender">
                  {o}
                </Badge>
              ))}
            </span>
          </div>
        </div>
        <Button variant="primary" onClick={() => go({ page: 'draft', clankId: clank.id })}>
          Chat with {clank.name}
        </Button>
      </header>
      <ProfilePanel clank={clank} />
      <ToolsPanel clank={clank} />
      <BrowserPanel clank={clank} />
      <DocPanel clank={clank} />
      {clank.custom && <DeletePanel clank={clank} />}
    </div>
  );
}

function useUpdateClank() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.crew.update.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.crew.list.queryKey() }),
    }),
  );
}

function ProfilePanel({ clank }: { clank: ClankSummary }) {
  const update = useUpdateClank();
  const [name, setName] = useState(clank.name);
  const save = (patch: ClankProfilePatch) => update.mutate({ id: clank.id, patch });
  const commitName = () => {
    const next = name.trim();
    if (next !== clank.name) save({ name: next || null });
    if (!next) setName(clank.name);
  };

  return (
    <Panel
      title="Profile"
      description="Only the app's view of this clank. What it's told is below."
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" hint="Clear it to go back to the doc's.">
          <input
            aria-label="Name"
            className={`${inputClass} w-80`}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && commitName()}
          />
        </Field>
        <Field label="Colour" hint="Its avatar, here and on the board.">
          <span className="flex w-80 flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {(Object.keys(AVATAR_GRADIENTS) as AvatarColour[]).map((colour) => (
              <button
                key={colour}
                type="button"
                role="radio"
                aria-checked={clank.avatar === colour}
                aria-label={colour}
                title={colour}
                onClick={() => save({ avatar: colour })}
                className={`rounded-full p-0.5 transition-colors ${clank.avatar === colour ? 'ring-2 ring-white/70' : 'hover:ring-2 hover:ring-white/20'}`}
              >
                <Avatar colour={colour} size="xs" />
              </button>
            ))}
          </span>
        </Field>
        <Field
          label="Model"
          hint={
            clank.needs.includes('tools')
              ? `It wants one with tool calls and ${Math.round(clank.minContext / 1024)}K of context.`
              : `It wants ${Math.round(clank.minContext / 1024)}K of context.`
          }
        >
          <span className="w-80">
            <ModelPicker
              value={clank.model}
              disabled={update.isPending}
              onChange={(model) => save({ model })}
            />
          </span>
        </Field>
      </div>
      {update.error && <ErrorText>{update.error.message}</ErrorText>}
    </Panel>
  );
}

function DocPanel({ clank }: { clank: ClankSummary }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const doc = useQuery(trpc.crew.doc.queryOptions(clank.id));
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const refresh = () => {
    setDraft(null);
    setConfirmReset(false);
    void queryClient.invalidateQueries({ queryKey: trpc.crew.list.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.crew.doc.queryKey(clank.id) });
  };
  const save = useMutation(trpc.crew.saveDoc.mutationOptions({ onSuccess: refresh }));
  const reset = useMutation(trpc.crew.resetDoc.mutationOptions({ onSuccess: refresh }));
  const text = draft ?? doc.data?.text ?? '';
  const dirty = draft !== null && draft !== doc.data?.text;
  const size = useQuery(trpc.crew.tokens.queryOptions(clank.id));

  return (
    <Panel
      title="Priming doc"
      description={
        <>
          What {clank.name} is told, after the rules the whole crew shares. The part between the{' '}
          <code className="font-mono text-[12px] whitespace-nowrap">---</code> lines configures the
          app and never reaches the model.
        </>
      }
      actions={
        clank.custom ? (
          <Badge tone="mint">Yours</Badge>
        ) : doc.data?.edited ? (
          <Badge tone="lavender">Edited</Badge>
        ) : (
          <Badge>As shipped</Badge>
        )
      }
    >
      {clank.docError && (
        <p className="rounded-xl border border-rose-400/25 bg-rose-400/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-200">
          The edited copy has problems, so {clank.name} uses the doc that ships with the app until
          they're fixed. {clank.docError}
        </p>
      )}
      <textarea
        aria-label={`${clank.name}'s priming doc`}
        spellCheck={false}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        className="h-[32rem] w-full resize-y rounded-2xl border border-line bg-black/30 p-4 font-mono text-[12.5px] leading-relaxed text-white/85 focus:border-accent/60 focus:outline-none"
      />
      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate({ id: clank.id, text })}
          >
            Save
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          )}
          {size.data && (
            <span
              className={`self-center text-[12px] ${size.data.tokens > size.data.budget ? 'text-amber-200' : 'text-dim'}`}
              title="The prompt with the rules the whole crew shares. Under the budget, it fits small local models."
            >
              About {size.data.tokens.toLocaleString('en')} of{' '}
              {size.data.budget.toLocaleString('en')} tokens
            </span>
          )}
        </div>
        {doc.data?.edited &&
          (confirmReset ? (
            <span className="flex items-center gap-2">
              <span className="text-sm text-dim">Lose your edits?</span>
              <Button variant="danger" size="sm" onClick={() => reset.mutate(clank.id)}>
                Reset to default
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmReset(true)}>
              Reset to default
            </Button>
          ))}
      </div>
      {(save.error ?? reset.error) && (
        <p className="text-sm whitespace-pre-wrap text-rose-300">
          {(save.error ?? reset.error)!.message}
        </p>
      )}
    </Panel>
  );
}

/** Taking a custom clank out of the library, for good. */
function DeletePanel({ clank }: { clank: ClankSummary }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { go } = useNav();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation(
    trpc.crew.remove.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.crew.list.queryKey() });
        go({ page: 'crew', clankId: null });
      },
    }),
  );
  return (
    <Panel
      title={`Delete ${clank.name}`}
      description="It goes from your library, with its chats. Take it out of each project's crew first; what it did on tickets stays."
    >
      {confirming ? (
        <span className="flex gap-2">
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate(clank.id)}
          >
            Delete {clank.name}
          </Button>
          <Button variant="ghost" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </span>
      ) : (
        <Button variant="danger" className="self-start" onClick={() => setConfirming(true)}>
          Delete clank…
        </Button>
      )}
      {remove.error && <ErrorText>{remove.error.message}</ErrorText>}
    </Panel>
  );
}

function Field(props: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{props.label}</span>
        <span className="text-[13px] text-dim">{props.hint}</span>
      </span>
      {props.children}
    </div>
  );
}
