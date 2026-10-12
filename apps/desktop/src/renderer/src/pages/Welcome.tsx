import type { FitEstimate, Settings } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Button, Disclosure, Dot, ErrorText, ProgressBar, inputClass } from '../components/ui';
import { plainJob, useCrew } from '../lib/crew';
import { formatBytes, formatDuration } from '../lib/format';
import { type CatalogItem, type SetupProgress, useModels, useSetup } from '../lib/models';
import { useNav } from '../lib/nav';
import { useTRPC } from '../lib/trpc';

/** How a model would run here, in words that need no knowledge of graphics cards. */
const FIT_WORDS: Record<FitEstimate['verdict'], string> = {
  gpu: 'Runs fast on this computer',
  partial: 'Runs on this computer',
  cpu: 'Runs on this computer, slowly',
  too_large: 'Too big for this computer',
};

/**
 * First run: who the crew is, and the one thing they need before they can start. One button
 * downloads the model that suits this computer and gives it to the crew when it's there.
 */
export function Welcome() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { route, go } = useNav();
  const crew = useCrew();
  const snapshot = useModels();
  const setup = useSetup();
  const settings = useQuery(trpc.settings.get.queryOptions()).data;
  const [chosen, setChosen] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const keep = {
    onSuccess: (next: Settings) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
  };
  const save = useMutation(trpc.settings.update.mutationOptions(keep));
  const setUp = useMutation(trpc.models.setUp.mutationOptions(keep));

  const catalog = snapshot?.catalog ?? [];
  const recommended = catalog.find((m) => m.id === snapshot?.recommended) ?? null;
  const others = catalog.filter(
    (m) =>
      m.id !== recommended?.id && m.fit && m.fit.verdict !== 'too_large' && m.capabilities.tools,
  );
  const selected = catalog.find((m) => m.id === (chosen ?? recommended?.id)) ?? null;
  const ready = Boolean(settings?.crewModel) && !setup;
  // Downloaded before, such as for a crew that was set up and then left without a model.
  const here = snapshot?.library.some((m) => m.id === selected?.id && !m.missing) ?? false;
  // On an NVIDIA card, the build that makes it fast comes with the model.
  const speedUp =
    snapshot?.hardware?.nvidia && snapshot.hardware.backend !== 'cuda'
      ? snapshot.runtime.downloadable.find((d) => d.backend === 'cuda')
      : undefined;
  const shownName = name ?? settings?.profile.name ?? '';
  const saveName = () => {
    if (!settings || name === null || name.trim() === settings.profile.name) return;
    save.mutate({ profile: { ...settings.profile, name: name.trim() } });
  };

  return (
    <div className="relative mx-auto flex max-w-2xl flex-col gap-10 px-8 py-14">
      <header className="flex flex-col items-center gap-5 text-center">
        <div className="flex -space-x-2">
          {crew.slice(0, 8).map((clank, i) => (
            <span
              key={clank.id}
              className="animate-rise rounded-full ring-4 ring-ink"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <Avatar colour={clank.avatar} size="md" />
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <h1 className="text-4xl font-semibold tracking-[-0.03em]">
            {ready ? 'Your crew is ready' : 'Meet your crew'}
          </h1>
          <p className="mx-auto max-w-xl text-[16px] leading-relaxed text-dim">
            clanks is a team of AI helpers that lives on this computer. Tell them what you want in
            your own words. They plan it, make it, check each other's work, and ask you before
            anything important.
          </p>
        </div>
      </header>

      <ul className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {crew.slice(0, 8).map((clank) => (
          <li key={clank.id} className="flex items-start gap-2.5">
            <Avatar colour={clank.avatar} size="sm" />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{clank.name}</span>
              <span className="text-[12px] leading-snug text-dim">{plainJob(clank)}</span>
            </span>
          </li>
        ))}
      </ul>

      <section className="flex flex-col gap-5 rounded-3xl border border-line bg-panel/70 p-7 backdrop-blur-xl">
        {ready ? (
          <>
            <div className="flex flex-col gap-1.5">
              <h2 className="flex items-center gap-2.5 text-lg font-medium tracking-tight">
                <Dot tone="mint" /> Everything is set up
              </h2>
              <p className="text-sm leading-relaxed text-dim">
                The crew has what it needs, and it all runs on this computer. Tell them what you
                want to make.
              </p>
            </div>
            <div>
              <Button variant="primary" size="lg" onClick={() => go({ page: 'home' })}>
                Start
              </Button>
            </div>
          </>
        ) : setup ? (
          <Downloading setup={setup} speedUp={Boolean(speedUp)} />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-medium tracking-tight">One thing before you start</h2>
              <p className="text-sm leading-relaxed text-dim">
                The crew thinks with an AI model that runs right here, so your work stays private
                and it keeps working with no internet. It's a one-time download.
              </p>
            </div>
            {!snapshot?.hardware ? (
              <p className="flex items-center gap-2 text-sm text-dim">
                <Dot tone="lavender" live /> Looking at this computer to pick the right one…
              </p>
            ) : !selected ? (
              <p className="text-sm leading-relaxed text-amber-100">
                None of the built-in models fits this computer's memory. You can still use clanks
                with a model from a provider such as Anthropic or OpenAI, using your own key: see
                "Other ways to set up" below.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-5 rounded-2xl border border-line bg-black/25 px-5 py-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2 font-medium">
                      {selected.title}
                      {selected.id === recommended?.id && (
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                          Best for this computer
                        </span>
                      )}
                    </span>
                    <span className="text-[13px] text-dim">
                      {here
                        ? 'Already on this computer'
                        : `${formatBytes(selected.size + (speedUp?.size ?? 0))} to download`}
                      {selected.fit && ` · ${FIT_WORDS[selected.fit.verdict]}`}
                    </span>
                  </div>
                  <Button
                    variant="primary"
                    size="lg"
                    disabled={setUp.isPending}
                    onClick={() => {
                      saveName();
                      setUp.mutate(selected.id);
                    }}
                  >
                    {here ? 'Set up the crew' : 'Download and set up'}
                  </Button>
                </div>
                {!here && (
                  <p className="text-[13px] leading-relaxed text-dim">
                    It takes a while on most connections. You can close the window meanwhile: clanks
                    keeps going, and the crew is ready as soon as it lands.
                  </p>
                )}
              </>
            )}
            {setUp.error && <ErrorText>{setUp.error.message}</ErrorText>}
          </>
        )}

        {!ready && (
          <label className="flex flex-col gap-2 border-t border-line pt-5">
            <span className="text-sm">
              What should the crew call you? <span className="text-dim">(optional)</span>
            </span>
            <input
              aria-label="Your name"
              placeholder="Your first name"
              className={`${inputClass} max-w-xs`}
              value={shownName}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
        )}
      </section>

      {!ready && !setup && (
        <Disclosure summary="Other ways to set up">
          <div className="flex flex-col gap-5">
            {others.length > 0 && (
              <div
                className="flex flex-col gap-2"
                role="radiogroup"
                aria-label="Model for the crew"
              >
                <p className="text-[13px] text-dim">
                  Other models that run on this computer. Smaller ones download sooner and answer
                  faster; larger ones do better work.
                </p>
                {[recommended, ...others]
                  .filter((m): m is CatalogItem => m !== null)
                  .map((item) => (
                    <Choice
                      key={item.id}
                      item={item}
                      recommended={item.id === recommended?.id}
                      selected={selected?.id === item.id}
                      onSelect={setChosen}
                    />
                  ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  save.mutate({ onboarded: true });
                  go({ page: 'settings', section: 'models' });
                }}
              >
                Use a cloud model with my own key
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  save.mutate({ onboarded: true });
                  if (route.page === 'setup') go({ page: 'home' });
                }}
              >
                Skip for now
              </Button>
            </div>
          </div>
        </Disclosure>
      )}
      {save.error && <ErrorText>{save.error.message}</ErrorText>}
    </div>
  );
}

/** The download as it goes, with the little there is to do about it. */
function Downloading({ setup, speedUp }: { setup: SetupProgress; speedUp: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { pull } = setup;
  const pause = useMutation(trpc.models.pausePull.mutationOptions());
  const resume = useMutation(trpc.models.resumePull.mutationOptions());
  const cancel = useMutation(trpc.models.cancelPull.mutationOptions());
  const again = useMutation(trpc.models.setUp.mutationOptions());
  const cancelSpeedUp = useMutation(trpc.models.cancelInstall.mutationOptions());
  // Stopping gives first run back its choices.
  const stop = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => queryClient.setQueryData(trpc.settings.get.queryKey(), next),
    }),
  );
  const error = [pause, resume, cancel, again, stop].find((m) => m.error)?.error;
  const { go } = useNav();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2.5 text-lg font-medium tracking-tight">
          <Dot tone="lavender" live={setup.state === 'downloading'} />
          {setup.state === 'paused'
            ? 'Paused'
            : setup.state === 'failed'
              ? "The download didn't finish"
              : setup.state === 'stopped'
                ? 'The download was stopped'
                : pull?.state === 'verifying'
                  ? 'Checking the download…'
                  : 'Getting your crew ready…'}
        </h2>
        <p className="text-sm leading-relaxed text-dim">
          Downloading {setup.title}
          {speedUp ? ', and what makes it fast on your graphics card' : ''}. You can close the
          window or look around meanwhile. The crew is ready as soon as it lands.
        </p>
      </div>
      <ProgressBar value={setup.progress} />
      <div className="flex items-center justify-between gap-4">
        <p className="tabular text-[13px] text-dim">
          {pull && pull.totalBytes > 0
            ? `${formatBytes(pull.doneBytes)} of ${formatBytes(pull.totalBytes)}`
            : 'Starting…'}
          {pull?.etaSeconds != null &&
            setup.state === 'downloading' &&
            ` · about ${formatDuration(pull.etaSeconds)} left`}
        </p>
        <span className="flex gap-1">
          {pull && setup.state === 'downloading' && (
            <Button size="sm" variant="ghost" onClick={() => pause.mutate(pull.id)}>
              Pause
            </Button>
          )}
          {pull && (setup.state === 'paused' || setup.state === 'failed') && (
            <Button size="sm" variant="primary" onClick={() => resume.mutate(pull.id)}>
              {setup.state === 'failed' ? 'Try again' : 'Carry on'}
            </Button>
          )}
          {setup.state === 'stopped' && (
            <Button size="sm" variant="primary" onClick={() => again.mutate(setup.modelId)}>
              Start again
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (pull) cancel.mutate(pull.id);
              // What makes it fast on the graphics card came with it, and stops with it.
              cancelSpeedUp.mutate();
              stop.mutate({ setupModel: null });
            }}
          >
            {setup.state === 'stopped' ? 'Choose another' : 'Stop'}
          </Button>
        </span>
      </div>
      {pull?.error && <ErrorText>{pull.error}</ErrorText>}
      {error && <ErrorText>{error.message}</ErrorText>}
      <div>
        <Button size="sm" onClick={() => go({ page: 'home' })}>
          Look around while it downloads
        </Button>
      </div>
    </div>
  );
}

function Choice(props: {
  item: CatalogItem;
  selected: boolean;
  recommended: boolean;
  onSelect: (id: string) => void;
}) {
  const { item } = props;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={() => props.onSelect(item.id)}
      className={`flex flex-col gap-1 rounded-2xl border px-4 py-3 text-left transition-colors ${props.selected ? 'border-accent/60 bg-accent/[0.07]' : 'border-line bg-black/20 hover:bg-white/[0.03]'}`}
    >
      <span className="flex items-baseline justify-between gap-4">
        <span className="flex items-center gap-2 text-sm font-medium">
          {item.title}
          {props.recommended && (
            <span className="text-[11px] font-medium text-accent">Best for this computer</span>
          )}
        </span>
        <span className="tabular shrink-0 text-[12px] text-dim">
          {formatBytes(item.size)}
          {item.fit && ` · ${FIT_WORDS[item.fit.verdict]}`}
        </span>
      </span>
      <span className="text-[13px] text-white/70">{item.summary}</span>
    </button>
  );
}
