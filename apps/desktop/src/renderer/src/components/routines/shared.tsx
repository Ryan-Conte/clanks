import type { ScheduledActionInfo } from '@clanks/core';
import { isMediaMarker } from '@clanks/routines';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { ACTION_STATUS, when } from '../../lib/routines';
import { useTRPC } from '../../lib/trpc';
import { ModeBadge } from '../integrations/shared';
import { Badge, IconButton, XIcon } from '../ui';

/** A dialog over the window: Escape or a click outside closes it. */
export function Dialog(props: {
  title: string;
  actions?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-6 pt-14 backdrop-blur-sm"
      role="dialog"
      aria-label={props.title}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={`flex w-full flex-col overflow-hidden rounded-3xl border border-line bg-panel shadow-2xl ${props.wide ? 'max-w-5xl' : 'max-w-3xl'}`}
      >
        <header className="flex items-center gap-3 border-b border-line px-6 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{props.title}</h2>
          {props.actions}
          <IconButton label="Close" onClick={onClose}>
            <XIcon />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">{props.children}</div>
      </div>
    </div>
  );
}

/** A small heading over a group of fields. */
export function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">{children}</h3>
  );
}

/** A labelled field in a form. */
export function Field(props: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${props.className ?? ''}`}>
      <span className="text-[12px] text-dim">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-[12px] text-dim">{props.hint}</span>}
    </label>
  );
}

/** A file an action sends, shown as the picture it is. */
function MediaPicture({
  actionId,
  sha256,
  name,
}: {
  actionId: string;
  sha256: string;
  name: string;
}) {
  const trpc = useTRPC();
  const picture = useQuery(
    trpc.routines.media.queryOptions({ actionId, sha256 }, { staleTime: Infinity }),
  );
  if (!picture.data) {
    return (
      <p className="rounded-xl border border-dashed border-line px-3 py-2 text-[12px] text-dim">
        {name}
      </p>
    );
  }
  return (
    <figure className="flex flex-col gap-1">
      <img
        src={picture.data.url}
        alt={name}
        className="max-h-72 w-full rounded-xl border border-line bg-white/5 object-contain"
      />
      <figcaption className="font-mono text-[11px] text-dim">{name}</figcaption>
    </figure>
  );
}

/**
 * An action as it will go out: the account, the time, the words and the pictures. This is what
 * the user approves, so it shows exactly what's kept and nothing else.
 */
export function ActionPreview(props: {
  action: ScheduledActionInfo;
  zone: string;
  now: Date;
  children?: ReactNode;
}) {
  const { action } = props;
  const status = ACTION_STATUS[action.status];
  const files = Object.values(action.payload ?? {}).filter(isMediaMarker);
  // A file is shown as the picture it is, not listed again by its name.
  const pictured = new Set(
    Object.entries(action.payload ?? {})
      .filter(([, value]) => isMediaMarker(value))
      .map(([name]) => name),
  );
  const fields = action.fields.filter((field) => !pictured.has(field.name));
  const waiting = action.payload === null;
  return (
    <article
      id={`action-${action.id}`}
      className={`flex flex-col gap-3 rounded-2xl border p-4 ${action.status === 'pending_approval' ? 'border-amber-300/30 bg-amber-300/[0.05]' : 'border-line bg-black/20'}`}
    >
      <header className="flex flex-wrap items-center gap-2 text-[12px]">
        <Badge tone="lavender">{action.integrationName}</Badge>
        {action.connectionLabel && (
          <span className="font-mono text-white/80">{action.connectionLabel}</span>
        )}
        {action.mode && <ModeBadge mode={action.mode} />}
        <span className="ml-auto">
          <Badge tone={status.tone}>{status.text}</Badge>
        </span>
      </header>
      <p className="text-[13px] text-white/85">
        {action.status === 'done'
          ? action.result?.handedOff
            ? `Handed to ${action.integrationName}, to go out `
            : 'Went out '
          : ['missed', 'failed', 'cancelled', 'unknown'].includes(action.status)
            ? 'Was due '
            : action.delivery === 'hand_off'
              ? `${action.integrationName} sends it `
              : 'Goes out '}
        <span className="font-medium text-white">
          {when(action.executeAt, props.zone, props.now)}
        </span>
        <span className="text-dim"> · {action.operationSummary.replace(/\.$/, '')}</span>
      </p>
      {waiting ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-3 text-[13px] text-dim">
          What it sends is built once the work it waits on is signed off.
        </p>
      ) : (
        <>
          {files.map((file) => (
            <MediaPicture
              key={file.$media}
              actionId={action.id}
              sha256={file.$media}
              name={action.media.find((m) => m.sha256 === file.$media)?.name ?? 'A file'}
            />
          ))}
          {action.text !== null && (
            <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-white">
              {action.text}
            </p>
          )}
          {fields.length > 0 && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[12px]">
              {fields.map((field) => (
                <div key={field.name} className="contents">
                  <dt className="text-dim">{field.name}</dt>
                  <dd className="min-w-0 break-words text-white/80">{field.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
      {action.problems.map((problem) => (
        <p key={problem} className="text-[13px] text-rose-300">
          {problem}
        </p>
      ))}
      {action.error && !action.problems.includes(action.error) && (
        <p
          className={`text-[13px] ${action.status === 'approved' ? 'text-dim' : 'text-amber-200'}`}
        >
          {action.error}
        </p>
      )}
      {action.result && (
        <p className="text-[12px] text-dim">
          {action.result.url ? (
            <a href={action.result.url} target="_blank" rel="noreferrer" className="text-accent">
              {action.result.url}
            </a>
          ) : (
            action.result.summary
          )}
        </p>
      )}
      {props.children}
    </article>
  );
}
