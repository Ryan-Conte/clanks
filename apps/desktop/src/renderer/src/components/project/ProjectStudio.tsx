import type { BoardSnapshot, WorkspaceState } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { type ReactNode, useState } from 'react';
import { useCrew } from '../../lib/crew';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Studio } from '../studio/Studio';
import { Button, Dot, ErrorText } from '../ui';

/**
 * Studio as a project's own view: the design in the project's folder, or the one a clank is
 * building on a ticket, picked at the top. A ticket's design becomes the project's when the
 * ticket is approved; the project's own edits reach the crew once they're committed.
 */
export function ProjectStudio({
  snapshot,
  run,
}: {
  snapshot: BoardSnapshot;
  /** The run to open on, as when a ticket's design is opened from the board. */
  run: string | null;
}) {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const queryClient = useQueryClient();
  const { project } = snapshot;
  // The board changes when a run starts, hands in or ends, which is when this list does.
  const runs = useQuery(
    trpc.design.runs.queryOptions(project.id, { staleTime: 0, refetchInterval: 5000 }),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [seenRun, setSeenRun] = useState<string | null>(null);
  if (run !== seenRun) {
    setSeenRun(run);
    setPicked(run);
  }
  const current = runs.data?.find((r) => r.conversationId === picked) ?? null;
  const status = useQuery(
    trpc.design.status.queryOptions(project.id, {
      enabled: current === null,
      refetchInterval: 4000,
    }),
  );
  const commit = useMutation(
    trpc.design.commit.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.design.status.queryKey() }),
    }),
  );
  const name = (id: string) => crew.find((c) => c.id === id)?.name ?? id;
  const changed = current === null ? (status.data?.changed ?? 0) : 0;

  const header = (
    <span className="mr-1 flex items-center gap-1.5">
      <select
        value={current?.conversationId ?? ''}
        aria-label="Which design"
        onChange={(event) => {
          setPicked(event.target.value || null);
          go({ page: 'project', id: project.id, tab: 'design', run: event.target.value || null });
        }}
        className="h-7 max-w-64 rounded-md border border-line bg-black/30 px-2 text-[12px] text-white"
      >
        <option value="">{project.name}'s design</option>
        {runs.data?.map((r) => (
          <option key={r.conversationId} value={r.conversationId}>
            {r.ticketKey ? `${r.ticketKey} · ` : ''}
            {name(r.clankId)}
            {r.replying ? ' · working' : ''}
            {r.ticketKey ? '' : ` · ${r.title}`}
          </option>
        ))}
      </select>
      {current?.replying && <Dot tone="mint" live />}
      {current && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[12px]"
          title="Open the run, with its chat beside the design"
          onClick={() => go({ page: 'chat', id: current.conversationId })}
        >
          Chat
        </Button>
      )}
      {changed > 0 && (
        <Button
          size="sm"
          className="h-7 px-2.5 text-[12px]"
          disabled={commit.isPending}
          title={`${changed} design ${changed === 1 ? 'file has' : 'files have'} changes that aren't committed. The crew's runs start from what's committed.`}
          onClick={() => commit.mutate(project.id)}
        >
          Commit the design
        </Button>
      )}
      {commit.error && <ErrorText>{commit.error.message}</ErrorText>}
    </span>
  );

  return (
    <div className="min-h-0 flex-1">
      {current ? (
        <RunStudio
          key={current.conversationId}
          conversationId={current.conversationId}
          clankName={name(current.clankId)}
          replying={current.replying}
          header={header}
        />
      ) : (
        <Studio
          key={project.id}
          source={{ projectId: project.id }}
          editable
          run={null}
          header={header}
        />
      )}
    </div>
  );
}

/** A run's design, with the run's checkpoints to compare against and its notes for the clank. */
function RunStudio(props: {
  conversationId: string;
  clankName: string;
  replying: boolean;
  header: ReactNode;
}) {
  const trpc = useTRPC();
  const [state, setState] = useState<WorkspaceState | null>(null);
  useSubscription(
    trpc.workspace.live.subscriptionOptions(props.conversationId, { onData: setState }),
  );
  return (
    <Studio
      source={{ conversationId: props.conversationId }}
      editable
      run={{
        conversationId: props.conversationId,
        clankName: props.clankName,
        replying: props.replying,
        notes: state?.notes ?? [],
        checkpoints: state?.checkpoints ?? [],
      }}
      header={props.header}
    />
  );
}
