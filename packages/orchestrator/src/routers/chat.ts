import {
  type ChatLiveEvent,
  type ConversationSummary,
  clankIdSchema,
  conversationIdSchema,
  newConversationSchema,
  sendMessageSchema,
} from '@clanks/core';
import { z } from 'zod';
import { ChatError } from '../chat/service';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';

/** The conversation list is sent again at most this often, however busy the chats are. */
const LIST_INTERVAL_MS = 150;

export const chatRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.chat.list()),

  /** The conversation list, sent again whenever it changes. */
  conversations: publicProcedure.subscription(async function* ({
    ctx,
    signal,
  }): AsyncGenerator<ConversationSummary[]> {
    let dirty = true;
    let wake: (() => void) | undefined;
    const onChange = () => {
      dirty = true;
      wake?.();
    };
    ctx.chat.on('list', onChange);
    // A renamed clank shows under its new name.
    ctx.crew.on('change', onChange);
    signal?.addEventListener('abort', onChange, { once: true });
    try {
      while (!signal?.aborted) {
        if (!dirty) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          if (signal?.aborted) break;
        }
        dirty = false;
        yield ctx.chat.list();
        await new Promise((resolve) => setTimeout(resolve, LIST_INTERVAL_MS));
      }
    } finally {
      ctx.chat.off('list', onChange);
      ctx.crew.off('change', onChange);
    }
  }),

  get: userProcedure.input(conversationIdSchema).query(({ ctx, input }) => ctx.chat.get(input)),

  /** A conversation's messages as they change, starting with the reply being written now. */
  live: publicProcedure.input(conversationIdSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }): AsyncGenerator<ChatLiveEvent> {
    const queue: ChatLiveEvent[] = [];
    let wake: (() => void) | undefined;
    const onEvent = (conversationId: string, event: ChatLiveEvent) => {
      if (conversationId !== input) return;
      // Deltas for the same reply are merged while they wait, so a slow window catches up.
      const last = queue.at(-1);
      if (event.type === 'delta' && last?.type === 'delta' && last.messageId === event.messageId) {
        last.text += event.text;
        last.reasoning += event.reasoning;
      } else {
        queue.push(event.type === 'delta' ? { ...event } : event);
      }
      wake?.();
    };
    const onAbort = () => wake?.();
    // Listening starts before the catch-up is read, in the same tick, so nothing falls between.
    ctx.chat.on('live', onEvent);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const current = ctx.chat.inFlight(input);
      if (current) yield { type: 'message', message: current };
      while (!signal?.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          continue;
        }
        yield queue.shift()!;
      }
    } finally {
      ctx.chat.off('live', onEvent);
      signal?.removeEventListener('abort', onAbort);
    }
  }),

  /** Starts a chat with its first message. */
  start: userProcedure
    .input(newConversationSchema)
    .mutation(({ ctx, input }) => ctx.chat.start(input.clankId, input.text)),

  send: userProcedure
    .input(sendMessageSchema)
    .mutation(({ ctx, input }) => ctx.chat.send(input.conversationId, input.text)),

  retry: userProcedure
    .input(conversationIdSchema)
    .mutation(({ ctx, input }) => ctx.chat.retry(input)),

  stop: userProcedure
    .input(conversationIdSchema)
    .mutation(({ ctx, input }) => ctx.chat.stop(input)),

  rename: userProcedure
    .input(z.object({ id: conversationIdSchema, title: z.string().trim().min(1).max(120) }))
    .mutation(({ ctx, input }) => ctx.chat.rename(input.id, input.title)),

  delete: userProcedure
    .input(conversationIdSchema)
    .mutation(({ ctx, input }) => ctx.chat.delete(input)),

  /** Asks for a folder, then points the chat at it. Resolves null if the user cancels. */
  pickFolder: userProcedure.input(conversationIdSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.host) throw new ChatError("Picking a folder needs the app's file dialog");
    const current = ctx.chat.get(input).conversation.folder;
    const folder = await ctx.host.pickFolder({
      title: 'Chat about a folder',
      ...(current ? { defaultPath: current } : {}),
    });
    return folder ? ctx.chat.setFolder(input, folder) : null;
  }),

  clearFolder: userProcedure
    .input(conversationIdSchema)
    .mutation(({ ctx, input }) => ctx.chat.setFolder(input, null)),

  /** What a clank is told before a chat: its system prompt, layer by layer. */
  preview: userProcedure
    .input(z.object({ clankId: clankIdSchema, conversationId: conversationIdSchema.nullable() }))
    .query(({ ctx, input }) => ctx.chat.preview(input.clankId, input.conversationId)),
});
