import { type Licence, OPEN_LICENCES } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Button, Dot, ErrorText, inputClass } from '../ui';
import { Heading, Source } from './shared';

const LICENCES: Record<Licence, string> = {
  MIT: 'Anyone can use and change it, keeping your name on it.',
  'Apache-2.0': 'Like MIT, with a grant of any patents in it.',
  'CC-BY-4.0': 'Made for writing: anyone can reuse it, crediting you.',
  'CC0-1.0': 'No conditions at all: it goes to the public domain.',
};

/**
 * Publishing a clank or an integration of the user's own: what the check found, the files exactly
 * as they'd be sent, an open licence, and a confirmation before the pull request is opened.
 */
export function Publish({ kind, id }: { kind: 'clank' | 'integration'; id: string }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const preview = useQuery(
    trpc.marketplace.publishPreview.queryOptions({ kind, id }, { staleTime: 0, gcTime: 0 }),
  );
  const [version, setVersion] = useState<string | null>(null);
  const [licence, setLicence] = useState<Licence>('MIT');
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const publish = useMutation(trpc.marketplace.publish.mutationOptions());

  if (preview.error) return <ErrorText>{preview.error.message}</ErrorText>;
  if (!preview.data) return <p className="text-sm text-dim">Checking it…</p>;
  const data = preview.data;
  const chosen = version ?? data.version;
  const blocked = data.problems.length > 0;

  if (publish.data) {
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-accent-2/25 bg-accent-2/[0.06] p-4">
        <p className="flex items-center gap-2 text-sm">
          <Dot tone="mint" /> Pull request #{publish.data.number} is open on {publish.data.repo}.
        </p>
        <p className="text-[13px] text-dim">
          A maintainer reads it before it's listed. You can follow it, and answer questions, on
          GitHub.
        </p>
        <a
          href={publish.data.url}
          target="_blank"
          rel="noreferrer noopener"
          className="self-start font-mono text-[13px] text-accent hover:underline"
        >
          {publish.data.url}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-white/85">
        {data.repo ? (
          <>
            A pull request to <code className="font-mono text-[13px]">{data.repo}</code>
            {data.publisher ? (
              <>
                {' '}
                from <span className="text-white">@{data.publisher}</span>
              </>
            ) : null}
            .{' '}
            {data.published
              ? `Version ${data.published} is published already.`
              : "It isn't on the marketplace yet."}
          </>
        ) : (
          "There's nowhere to publish to yet."
        )}
      </p>

      {blocked && (
        <div className="flex flex-col gap-2 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4">
          <p className="text-sm font-medium text-rose-200">To fix first</p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] whitespace-pre-wrap text-rose-100/90">
            {data.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          {!data.publisher && (
            <Button size="sm" className="self-start" onClick={() => go({ page: 'settings' })}>
              Open Settings
            </Button>
          )}
        </div>
      )}

      {data.warnings.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-4">
          <p className="text-sm font-medium text-amber-100">Worth a look before it's public</p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-amber-100/90">
            {data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-[13px] text-white/85">
            <input
              type="checkbox"
              className="size-4 accent-[#b9a7ff]"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I've read these, and they're meant to be there.
          </label>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Heading>What's sent, and nothing else</Heading>
        <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
          {data.files.map((file) => (
            <li key={file.path} className="flex flex-col">
              <button
                type="button"
                aria-expanded={open === file.path}
                onClick={() => setOpen(open === file.path ? null : file.path)}
                className="flex items-center gap-3 px-3.5 py-2 text-left"
              >
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-white/85">
                  {file.path.replace(data.version, chosen)}
                </code>
                <span className="text-[11px] text-dim">
                  {file.text.length.toLocaleString('en')} characters
                </span>
                <span
                  className={`text-dim transition-transform ${open === file.path ? 'rotate-90' : ''}`}
                >
                  ›
                </span>
              </button>
              {open === file.path && (
                <div className="px-3.5 pb-3">
                  <Source text={file.text} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-[9rem_1fr] items-start gap-x-4 gap-y-3 text-sm">
        <label htmlFor={`publish-version-${id}`} className="pt-2.5 text-dim">
          Version
        </label>
        <input
          id={`publish-version-${id}`}
          className={`${inputClass} w-40 font-mono text-[13px]`}
          value={chosen}
          onChange={(e) => setVersion(e.target.value.trim())}
        />
        <span className="pt-2.5 text-dim">Licence</span>
        <span className="flex flex-col gap-1.5" role="radiogroup" aria-label="Licence">
          {OPEN_LICENCES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={licence === option}
              onClick={() => setLicence(option)}
              className={`flex items-baseline gap-3 rounded-xl border px-3.5 py-2 text-left transition-colors ${licence === option ? 'border-accent/50 bg-accent/[0.07]' : 'border-line hover:bg-white/[0.03]'}`}
            >
              <span className="w-24 shrink-0 font-mono text-[12.5px] text-white">{option}</span>
              <span className="text-[13px] text-dim">{LICENCES[option]}</span>
            </button>
          ))}
        </span>
      </div>

      {confirming ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-amber-300/30 bg-amber-300/[0.06] p-4">
          <p className="text-sm text-white/90">
            This opens a public pull request on GitHub from your account. Once it's merged, anyone
            can read and install {data.name}, under the {licence} licence, for good.
          </p>
          <span className="flex gap-2">
            <Button
              variant="primary"
              disabled={publish.isPending}
              onClick={() => publish.mutate({ kind, id, version: chosen, licence, acknowledged })}
            >
              {publish.isPending ? 'Opening it…' : 'Open the pull request'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Not yet
            </Button>
          </span>
        </div>
      ) : (
        <Button
          variant="primary"
          className="self-start"
          disabled={blocked || (data.warnings.length > 0 && !acknowledged)}
          onClick={() => setConfirming(true)}
        >
          Publish {data.name} {chosen}…
        </Button>
      )}
      {publish.error && (
        <p className="text-sm whitespace-pre-wrap text-rose-300">{publish.error.message}</p>
      )}
    </div>
  );
}
