import type { ConnectionMode, IntegrationOperationInfo, OperationRisk } from '@clanks/core';
import { useState } from 'react';
import { Badge } from '../ui';

/** Whether an account is a sandbox or the real thing. Live is the one to notice. */
export function ModeBadge({ mode }: { mode: ConnectionMode }) {
  return mode === 'live' ? (
    <Badge tone="amber">Live</Badge>
  ) : (
    <Badge tone="lavender">Test mode</Badge>
  );
}

const RISK_WORDS: Record<OperationRisk, string> = {
  read: 'Reads',
  write: 'Asks first',
  outbound: 'Asks every time',
};

export function RiskBadge({ risk }: { risk: OperationRisk }) {
  return (
    <Badge tone={risk === 'read' ? 'dim' : risk === 'write' ? 'lavender' : 'amber'}>
      {RISK_WORDS[risk]}
    </Badge>
  );
}

/** The hosts an integration calls. Ones a newer version adds are marked. */
export function Hosts({ hosts, fresh = [] }: { hosts: string[]; fresh?: string[] }) {
  if (hosts.length === 0) return <span className="text-[13px] text-dim">None declared.</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {hosts.map((host) => (
        <code
          key={host}
          className={`rounded-md border px-1.5 py-0.5 font-mono text-[12px] ${fresh.includes(host) ? 'border-amber-300/40 bg-amber-300/10 text-amber-100' : 'border-line bg-white/[0.04] text-white/85'}`}
        >
          {host}
          {fresh.includes(host) && ' · new'}
        </code>
      ))}
    </span>
  );
}

/**
 * An integration's operations, each with the tool it becomes and what calling it takes: a read
 * runs, a change asks, and anything that spends money, publishes or contacts people asks every time.
 */
export function Operations({
  operations,
  mode,
  fresh = [],
  limit = 6,
}: {
  operations: IntegrationOperationInfo[];
  /** The account's mode, when showing what applies to one. */
  mode?: ConnectionMode;
  fresh?: string[];
  limit?: number;
}) {
  const [all, setAll] = useState(operations.length <= limit);
  const shown = all ? operations : operations.slice(0, limit);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
        {shown.map((operation) => {
          const live: OperationRisk = operation.risk === 'read' ? 'read' : 'outbound';
          return (
            <li key={operation.id} className="flex items-center gap-3 px-3.5 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <code className="font-mono text-[12.5px] text-white">{operation.tool}</code>
                  {fresh.includes(operation.id) && <Badge tone="amber">New</Badge>}
                </span>
                <span className="truncate text-[12px] text-dim" title={operation.summary}>
                  {operation.summary}{' '}
                  <span className="font-mono text-[11px] text-white/35">
                    {operation.calls.join(' → ')}
                  </span>
                </span>
              </span>
              {mode ? (
                <RiskBadge risk={mode === 'test' ? operation.testRisk : live} />
              ) : operation.testRisk !== operation.risk ? (
                <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-dim">
                  test <RiskBadge risk={operation.testRisk} /> live <RiskBadge risk={live} />
                </span>
              ) : (
                <RiskBadge risk={operation.risk} />
              )}
            </li>
          );
        })}
      </ul>
      {!all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="self-start text-[13px] text-dim hover:text-white"
        >
          Show all {operations.length} operations
        </button>
      )}
    </div>
  );
}

/** A small heading inside a panel, as the tools list has. */
export function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">{children}</h3>
  );
}

/** Text from a package, shown as it was written: never rendered, so nothing in it runs. */
export function Source({ text, tall = false }: { text: string; tall?: boolean }) {
  return (
    <pre
      className={`overflow-auto rounded-2xl border border-line bg-black/30 p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-white/85 ${tall ? 'max-h-[32rem]' : 'max-h-64'}`}
    >
      {text}
    </pre>
  );
}
