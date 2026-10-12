import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { formatBytes } from '../../lib/format';
import { useModels } from '../../lib/models';
import { useTRPC } from '../../lib/trpc';
import { Button, ErrorText, Panel, ProgressBar, Row } from '../ui';

/** Where the models live, how much room they take, and moving them to another drive. */
export function StoragePanel() {
  const trpc = useTRPC();
  const snapshot = useModels();
  const storage = useQuery(trpc.models.storage.queryOptions());
  const move = useMutation(trpc.models.moveStorage.mutationOptions());
  const open = useMutation(trpc.models.openStorage.mutationOptions());
  const dismiss = useMutation(trpc.models.dismissMoveError.mutationOptions());
  const moving = snapshot?.move ?? null;

  // Pulls, removals and moves change what's on disk.
  const libraryKey = snapshot?.library.map((m) => m.id).join() ?? '';
  const moveKey = moving ? (moving.error ? 'failed' : 'moving') : 'idle';
  const { refetch } = storage;
  useEffect(() => {
    void refetch();
  }, [libraryKey, moveKey, refetch]);

  return (
    <Panel
      title="Storage"
      actions={
        <>
          <Button size="sm" variant="ghost" onClick={() => open.mutate()}>
            Open folder
          </Button>
          <Button
            size="sm"
            disabled={move.isPending || (moving !== null && !moving.error)}
            onClick={() => move.mutate()}
          >
            Move…
          </Button>
        </>
      }
    >
      {storage.data && (
        <dl className="divide-y divide-line text-sm">
          <Row label="Models folder">
            <span className="font-mono text-[13px] break-all">{storage.data.dir}</span>
          </Row>
          <Row label="Used">
            {formatBytes(storage.data.usedBytes)}
            <span className="text-dim">
              {' '}
              · {formatBytes(storage.data.freeBytes)} free on this drive
            </span>
          </Row>
        </dl>
      )}
      {moving && !moving.error && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm">
            Moving to <span className="font-mono text-[13px]">{moving.to}</span>. Pulls are paused
            and models unloaded until it's done.
          </p>
          <ProgressBar value={moving.totalBytes ? moving.doneBytes / moving.totalBytes : 0} />
        </div>
      )}
      {moving?.error && (
        <div className="flex items-center justify-between gap-4">
          <ErrorText>The models didn't move: {moving.error}</ErrorText>
          <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()}>
            Dismiss
          </Button>
        </div>
      )}
      {storage.error && <ErrorText>{storage.error.message}</ErrorText>}
      {(move.error ?? open.error) && <ErrorText>{(move.error ?? open.error)!.message}</ErrorText>}
    </Panel>
  );
}
