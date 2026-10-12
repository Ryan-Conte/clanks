import type { BoardSnapshot, ConnectionInfo, IntegrationInfo } from '@clanks/core';
import { useMutation } from '@tanstack/react-query';
import { useCrew } from '../../lib/crew';
import { useIntegrations } from '../../lib/integrations';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { ModeBadge } from '../integrations/shared';
import { Button, ErrorText, Panel, Switch, inputClass } from '../ui';

/**
 * Which connected services this project's crew can use, and which clanks. A clank gets a service's
 * tools only where it's turned on for it here.
 */
export function ProjectIntegrations({ snapshot }: { snapshot: BoardSnapshot }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const all = useIntegrations();
  const set = useMutation(trpc.integrations.setProject.mutationOptions());
  const { project } = snapshot;
  const connected = (all?.integrations ?? []).filter(
    (integration) => integration.connections.length > 0 && !integration.disabled,
  );

  return (
    <Panel
      title="Integrations"
      description="The services this project's crew can use, and which clanks. Reads run; changes ask you first; anything that spends money, publishes or contacts people asks every time, and so does any change to a live account."
      actions={
        <Button size="sm" onClick={() => go({ page: 'settings', section: 'connections' })}>
          Connect an account
        </Button>
      }
      testId="project-integrations"
    >
      {connected.length === 0 ? (
        <p className="text-sm text-dim">
          Nothing's connected yet. Connect an account in Settings, under Connections, then turn it
          on here.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {connected.map((integration) => (
            <IntegrationRow
              key={integration.id}
              integration={integration}
              snapshot={snapshot}
              busy={set.isPending}
              onChange={(connectionId, clanks) =>
                set.mutate({ projectId: project.id, connectionId, clanks })
              }
            />
          ))}
        </ul>
      )}
      {set.error && <ErrorText>{set.error.message}</ErrorText>}
    </Panel>
  );
}

function IntegrationRow(props: {
  integration: IntegrationInfo;
  snapshot: BoardSnapshot;
  busy: boolean;
  onChange: (connectionId: string, clanks: string[] | null) => void;
}) {
  const { integration, snapshot } = props;
  const crew = useCrew();
  const members = crew.filter((c) => snapshot.project.crew.some((m) => m.clankId === c.id));
  const enabled = snapshot.integrations.find((p) => p.integrationId === integration.id);
  const connection: ConnectionInfo =
    integration.connections.find((c) => c.id === enabled?.connectionId) ??
    integration.connections[0]!;
  const on = enabled !== undefined;
  const clanks = enabled?.clanks ?? [];

  return (
    <li
      data-integration={integration.id}
      className="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0"
    >
      <div className="flex items-center gap-3">
        <Switch
          checked={on}
          disabled={props.busy}
          label={`${integration.name} in this project`}
          onChange={(next) => props.onChange(connection.id, next ? [] : null)}
        />
        <span className="text-sm font-medium">{integration.name}</span>
        {integration.connections.length > 1 ? (
          <select
            aria-label={`${integration.name} account`}
            className={`${inputClass} h-8 text-[13px]`}
            value={connection.id}
            disabled={props.busy}
            onChange={(e) => props.onChange(e.target.value, on ? clanks : [])}
          >
            {integration.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[13px] text-dim">{connection.label}</span>
        )}
        <ModeBadge mode={connection.mode} />
      </div>
      {on && (
        <div className="flex flex-wrap items-center gap-1.5 pl-14">
          {members.map((clank) => {
            const has = clanks.includes(clank.id);
            return (
              <button
                key={clank.id}
                type="button"
                aria-pressed={has}
                disabled={props.busy}
                onClick={() =>
                  props.onChange(
                    connection.id,
                    has ? clanks.filter((c) => c !== clank.id) : [...clanks, clank.id],
                  )
                }
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${has ? 'border-accent/50 bg-accent/10 text-white' : 'border-line text-dim hover:text-white'}`}
              >
                <Avatar colour={clank.avatar} size="xs" />
                {clank.name}
              </button>
            );
          })}
          {clanks.length === 0 && (
            <span className="text-[12px] text-amber-200">Pick the clanks that can use it.</span>
          )}
        </div>
      )}
    </li>
  );
}
