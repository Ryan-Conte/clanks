import {
  type AnyTRPCRouter,
  type inferRouterContext,
  TRPCError,
  callTRPCProcedure,
  getTRPCErrorFromUnknown,
  getTRPCErrorShape,
} from '@trpc/server';
import { isObservable } from '@trpc/server/observable';
import type {
  IpcErrorShape,
  IpcRequest,
  IpcResponse,
  IpcSubscriptionEvent,
  IpcSubscriptionMessage,
} from '../../shared/ipc';

export interface IpcHandlerOptions<TRouter extends AnyTRPCRouter> {
  router: TRouter;
  createContext: () => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
  onError?: (error: TRPCError, call: { type: string; path: string }) => void;
}

export interface IpcHandler {
  request(request: IpcRequest): Promise<IpcResponse>;
  /** Starts or stops a subscription for one window, identified by `senderId`. */
  subscription(
    senderId: number,
    message: IpcSubscriptionMessage,
    send: (event: IpcSubscriptionEvent) => void,
  ): void;
  /** Stops every subscription a window holds, when it reloads or closes. */
  stopAll(senderId: number): void;
}

/** Serves a tRPC router to windows. Knows nothing of Electron, so it can be tested without it. */
export function createIpcHandler<TRouter extends AnyTRPCRouter>(
  options: IpcHandlerOptions<TRouter>,
): IpcHandler {
  const { router, createContext, onError } = options;
  const subscriptions = new Map<string, AbortController>();

  function fail(
    cause: unknown,
    call: { type: 'query' | 'mutation' | 'subscription'; path: string; input: unknown },
    ctx: unknown,
  ): IpcErrorShape {
    const error = getTRPCErrorFromUnknown(cause);
    onError?.(error, call);
    return getTRPCErrorShape({
      config: router._def._config,
      error,
      type: call.type,
      path: call.path,
      input: call.input,
      ctx,
    }) as IpcErrorShape;
  }

  async function request(request: IpcRequest): Promise<IpcResponse> {
    // Requests come from a window, so check their shape before trusting it.
    const type = request?.type;
    const path = typeof request?.path === 'string' ? request.path : '';
    const input = request?.input;
    let ctx: unknown;
    try {
      if (type !== 'query' && type !== 'mutation') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown request type' });
      }
      ctx = await createContext();
      const data: unknown = await callTRPCProcedure({
        router,
        ctx,
        path,
        type,
        getRawInput: () => Promise.resolve(input),
        signal: undefined,
        batchIndex: 0,
      });
      return { ok: true, data };
    } catch (cause) {
      const callType = type === 'mutation' ? 'mutation' : 'query';
      return { ok: false, error: fail(cause, { type: callType, path, input }, ctx) };
    }
  }

  async function run(
    key: string,
    controller: AbortController,
    { id, path, input }: Extract<IpcSubscriptionMessage, { kind: 'start' }>,
    send: (event: IpcSubscriptionEvent) => void,
  ): Promise<void> {
    const { signal } = controller;
    const aborted = new Promise<'aborted'>((resolve) =>
      signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
    );
    let ctx: unknown;
    try {
      ctx = await createContext();
      const result: unknown = await callTRPCProcedure({
        router,
        ctx,
        path,
        type: 'subscription',
        getRawInput: () => Promise.resolve(input),
        signal,
        batchIndex: 0,
      });
      if (signal.aborted) return;
      send({ id, kind: 'started' });

      if (isObservable(result)) {
        await new Promise<void>((resolve, reject) => {
          const subscription = result.subscribe({
            next: (data) => send({ id, kind: 'data', data }),
            error: reject,
            complete: resolve,
          });
          void aborted.then(() => {
            subscription.unsubscribe();
            resolve();
          });
        });
      } else if (isAsyncIterable(result)) {
        const iterator = result[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (next === 'aborted') {
            await iterator.return?.();
            break;
          }
          if (next.done) break;
          send({ id, kind: 'data', data: next.value });
        }
      } else {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Subscription ${path} returned neither an async iterable nor an observable`,
        });
      }
      if (!signal.aborted) send({ id, kind: 'complete' });
    } catch (cause) {
      if (!signal.aborted) {
        send({ id, kind: 'error', error: fail(cause, { type: 'subscription', path, input }, ctx) });
      }
    } finally {
      if (subscriptions.get(key) === controller) subscriptions.delete(key);
    }
  }

  return {
    request,

    subscription(senderId, message, send) {
      const key = `${senderId}:${message?.id}`;
      if (message?.kind === 'stop') {
        subscriptions.get(key)?.abort();
        subscriptions.delete(key);
        return;
      }
      if (message?.kind !== 'start' || typeof message.path !== 'string') return;
      if (subscriptions.has(key)) return;
      const controller = new AbortController();
      subscriptions.set(key, controller);
      void run(key, controller, message, send);
    },

    stopAll(senderId) {
      const prefix = `${senderId}:`;
      for (const [key, controller] of subscriptions) {
        if (!key.startsWith(prefix)) continue;
        controller.abort();
        subscriptions.delete(key);
      }
    },
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
