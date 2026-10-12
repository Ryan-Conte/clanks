import type { ClankSummary, ToolPart } from '@clanks/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { memo, useState } from 'react';
import { useConversations } from '../../lib/crew';
import { formatSeconds } from '../../lib/format';
import { useTRPC } from '../../lib/trpc';
import { useWorkbench } from '../../lib/workbench';
import { ModeBadge } from '../integrations/shared';
import { ProposedRoutine } from '../routines/RoutineCard';
import { Button, Dot, ErrorText, inputClass } from '../ui';

const SETTLED = new Set<ToolPart['status']>(['done', 'failed', 'denied', 'cancelled']);

/** A tool call in a reply: what it did, and what came back. Asks first when it must. */
export const ToolCard = memo(function ToolCard(props: {
  part: ToolPart;
  conversationId: string;
  clank: ClankSummary;
  /** A question in it can be answered now. */
  answerable?: boolean;
  onAnswer?: (text: string) => void;
}) {
  const { part } = props;
  if (part.status === 'asking' && part.approval) return <ApprovalCard {...props} />;
  if (part.name === 'ask_user' && part.status === 'done') return <QuestionCard {...props} />;
  if (part.name === 'routine_propose' && part.status === 'done') {
    return <RoutineDraft part={part} conversationId={props.conversationId} />;
  }
  return <ToolRow part={part} />;
});

/** A routine a clank drafted, as a card the user edits and activates right where it was proposed. */
function RoutineDraft({ part, conversationId }: { part: ToolPart; conversationId: string }) {
  const projectId = useConversations()?.find((c) => c.id === conversationId)?.projectId;
  const routineId = /\[routine ([0-9a-f-]{36})\]/.exec(part.result ?? '')?.[1];
  if (!projectId || !routineId) return <ToolRow part={part} />;
  return (
    <div id={`tool-${part.id}`}>
      <ProposedRoutine projectId={projectId} routineId={routineId} />
    </div>
  );
}

/** A clank's question on a ticket, with its options as answers to send. */
function QuestionCard({ part, clank, answerable, onAnswer }: Parameters<typeof ToolCard>[0]) {
  let args: { question?: unknown; options?: unknown; recommendation?: unknown } = {};
  try {
    args = JSON.parse(part.arguments || '{}') as typeof args;
  } catch {
    // Shown as it was written below.
  }
  const question = typeof args.question === 'string' ? args.question : part.arguments;
  const options = Array.isArray(args.options)
    ? args.options.filter((o): o is string => typeof o === 'string')
    : [];
  const recommended = typeof args.recommendation === 'string' ? args.recommendation : '';
  return (
    <div
      id={`tool-${part.id}`}
      className={`flex flex-col gap-3 rounded-2xl border p-4 ${answerable ? 'border-amber-300/30 bg-amber-300/[0.06]' : 'border-line bg-black/20'}`}
    >
      <p className="flex items-center gap-2 text-[13px] font-medium text-amber-100">
        {answerable && <Dot tone="amber" live />}
        {clank.name} asks
      </p>
      <p className="text-[14px] whitespace-pre-wrap text-white">{question}</p>
      {recommended && <p className="text-[13px] text-dim">Recommends: {recommended}</p>}
      {options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === recommended ? 'primary' : 'secondary'}
              disabled={!answerable || !onAnswer}
              onClick={() => onAnswer?.(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {answerable && (
        <p className="text-[12px] text-dim">
          {options.length > 0 ? 'Pick one, or write' : 'Write'} your answer below. {clank.name}{' '}
          carries on when you send it.
        </p>
      )}
    </div>
  );
}

function ToolRow({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const { show } = useWorkbench();
  const settled = SETTLED.has(part.status);
  /** A design step, which Studio shows rather than the diff or the browser. */
  const design = part.name.startsWith('design_') ? part.name : null;
  const took =
    part.startedAt && part.endedAt ? formatSeconds(+part.endedAt - +part.startedAt) : null;

  return (
    <div id={`tool-${part.id}`} className="rounded-xl border border-line bg-black/20 text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <StatusMark status={part.status} />
        <span className="min-w-0 flex-1 truncate text-white/85">
          <Label text={part.label} />
        </span>
        {part.status === 'denied' && (
          <span className="text-[12px] text-rose-300">
            {part.decidedBy === 'policy' ? 'Not allowed' : 'You said no'}
          </span>
        )}
        {part.decidedBy === 'rule' && <span className="text-[11px] text-dim">always allowed</span>}
        {took && settled && <span className="font-mono text-[11px] text-dim">{took}</span>}
        <span className={`text-dim transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 border-t border-line px-3 py-2.5">
          <Section title="Arguments">{pretty(part.arguments)}</Section>
          {part.decidedBy === 'risk' && (
            <p className="text-[12px] text-dim">
              Ran without asking: an everyday call inside the clank's own worktree.
            </p>
          )}
          {part.reason && <p className="text-dim">Why not: {part.reason}</p>}
          {part.result !== null && <Section title="Result">{part.result}</Section>}
          {part.image && (part.name === 'browser_screenshot' || part.name === 'design_render') && (
            <Picture path={part.image} />
          )}
          {(part.checkpointId ?? part.sessionId ?? part.image ?? design) && (
            <div className="flex gap-2">
              {part.checkpointId && (
                <Button
                  size="sm"
                  onClick={() =>
                    show({ tab: 'diff', checkpointId: part.checkpointId!, diff: 'step' })
                  }
                >
                  Show the change
                </Button>
              )}
              {design && (
                <Button size="sm" onClick={() => show({ tab: 'studio' })}>
                  Show in Studio
                </Button>
              )}
              {part.sessionId && (
                <Button
                  size="sm"
                  onClick={() => show({ tab: 'terminal', sessionId: part.sessionId! })}
                >
                  Show in the terminal
                </Button>
              )}
              {part.image && !design && (
                <Button size="sm" onClick={() => show({ tab: 'browser', image: part.image! })}>
                  Show the page
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A tool call waiting for the user: allow it once, always in this project, or say no. */
function ApprovalCard({ part, conversationId, clank }: Parameters<typeof ToolCard>[0]) {
  const trpc = useTRPC();
  const approval = part.approval!;
  const [pattern, setPattern] = useState(approval.pattern);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const decide = useMutation(trpc.chat.decide.mutationOptions());
  const send = (decision: Parameters<typeof decide.mutate>[0]['decision']) =>
    decide.mutate({ conversationId, toolCallId: part.id, decision });
  const what = {
    command: 'run a command',
    url: part.name.startsWith('browser_') ? 'open a page' : 'fetch a page',
    path: 'use a file',
    tool: part.name.startsWith('browser_') ? 'use the browser' : `use ${part.name}`,
  }[approval.kind];
  const project = approval.scope?.split(/[\\/]/).filter(Boolean).pop();
  const service = approval.integration;

  return (
    <div
      id={`tool-${part.id}`}
      className="flex flex-col gap-3 rounded-2xl border border-amber-300/30 bg-amber-300/[0.06] p-4"
    >
      <p className="flex items-center gap-2 text-[13px] font-medium text-amber-100">
        <Dot tone="amber" live />
        {service ? (
          <span className="flex flex-wrap items-center gap-2">
            {clank.name} wants to{' '}
            {service.risk === 'outbound' ? 'make a call that goes out through' : 'change'}{' '}
            {service.name}
            <ModeBadge mode={service.mode} />
          </span>
        ) : (
          <>
            {clank.name} wants to {what}
          </>
        )}
      </p>
      {service && (
        <p className="text-[12px] text-dim">
          As the account <span className="text-white/85">{service.account}</span>, to{' '}
          <code className="font-mono text-white/85">{service.host}</code>, with{' '}
          <code className="font-mono text-white/85">{part.name}</code>. Your key is added by clanks,
          and {clank.name} never sees it.
        </p>
      )}
      <pre className="max-h-48 overflow-auto rounded-xl border border-line bg-black/40 px-3.5 py-2.5 font-mono text-[12.5px] whitespace-pre-wrap text-white">
        {approval.subject}
      </pre>
      {approval.reason && (
        <p className="text-[13px] text-amber-100/90">
          <span className="text-dim">Why it asks:</span> {approval.reason}.
        </p>
      )}
      {denying ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send({ decision: 'deny', ...(reason.trim() ? { reason: reason.trim() } : {}) });
          }}
        >
          <input
            autoFocus
            aria-label="Why not (optional)"
            placeholder={`Why not? ${clank.name} gets this. Optional.`}
            className={`${inputClass} h-8 flex-1`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button size="sm" variant="danger" type="submit" disabled={decide.isPending}>
            Deny
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDenying(false)}>
            Back
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={decide.isPending}
            onClick={() => send({ decision: 'allow' })}
          >
            Allow once
          </Button>
          {approval.scope && (
            <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-white/5 py-0.5 pr-0.5 pl-3">
              <span className="text-[12px] whitespace-nowrap text-dim">Always allow</span>
              <input
                aria-label="Always allow calls matching"
                title="* matches anything"
                className="h-7 w-44 min-w-0 rounded-full bg-black/30 px-2.5 font-mono text-[12px] text-white focus:outline-none"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!pattern.trim() || decide.isPending}
                onClick={() => send({ decision: 'always', pattern: pattern.trim() })}
                title={`Allow it now, and anything matching this in ${project ?? 'this project'} from now on`}
              >
                in {project ?? 'this project'}
              </Button>
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDenying(true)}>
            Deny…
          </Button>
          {service?.risk === 'outbound' && (
            <span className="text-[12px] text-dim">
              This kind of call asks every time, so there's no always allow.
            </span>
          )}
        </div>
      )}
      {decide.error && <ErrorText>{decide.error.message}</ErrorText>}
    </div>
  );
}

function StatusMark({ status }: { status: ToolPart['status'] }) {
  switch (status) {
    case 'done':
      return <span className="w-3 text-center text-accent-2">✓</span>;
    case 'failed':
      return <span className="w-3 text-center text-rose-300">✕</span>;
    case 'denied':
      return <span className="w-3 text-center text-rose-300">⊘</span>;
    case 'cancelled':
      return <span className="w-3 text-center text-dim">–</span>;
    default:
      return (
        <span className="grid w-3 place-items-center">
          <Dot tone="lavender" live />
        </span>
      );
  }
}

/** A label with its `code` in mono, as the orchestrator writes them. */
function Label({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((piece, i) =>
        piece.startsWith('`') && piece.endsWith('`') ? (
          <code key={i} className="font-mono text-[12px] text-white">
            {piece.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{piece}</span>
        ),
      )}
    </>
  );
}

/** A picture the tool took, such as a screenshot the clank looked at. */
function Picture({ path }: { path: string }) {
  const trpc = useTRPC();
  const picture = useQuery(trpc.chat.picture.queryOptions(path, { staleTime: Infinity }));
  if (!picture.data) return null;
  return (
    <img
      src={picture.data}
      alt="What the clank saw"
      className="max-h-80 w-full rounded-lg border border-line object-contain object-top"
    />
  );
}

function Section({ title, children }: { title: string; children: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-[0.12em] text-dim uppercase">{title}</span>
      <pre className="max-h-72 overflow-auto rounded-lg bg-black/30 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-white/80">
        {children}
      </pre>
    </div>
  );
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
  } catch {
    return raw;
  }
}
