import type { ClankSummary, ClankToolPolicy, ToolPolicyLevel } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Badge, Button, ErrorText, Panel } from '../ui';

const GROUPS: Record<ClankToolPolicy['group'], string> = {
  files: 'Files',
  shell: 'Commands',
  git: 'Git',
  web: 'Web',
  browser: 'Browser',
  design: 'Design',
  board: 'Board',
  spec: 'Spec',
  review: 'Review',
  crew: 'Crew',
  context: 'Context and memory',
  artifacts: 'Artifacts',
  routines: 'Routines',
  mcp: 'MCP servers',
  integration: 'Connected services',
};

const LEVELS: [ToolPolicyLevel, string][] = [
  ['allow', 'Allow'],
  ['ask', 'Ask'],
  ['deny', 'Deny'],
  ['off', 'Off'],
];

/** Which tools a clank has, and whether each runs, asks first or is refused. */
export function ToolsPanel({ clank }: { clank: ClankSummary }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { go } = useNav();
  const [later, setLater] = useState(false);
  const policies = useQuery(trpc.tools.policies.queryOptions(clank.id));
  const set = useMutation(
    trpc.tools.setPolicy.mutationOptions({
      onSuccess: () =>
        queryClient.invalidateQueries({ queryKey: trpc.tools.policies.queryKey(clank.id) }),
    }),
  );
  const shown = (policies.data ?? []).filter((p) => later || p.available);
  const groups = [...new Set(shown.map((p) => p.group))];
  const hidden = (policies.data ?? []).filter((p) => !p.available).length;

  return (
    <Panel
      title="Tools"
      description={
        <>
          What {clank.name} can use. <b className="font-medium text-white/80">Ask</b> waits for your
          approval in the chat, where you can also always allow a command or site for a project.
          Your choices here win over the priming doc's.
          {clank.marketplace &&
            ' It came from a marketplace, so whatever its doc allows, nothing above read starts higher than ask.'}
        </>
      }
      actions={
        <Button size="sm" variant="ghost" onClick={() => go({ page: 'settings' })}>
          MCP servers
        </Button>
      }
    >
      {policies.error && <ErrorText>{policies.error.message}</ErrorText>}
      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <section key={group} className="flex flex-col gap-1">
            <h3 className="text-[11px] font-medium tracking-[0.15em] text-dim uppercase">
              {GROUPS[group]}
            </h3>
            <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
              {shown
                .filter((p) => p.group === group)
                .map((policy) => (
                  <li key={policy.name} className="flex items-center gap-4 px-4 py-2.5">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <code className="font-mono text-[12.5px] text-white">{policy.name}</code>
                        {!policy.available && <Badge>Later</Badge>}
                        {policy.locked && <Badge tone="amber">Asks every time</Badge>}
                        {policy.overridden && (
                          <button
                            type="button"
                            className="text-[11px] text-dim underline-offset-2 hover:text-white hover:underline"
                            title="Go back to what the priming doc says"
                            onClick={() =>
                              set.mutate({ clankId: clank.id, tool: policy.name, level: null })
                            }
                          >
                            doc says {policy.defaultLevel} · reset
                          </button>
                        )}
                      </span>
                      {policy.description && (
                        <span className="truncate text-[12px] text-dim" title={policy.description}>
                          {policy.description}
                        </span>
                      )}
                    </span>
                    <span
                      className="flex shrink-0 rounded-full border border-line bg-black/20 p-0.5"
                      role="radiogroup"
                      aria-label={`${policy.name} policy`}
                    >
                      {LEVELS.map(([level, label]) => (
                        <button
                          key={level}
                          type="button"
                          role="radio"
                          aria-checked={policy.level === level}
                          disabled={set.isPending || (policy.locked === true && level === 'allow')}
                          title={
                            policy.locked && level === 'allow'
                              ? 'It spends money, publishes or contacts people, or changes a live account, so it asks every time'
                              : undefined
                          }
                          onClick={() =>
                            set.mutate({ clankId: clank.id, tool: policy.name, level })
                          }
                          className={`rounded-full px-2.5 py-0.5 text-[12px] transition-colors ${
                            policy.level === level
                              ? level === 'deny'
                                ? 'bg-rose-400/20 text-rose-200'
                                : level === 'ask'
                                  ? 'bg-amber-300/15 text-amber-100'
                                  : level === 'allow'
                                    ? 'bg-accent-2/15 text-accent-2'
                                    : 'bg-white/10 text-white'
                              : 'text-dim hover:text-white disabled:opacity-30 disabled:hover:text-dim'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setLater((l) => !l)}
          className="self-start text-[13px] text-dim hover:text-white"
        >
          {later ? 'Hide' : 'Show'} {hidden} tools that arrive in later milestones
        </button>
      )}
      {set.error && <ErrorText>{set.error.message}</ErrorText>}
    </Panel>
  );
}
