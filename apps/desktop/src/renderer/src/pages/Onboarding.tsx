import type { Settings } from '@clanks/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Capabilities, FitBadge } from '../components/models/badges';
import { MachinePanel } from '../components/models/MachinePanel';
import { PullRow } from '../components/models/PullPanel';
import { Button, Dot, ErrorText, Panel } from '../components/ui';
import { formatBytes, formatTokens } from '../lib/format';
import { type CatalogItem, useModels } from '../lib/models';
import { useNav } from '../lib/nav';
import { useTRPC } from '../lib/trpc';

/**
 * First run: size up the machine, pick a model that fits it, pull it and give it to the crew.
 * Everything after the download works offline.
 */
export function Onboarding() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const snapshot = useModels();
  const [chosen, setChosen] = useState<string | null>(null);
  // Both finish first run, so the window moves on as soon as the settings say so.
  const saveSettings = {
    onSuccess: (settings: Settings) =>
      queryClient.setQueryData(trpc.settings.get.queryKey(), settings),
  };
  const pull = useMutation(trpc.models.pull.mutationOptions());
  const useForCrew = useMutation(trpc.models.useForCrew.mutationOptions(saveSettings));
  const skip = useMutation(trpc.settings.update.mutationOptions(saveSettings));

  const catalog = snapshot?.catalog ?? [];
  const recommended = catalog.find((m) => m.id === snapshot?.recommended);
  const options = catalog.filter(
    (m) =>
      m.id !== recommended?.id && m.fit && m.fit.verdict !== 'too_large' && m.capabilities.tools,
  );
  const selected = catalog.find((m) => m.id === (chosen ?? recommended?.id)) ?? null;
  const pulled = snapshot?.library.find((m) => m.id === selected?.id && !m.missing);
  const pulling = snapshot?.pulls.find((p) => p.modelId === selected?.id && p.state !== 'done');

  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-8 px-10 py-12">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">First run</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Let's get a model running</h1>
        <p className="text-dim">
          clanks runs its own models on this machine, with nothing else to install. Pick one for the
          crew; you can change it any time.
        </p>
      </header>

      <MachinePanel compact />

      <Panel
        title="Pick a model"
        description="Downloaded once from Hugging Face and checked by sha256. After that it runs offline."
      >
        {!snapshot?.hardware ? (
          <p className="flex items-center gap-2 text-sm text-dim">
            <Dot tone="lavender" live /> Sizing up this machine…
          </p>
        ) : (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="Model for the crew">
            {recommended && (
              <Choice
                item={recommended}
                recommended
                selected={selected?.id === recommended.id}
                onSelect={setChosen}
              />
            )}
            {options.length > 0 && (
              <details className="group">
                <summary className="cursor-pointer py-2 text-sm text-dim select-none hover:text-white">
                  Other models that run here
                </summary>
                <div className="flex flex-col gap-2 pt-1">
                  {options.map((item) => (
                    <Choice
                      key={item.id}
                      item={item}
                      selected={selected?.id === item.id}
                      onSelect={setChosen}
                    />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </Panel>

      {selected && (
        <section className="flex flex-col gap-4 rounded-3xl border border-line bg-panel/60 p-7">
          {pulled ? (
            <div className="flex items-center justify-between gap-6">
              <div className="flex flex-col gap-1">
                <p className="flex items-center gap-2 font-medium">
                  <Dot tone="mint" /> {selected.title} is ready
                </p>
                <p className="text-sm text-dim">
                  Every clank will use it unless you give one its own.
                </p>
              </div>
              <Button
                variant="primary"
                disabled={useForCrew.isPending}
                onClick={() => useForCrew.mutate(selected.id)}
              >
                Give it to the crew
              </Button>
            </div>
          ) : pulling ? (
            <ul>
              <PullRow item={pulling} />
            </ul>
          ) : (
            <div className="flex items-center justify-between gap-6">
              <p className="text-sm text-dim">
                {formatBytes(selected.size)} to download. You can keep using the app while it does.
              </p>
              <Button
                variant="primary"
                disabled={pull.isPending}
                onClick={() => pull.mutate(selected.id)}
              >
                Pull {selected.title}
              </Button>
            </div>
          )}
          {(pull.error ?? useForCrew.error) && (
            <ErrorText>{(pull.error ?? useForCrew.error)!.message}</ErrorText>
          )}
        </section>
      )}

      <div className="flex justify-end">
        <Button variant="ghost" onClick={() => skip.mutate({ onboarded: true })}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}

function Choice(props: {
  item: CatalogItem;
  selected: boolean;
  recommended?: boolean;
  onSelect: (id: string) => void;
}) {
  const { item } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={() => props.onSelect(item.id)}
      className={`flex flex-col gap-2 rounded-2xl border p-4 text-left transition-colors ${props.selected ? 'border-accent/60 bg-accent/[0.07]' : 'border-line bg-black/20 hover:bg-white/[0.03]'}`}
    >
      <span className="flex items-start justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 font-medium">
            {item.title}
            {props.recommended && (
              <span className="font-mono text-[11px] tracking-[0.15em] text-accent uppercase">
                Recommended
              </span>
            )}
          </span>
          <span className="font-mono text-[12px] text-dim">{item.id}</span>
        </span>
        <FitBadge fit={item.fit} />
      </span>
      <span className="text-[13px] text-white/75">{item.summary}</span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-dim">
        <span>{formatBytes(item.size)}</span>
        <span>{formatTokens(item.facts.contextLength)} context</span>
        <span>{item.license}</span>
        <Capabilities capabilities={item.capabilities} />
      </span>
    </button>
  );
}

/**
 * First run's second step, once the crew has a model: a small sample project to watch the crew
 * work, from two tickets to something to approve. It's offered once, and can be passed over.
 */
export function SampleOffer() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { go } = useNav();
  const keep = (settings: Settings) =>
    queryClient.setQueryData(trpc.settings.get.queryKey(), settings);
  const skip = useMutation(trpc.settings.update.mutationOptions({ onSuccess: keep }));
  const start = useMutation(
    trpc.projects.createSample.mutationOptions({
      onSuccess: (started) => {
        void queryClient.invalidateQueries({ queryKey: trpc.settings.get.queryKey() });
        go({ page: 'project', id: started.project.id, tab: 'board' });
      },
    }),
  );

  return (
    <div className="relative mx-auto flex max-w-3xl flex-col gap-8 px-10 py-12">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">First run</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Watch the crew work</h1>
        <p className="text-dim">
          The crew has its model. A sample project shows how a board runs before you bring your own
          work: a one-page site for a coffee cart, in a new folder of its own.
        </p>
      </header>

      <Panel
        title="What happens"
        description="It runs on the model you just picked, on this machine. A few minutes on a fast one, longer on a small one."
      >
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-white/85">
          <li>
            Two tickets go on the board: Quill writes the page's copy, and Forge builds the page.
          </li>
          <li>
            Atlas signs the copy off and it waits in{' '}
            <span className="text-white">Ready for you</span>. Open it, read it, and approve it.
          </li>
          <li>
            Forge builds the page from that copy, in a copy of the folder, while you watch its files
            change. Gauge opens it in the browser and checks it, and sends it back if it's wrong.
          </li>
          <li>
            You approve the page, which merges it into the folder. Nothing leaves this computer.
          </li>
        </ol>
      </Panel>

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? 'Setting it up…' : 'Run the sample project'}
        </Button>
        <Button
          variant="ghost"
          disabled={skip.isPending}
          onClick={() => skip.mutate({ sampleOffered: true })}
        >
          Not now
        </Button>
      </div>
      {(start.error ?? skip.error) && <ErrorText>{(start.error ?? skip.error)!.message}</ErrorText>}
    </div>
  );
}
