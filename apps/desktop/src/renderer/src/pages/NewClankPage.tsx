import {
  ALWAYS_AVAILABLE_TOOLS,
  type Avatar as AvatarColour,
  type CustomClank,
  type ModelChoice,
  type ModelTag,
  type OutputType,
  STAGES,
  TOOL_GROUPS,
  type ToolGroup,
  estimateTokens,
  modelTagSchema,
  outputTypeSchema,
  suggestClankId,
} from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { ModelPicker } from '../components/ModelPicker';
import { Button, ErrorText, Switch, inputClass } from '../components/ui';
import { TYPE_LABELS } from '../lib/board';
import { AVATAR_GRADIENTS, useCrew } from '../lib/crew';
import { useNav } from '../lib/nav';
import { useTRPC } from '../lib/trpc';

type Level = 'off' | 'allow' | 'ask';

/** The tool groups a custom clank can be given, with how each reads in the form. */
const GROUPS: [ToolGroup, string][] = [
  ['files', 'Files'],
  ['shell', 'Commands'],
  ['git', 'Git'],
  ['web', 'Web'],
  ['browser', 'Browser'],
  ['design', 'Design'],
  ['board', 'Board'],
  ['spec', 'Spec'],
  ['review', 'Review'],
  ['artifacts', 'Notes and files'],
];

const MAKER_TOOLS: Record<string, Level> = {
  spec_read: 'allow',
  fs_read: 'allow',
  fs_list: 'allow',
  fs_search: 'allow',
  artifact_save: 'allow',
  artifact_read: 'allow',
  board_create_ticket: 'allow',
  web_search: 'ask',
  web_fetch: 'ask',
};

const CHECKER_TOOLS: Record<string, Level> = {
  review_pass: 'allow',
  spec_read: 'allow',
  fs_read: 'allow',
  fs_list: 'allow',
  fs_search: 'allow',
  git_diff: 'allow',
  git_log: 'allow',
  artifact_read: 'allow',
  shell_exec: 'ask',
  web_search: 'ask',
  web_fetch: 'ask',
};

const STAGE_NAMES: Record<string, string> = {
  spec: 'Spec',
  design: 'Design',
  build: 'Build',
  qa: 'QA',
  signoff: 'Sign-off',
};

/** A prompt to start from, in the shape the shipped docs have. */
function starter(input: {
  name: string;
  role: string;
  summary: string;
  kind: 'maker' | 'checker';
  type: string;
}): string {
  const role = input.role.trim().toLowerCase() || 'specialist';
  const summary = input.summary.trim();
  if (input.kind === 'checker') {
    return `# ${input.name || 'My clank'}

You are the ${role} reviewer. ${summary} You review; you never fix.

## How you work

1. Read what was handed in on the ticket, and its acceptance criteria.
2. Check it. Note each problem with where it is and why it matters.
3. Decide.

## Deciding

- **Bounce** when something must change before it goes on. Call \`ticket_bounce\` to the clank that made it, with numbered issues, each saying what is wrong and what would fix it.
- **Pass** otherwise. Call \`review_pass\`, and put smaller things in \`notes\`.

## Rules

- Report only what you can point to. No generic advice.

## Output

\`review_pass\` takes:

- \`summary\`: what you checked and what you found.
- \`criteria\`: each acceptance criterion with \`met\` or \`not met\`.
- \`notes\`: anything to watch in later tickets.
`;
  }
  return `# ${input.name || 'My clank'}

You are the ${role}. ${summary}

## How you work

1. Read the ticket and its acceptance criteria, and what the tickets it depends on handed in.
2. Do the work.
3. Check it against each acceptance criterion.
4. Call \`submit_output\`.

## Rules

- Never invent facts. If something is missing, say so in \`notes\`.

## Output

Call \`submit_output\` with type \`${input.type}\` and:

- \`title\`
- \`body\`: the work, in Markdown.
- \`criteria\`: each acceptance criterion with \`met\` or \`not met\`.
- \`notes\`: assumptions, and anything you could not check.
`;
}

/** Make a clank of your own: who it is, where it sits in the workflow, its tools and its prompt. */
export function NewClankPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { go } = useNav();
  const crew = useCrew();
  const templates = useQuery(trpc.crew.templates.queryOptions());
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [summary, setSummary] = useState('');
  const [avatar, setAvatar] = useState<AvatarColour>('slate');
  const [kind, setKind] = useState<'maker' | 'checker'>('checker');
  const [outputs, setOutputs] = useState<OutputType[]>(['doc']);
  const [makerStage, setMakerStage] = useState('build');
  const [applies, setApplies] = useState<OutputType[]>(['pr']);
  const [stage, setStage] = useState<string | null>(null);
  const [after, setAfter] = useState('qa');
  const [bounce, setBounce] = useState<string[] | null>(null);
  const [tools, setTools] = useState<Record<string, Level> | null>(null);
  const [tags, setTags] = useState<ModelTag[]>(['general']);
  const [vision, setVision] = useState(false);
  const [minContext, setMinContext] = useState(16384);
  const [temperature, setTemperature] = useState(0.3);
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [describing, setDescribing] = useState('');
  const [whole, setWhole] = useState<string | null>(null);

  const id = suggestClankId(name);
  const taken = crew.some((c) => c.id === id);
  const shownStage = stage ?? (suggestClankId(role || name) || 'review');
  const shownBounce = bounce ?? (kind === 'checker' ? ['maker'] : ['atlas']);
  const shownTools = tools ?? (kind === 'checker' ? CHECKER_TOOLS : MAKER_TOOLS);
  const shownPrompt = prompt ?? starter({ name, role, summary, kind, type: outputs[0] ?? 'doc' });
  const allow = Object.keys(shownTools).filter((t) => shownTools[t] === 'allow');
  const ask = Object.keys(shownTools).filter((t) => shownTools[t] === 'ask');
  // Other custom checkers' stages can be followed too.
  const stages = [
    ...STAGES.filter((s) => s !== 'signoff' && s !== 'spec'),
    ...crew
      .filter((c) => c.kind === 'checker' && !(STAGES as readonly string[]).includes(c.stage))
      .map((c) => c.stage),
  ].filter((s, i, all) => all.indexOf(s) === i);

  const done = (created: { id: string }) => {
    void queryClient.invalidateQueries({ queryKey: trpc.crew.list.queryKey() });
    go({ page: 'crew', clankId: created.id });
  };
  const update = useMutation(trpc.crew.update.mutationOptions());
  const create = useMutation(
    trpc.crew.create.mutationOptions({
      onSuccess: async (created) => {
        if (model) await update.mutateAsync({ id: created.id, patch: { model } }).catch(() => {});
        done(created);
      },
    }),
  );
  const draft = useMutation(
    trpc.crew.draft.mutationOptions({ onSuccess: (text) => setPrompt(text) }),
  );

  const clank: CustomClank = {
    id,
    name: name.trim(),
    role: role.trim(),
    summary: summary.trim(),
    avatar,
    kind,
    outputs: kind === 'maker' ? outputs : [],
    stage: kind === 'maker' ? makerStage : shownStage,
    after: kind === 'checker' && !(STAGES as readonly string[]).includes(shownStage) ? after : null,
    appliesTo: kind === 'checker' ? applies : [],
    bounceTo: shownBounce,
    allow,
    ask,
    tags,
    vision,
    minContext,
    temperature,
    prompt: shownPrompt,
  };
  const problem = !name.trim()
    ? 'Give it a name.'
    : taken
      ? `There's already a clank with the id ${id}. Pick another name.`
      : !role.trim()
        ? 'Give it a role, in a word or two.'
        : !summary.trim()
          ? 'Say what it does, in a sentence the rest of the crew will see.'
          : kind === 'maker' && outputs.length === 0
            ? 'A maker makes at least one type of ticket.'
            : kind === 'checker' && applies.length === 0
              ? 'A checker reviews at least one type of ticket.'
              : kind === 'checker' && !/^[a-z][a-z0-9-]*$/.test(shownStage)
                ? "Its stage's name is lowercase letters, digits and dashes."
                : null;
  const tokens = estimateTokens(shownPrompt);
  const toggle = <T,>(list: T[], item: T) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  if (whole !== null) {
    return (
      <div className="relative mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
        <Heading onBack={() => setWhole(null)} back="← The form" />
        <Step number={1} title="Paste a priming doc">
          <p className="text-sm text-dim">
            A whole doc, frontmatter and all, in the format the crew's own docs use. It's checked
            before it joins your library.
          </p>
          <textarea
            aria-label="The priming doc"
            spellCheck={false}
            className="h-[34rem] w-full resize-y rounded-2xl border border-line bg-black/30 p-4 font-mono text-[12.5px] leading-relaxed text-white/85 focus:border-accent/60 focus:outline-none"
            value={whole}
            onChange={(e) => setWhole(e.target.value)}
          />
        </Step>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={!whole.trim() || create.isPending}
            onClick={() => create.mutate({ text: whole })}
          >
            Add it to the library
          </Button>
          {templates.data?.example && !crew.some((c) => c.id === 'sentinel') && (
            <Button onClick={() => setWhole(templates.data.example)}>
              Start from Sentinel, a security checker
            </Button>
          )}
        </div>
        {create.error && <ErrorText>{create.error.message}</ErrorText>}
      </div>
    );
  }

  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-6 px-10 py-12">
      <Heading onBack={() => go({ page: 'crew', clankId: null })} back="← The crew" />

      <Step number={1} title="Who it is">
        <div className="grid grid-cols-[1fr_12rem] gap-3">
          <input
            autoFocus
            aria-label="Name"
            placeholder="Sentinel"
            maxLength={40}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="Role"
            placeholder="Security"
            title="One or two words, shown beside its name"
            maxLength={40}
            className={inputClass}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </div>
        <input
          aria-label="What it does"
          placeholder="What it does, in a sentence: reviews every pull request for security problems"
          maxLength={240}
          className={inputClass}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <div className="flex items-center justify-between gap-6">
          <span className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {(Object.keys(AVATAR_GRADIENTS) as AvatarColour[]).map((colour) => (
              <button
                key={colour}
                type="button"
                role="radio"
                aria-checked={avatar === colour}
                aria-label={colour}
                title={colour}
                onClick={() => setAvatar(colour)}
                className={`rounded-full p-0.5 transition-colors ${avatar === colour ? 'ring-2 ring-white/70' : 'hover:ring-2 hover:ring-white/20'}`}
              >
                <Avatar colour={colour} size="xs" />
              </button>
            ))}
          </span>
          <span className={`font-mono text-[12px] ${taken ? 'text-rose-300' : 'text-dim'}`}>
            id: {name.trim() ? id : '…'}
          </span>
        </div>
      </Step>

      <Step number={2} title="Its place in the workflow">
        <div className="grid grid-cols-2 gap-2">
          <Choice active={kind === 'checker'} onClick={() => setKind('checker')} title="A checker">
            Reviews other clanks' tickets on their way to Atlas, and passes them or sends them back.
          </Choice>
          <Choice active={kind === 'maker'} onClick={() => setKind('maker')} title="A maker">
            Works tickets of its own and hands in what it made.
          </Choice>
        </div>
        {kind === 'maker' ? (
          <>
            <Field label="It makes">
              <Chips
                options={outputTypeSchema.options.filter((t) => t !== 'spec')}
                label={(t) => TYPE_LABELS[t]}
                selected={outputs}
                onToggle={(t) => setOutputs(toggle(outputs, t))}
              />
            </Field>
            <Field label="In the stage">
              <select
                aria-label="Stage"
                className={`${inputClass} w-52`}
                value={makerStage}
                onChange={(e) => setMakerStage(e.target.value)}
              >
                <option value="build">Build</option>
                <option value="design">Design</option>
                <option value="spec">Spec</option>
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="It reviews">
              <Chips
                options={outputTypeSchema.options}
                label={(t) => TYPE_LABELS[t]}
                selected={applies}
                onToggle={(t) => setApplies(toggle(applies, t))}
              />
            </Field>
            <Field label="Its stage">
              <span className="flex items-center gap-2 text-sm text-dim">
                <input
                  aria-label="Stage name"
                  className={`${inputClass} w-40 font-mono`}
                  value={shownStage}
                  onChange={(e) =>
                    setStage(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                  }
                />
                comes after
                <select
                  aria-label="The stage it follows"
                  className={`${inputClass} w-40`}
                  value={after}
                  onChange={(e) => setAfter(e.target.value)}
                >
                  {stages.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_NAMES[s] ?? s}
                    </option>
                  ))}
                </select>
              </span>
            </Field>
            <p className="text-[12px] text-dim">
              A {applies.map((t) => TYPE_LABELS[t]).join(' or ') || '…'} ticket will go to its
              maker, through the checks up to {STAGE_NAMES[after] ?? after}, then to{' '}
              {name.trim() || 'this clank'}, then to Atlas, then to you.
            </p>
          </>
        )}
        <Field label="It can send work back to">
          <Chips
            options={['maker', ...crew.map((c) => c.id)]}
            label={(target) =>
              target === 'maker'
                ? "The ticket's maker"
                : (crew.find((c) => c.id === target)?.name ?? target)
            }
            selected={shownBounce}
            onToggle={(target) => setBounce(toggle(shownBounce, target))}
          />
        </Field>
      </Step>

      <Step number={3} title="Its tools">
        <p className="text-sm text-dim">
          Click a tool to let it use it, and again to have it ask you first before risky calls.
          Asking for help, handing in and the project's notes are every clank's, and aren't listed.
        </p>
        <div className="flex flex-col gap-3">
          {GROUPS.map(([group, label]) => (
            <div key={group} className="grid grid-cols-[8rem_1fr] items-start gap-3">
              <span className="pt-1 text-[13px] text-dim">{label}</span>
              <span className="flex flex-wrap gap-1.5">
                {TOOL_GROUPS[group]
                  .filter((tool) => !(ALWAYS_AVAILABLE_TOOLS as readonly string[]).includes(tool))
                  .map((tool) => {
                    const level = shownTools[tool] ?? 'off';
                    return (
                      <button
                        key={tool}
                        type="button"
                        title={
                          level === 'off'
                            ? 'Not given'
                            : level === 'allow'
                              ? 'Uses it without asking'
                              : 'Asks you before risky calls'
                        }
                        onClick={() =>
                          setTools({
                            ...shownTools,
                            [tool]: level === 'off' ? 'allow' : level === 'allow' ? 'ask' : 'off',
                          })
                        }
                        className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition-colors ${level === 'allow' ? 'border-accent-2/40 bg-accent-2/10 text-accent-2' : level === 'ask' ? 'border-amber-300/40 bg-amber-300/10 text-amber-200' : 'border-line text-dim hover:text-white'}`}
                      >
                        {tool}
                        {level === 'ask' ? ' · asks' : ''}
                      </button>
                    );
                  })}
              </span>
            </div>
          ))}
        </div>
      </Step>

      <Step number={4} title="Its model">
        <ModelPicker value={model} onChange={setModel} emptyLabel="The crew's model" />
        <Field label="Good at">
          <Chips
            options={modelTagSchema.options}
            label={(t) => t}
            selected={tags}
            onToggle={(t) => {
              const next = toggle(tags, t);
              if (next.length > 0) setTags(next);
            }}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <label className="flex items-center gap-2 text-dim">
            Context
            <select
              aria-label="Context it needs"
              className={`${inputClass} h-9 w-28`}
              value={minContext}
              onChange={(e) => setMinContext(Number(e.target.value))}
            >
              {[8192, 16384, 32768, 65536].map((n) => (
                <option key={n} value={n}>
                  {n / 1024}K
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-dim">
            Temperature
            <input
              type="number"
              aria-label="Temperature"
              min={0}
              max={2}
              step={0.1}
              className={`${inputClass} h-9 w-20`}
              value={temperature}
              onChange={(e) => setTemperature(Math.min(2, Math.max(0, Number(e.target.value))))}
            />
          </label>
          <label className="flex items-center gap-3 text-dim">
            <Switch checked={vision} onChange={setVision} label="Better with a model that sees" />
            Better with a model that sees pictures
          </label>
        </div>
      </Step>

      <Step number={5} title="What it's told">
        <p className="text-sm text-dim">
          Its prompt, written to it: who it is, the steps it follows, its rules, and how it
          finishes. It comes after the rules the whole crew shares.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            draft.mutate({
              name: name.trim() || 'My clank',
              role: role.trim() || 'Specialist',
              description: describing.trim() || summary.trim(),
              kind,
              types: kind === 'maker' ? outputs : applies,
              tools: [...allow, ...ask],
            });
          }}
        >
          <input
            aria-label="What it's for, for Atlas to draft from"
            placeholder="Or say what it's for in a line, and Atlas drafts the prompt"
            className={`${inputClass} flex-1`}
            value={describing}
            onChange={(e) => setDescribing(e.target.value)}
          />
          <Button
            type="submit"
            disabled={draft.isPending || !(describing.trim() || summary.trim())}
          >
            {draft.isPending ? 'Atlas is drafting…' : 'Draft with Atlas'}
          </Button>
        </form>
        {draft.error && <ErrorText>{draft.error.message}</ErrorText>}
        <textarea
          aria-label="The prompt"
          spellCheck={false}
          className="h-[26rem] w-full resize-y rounded-2xl border border-line bg-black/30 p-4 font-mono text-[12.5px] leading-relaxed text-white/85 focus:border-accent/60 focus:outline-none"
          value={shownPrompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className={`text-[12px] ${tokens > 1300 ? 'text-amber-200' : 'text-dim'}`}>
          About {tokens.toLocaleString('en')} tokens. With the crew's shared rules (about 1,200)
          it's best under 2,500, so it fits small local models.
          {prompt !== null && (
            <button
              type="button"
              className="ml-2 text-accent hover:underline"
              onClick={() => setPrompt(null)}
            >
              Start over from the template
            </button>
          )}
        </p>
      </Step>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={problem !== null || create.isPending}
          onClick={() => create.mutate(clank)}
        >
          {create.isPending ? 'Adding it…' : 'Add it to the library'}
        </Button>
        <Button variant="ghost" onClick={() => setWhole(templates.data?.template ?? '')}>
          Paste a whole doc instead
        </Button>
        {problem && <span className="text-[13px] text-dim">{problem}</span>}
      </div>
      {create.error && (
        <p className="text-sm whitespace-pre-wrap text-rose-300">{create.error.message}</p>
      )}
    </div>
  );
}

function Heading(props: { onBack: () => void; back: string }) {
  return (
    <>
      <button
        type="button"
        onClick={props.onBack}
        className="self-start text-sm text-dim transition-colors hover:text-white"
      >
        {props.back}
      </button>
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">Custom clank</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Make a clank of your own</h1>
        <p className="text-dim">
          A name, a place in the workflow, the tools it can use and what it's told. It's saved to
          your library, and can join any project's crew.
        </p>
      </header>
    </>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_1fr] items-start gap-3">
      <span className="pt-1.5 text-sm text-dim">{label}</span>
      {children}
    </div>
  );
}

function Chips<T extends string>(props: {
  options: readonly T[];
  label: (option: T) => string;
  selected: readonly T[];
  onToggle: (option: T) => void;
}) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {props.options.map((option) => {
        const on = props.selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            onClick={() => props.onToggle(option)}
            className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${on ? 'border-accent/50 bg-accent/10 text-white' : 'border-line text-dim hover:text-white'}`}
          >
            {props.label(option)}
          </button>
        );
      })}
    </span>
  );
}
