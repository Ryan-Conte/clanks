import { TRPCClientError, type TRPCLink } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import type { ClanksIpcBridge, IpcErrorShape, IpcSubscriptionEvent } from '../../../shared/ipc';

function toClientError<TRouter extends AnyTRPCRouter>(error: IpcErrorShape) {
  return TRPCClientError.from<TRouter>({ error } as Parameters<typeof TRPCClientError.from>[0]);
}

/** A tRPC link that talks to the orchestrator through the preload bridge. */
export function ipcLink<TRouter extends AnyTRPCRouter>(bridge: ClanksIpcBridge): TRPCLink<TRouter> {
  let nextId = 1;
  const listeners = new Map<number, (event: IpcSubscriptionEvent) => void>();
  let detach: (() => void) | undefined;

  function listen(id: number, listener: (event: IpcSubscriptionEvent) => void) {
    detach ??= bridge.onSubscriptionEvent((event) => listeners.get(event.id)?.(event));
    listeners.set(id, listener);
  }

  return () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') {
          const id = nextId++;
          listen(id, (event) => {
            switch (event.kind) {
              case 'started':
                observer.next({ result: { type: 'started' } });
                break;
              case 'data':
                observer.next({ result: { type: 'data', data: event.data } });
                break;
              case 'error':
                listeners.delete(id);
                observer.error(toClientError<TRouter>(event.error));
                break;
              case 'complete':
                listeners.delete(id);
                observer.complete();
                break;
            }
          });
          bridge.subscription({ kind: 'start', id, path: op.path, input: op.input });
          return () => {
            if (listeners.delete(id)) bridge.subscription({ kind: 'stop', id });
          };
        }

        let cancelled = false;
        bridge.request({ type: op.type, path: op.path, input: op.input }).then(
          (response) => {
            if (cancelled) return;
            if (response.ok) {
              observer.next({ result: { type: 'data', data: response.data } });
              observer.complete();
            } else {
              observer.error(toClientError<TRouter>(response.error));
            }
          },
          (cause: unknown) => {
            if (!cancelled) observer.error(TRPCClientError.from<TRouter>(toError(cause)));
          },
        );
        return () => {
          cancelled = true;
        };
      });
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
