import { TRPCClientError, createTRPCClient } from '@trpc/client';
import { TRPCError, initTRPC } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ClanksIpcBridge, IpcSubscriptionEvent } from '../../shared/ipc';
import { ipcLink } from '../../renderer/src/lib/ipc-link';
import { createIpcHandler } from './server';

const t = initTRPC.context<{ user: string }>().create({ isServer: true });
let ticking = false;

const testRouter = t.router({
  greet: t.procedure.input(z.string()).query(({ ctx, input }) => `hi ${input}, from ${ctx.user}`),
  now: t.procedure.query(() => new Date(0)),
  add: t.procedure
    .input(z.object({ a: z.number(), b: z.number() }))
    .mutation(({ input }) => input.a + input.b),
  missing: t.procedure.query(() => {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No such ticket' });
  }),
  crash: t.procedure.query(() => {
    throw new Error('boom');
  }),
  count: t.procedure.input(z.number()).subscription(async function* ({ input }) {
    for (let i = 1; i <= input; i++) {
      await Promise.resolve();
      yield i;
    }
  }),
  ticks: t.procedure.subscription(async function* ({ signal }) {
    ticking = true;
    try {
      for (let i = 0; !signal?.aborted; i++) {
        yield i;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      ticking = false;
    }
  }),
});

/** Wires the link to the handler the way the preload bridge does, cloning like IPC does. */
function connect(onError = vi.fn()) {
  const handler = createIpcHandler({
    router: testRouter,
    createContext: () => ({ user: 'main' }),
    onError,
  });
  const listeners = new Set<(event: IpcSubscriptionEvent) => void>();
  const bridge: ClanksIpcBridge = {
    request: async (request) => structuredClone(await handler.request(structuredClone(request))),
    subscription: (message) =>
      handler.subscription(7, structuredClone(message), (event) => {
        for (const listener of listeners) listener(structuredClone(event));
      }),
    onSubscriptionEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const client = createTRPCClient<typeof testRouter>({ links: [ipcLink(bridge)] });
  return { client, handler, onError };
}

describe('tRPC over IPC', () => {
  it('runs queries and mutations with the main process context', async () => {
    const { client } = connect();
    expect(await client.greet.query('Atlas')).toBe('hi Atlas, from main');
    expect(await client.add.mutate({ a: 2, b: 3 })).toBe(5);
  });

  it('carries dates without a transformer', async () => {
    const { client } = connect();
    expect(await client.now.query()).toEqual(new Date(0));
  });

  it('turns server errors into typed client errors', async () => {
    const { client, onError } = connect();
    const error = await client.missing.query().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toMatchObject({ message: 'No such ticket', data: { code: 'NOT_FOUND' } });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }), {
      type: 'query',
      path: 'missing',
      input: undefined,
    });
  });

  it('rejects invalid input and unknown procedures', async () => {
    const { client } = connect();
    // @ts-expect-error wrong input type
    await expect(client.add.mutate({ a: 'two', b: 3 })).rejects.toMatchObject({
      data: { code: 'BAD_REQUEST' },
    });
    const untyped = client as unknown as { nope: { query(): Promise<unknown> } };
    await expect(untyped.nope.query()).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
  });

  it('reports unexpected errors as internal', async () => {
    const { client } = connect();
    await expect(client.crash.query()).rejects.toMatchObject({
      message: 'boom',
      data: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('rejects malformed requests from the window', async () => {
    const { handler } = connect();
    const response = await handler.request({ type: 'subscription', path: 'count' } as never);
    expect(response).toMatchObject({ ok: false, error: { data: { code: 'BAD_REQUEST' } } });
  });

  it('streams a subscription to completion', async () => {
    const { client } = connect();
    const values: number[] = [];
    await new Promise<void>((resolve, reject) => {
      client.count.subscribe(3, {
        onData: (value) => values.push(value),
        onComplete: resolve,
        onError: reject,
      });
    });
    expect(values).toEqual([1, 2, 3]);
  });

  it('stops a subscription when the window unsubscribes', async () => {
    const { client } = connect();
    const values: number[] = [];
    const subscription = client.ticks.subscribe(undefined, { onData: (v) => values.push(v) });
    await vi.waitFor(() => expect(values.length).toBeGreaterThanOrEqual(2));
    expect(ticking).toBe(true);
    subscription.unsubscribe();
    await vi.waitFor(() => expect(ticking).toBe(false));
  });

  it('stops every subscription a window holds when it goes away', async () => {
    const { client, handler } = connect();
    client.ticks.subscribe(undefined, {});
    await vi.waitFor(() => expect(ticking).toBe(true));
    handler.stopAll(7);
    await vi.waitFor(() => expect(ticking).toBe(false));
  });
});
