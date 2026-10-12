import {
  type BrowserState,
  browserDownloadDecisionSchema,
  browserNavigateSchema,
  browserShowSchema,
  browserTabSchema,
  clankIdSchema,
  conversationIdSchema,
} from '@clanks/core';
import { userProcedure } from '../procedures';
import { publicProcedure, router } from '../trpc';
import { snapshots } from './live';

/** The browser pane beside a chat: its tabs, who's driving, and downloads to decide on. */
export const browserRouter = router({
  /** The chat's browser, sent again whenever a tab, the driver or a download changes. */
  live: publicProcedure.input(conversationIdSchema).subscription(async function* ({
    ctx,
    input,
    signal,
  }): AsyncGenerator<BrowserState> {
    yield* snapshots({
      signal,
      intervalMs: 100,
      subscribe: (onChange) => {
        const handler = (id: string) => id === input && onChange();
        ctx.browser.on('change', handler);
        return () => ctx.browser.off('change', handler);
      },
      snapshot: () => ctx.browser.state(input),
    });
  }),

  /** Where the pane is in the window, so the tab's view sits over it. Null hides it. */
  show: publicProcedure
    .input(browserShowSchema)
    .mutation(({ ctx, input }) =>
      ctx.browser.show(input.conversationId, input.tabId, input.bounds),
    ),

  /** The user takes the wheel; the clank's browser tools wait until they hand back. */
  takeOver: userProcedure
    .input(conversationIdSchema)
    .mutation(({ ctx, input }) => ctx.browser.takeOver(input)),

  handBack: userProcedure
    .input(conversationIdSchema)
    .mutation(({ ctx, input }) => ctx.browser.handBack(input)),

  select: userProcedure
    .input(browserTabSchema)
    .mutation(({ ctx, input }) => ctx.browser.select(input.conversationId, input.tabId)),

  /** Goes to an address the user typed, while they have control. */
  navigate: userProcedure
    .input(browserNavigateSchema)
    .mutation(({ ctx, input }) => ctx.browser.navigate(input.conversationId, input.url)),

  back: userProcedure
    .input(browserTabSchema)
    .mutation(({ ctx, input }) => ctx.browser.history(input.conversationId, input.tabId, 'back')),
  forward: userProcedure
    .input(browserTabSchema)
    .mutation(({ ctx, input }) =>
      ctx.browser.history(input.conversationId, input.tabId, 'forward'),
    ),
  reload: userProcedure
    .input(browserTabSchema)
    .mutation(({ ctx, input }) => ctx.browser.history(input.conversationId, input.tabId, 'reload')),

  close: userProcedure
    .input(browserTabSchema)
    .mutation(({ ctx, input }) => ctx.browser.closeTab(input.conversationId, input.tabId)),

  /** Saves a download a page started to the user's Downloads folder, or blocks it. */
  decideDownload: userProcedure
    .input(browserDownloadDecisionSchema)
    .mutation(({ ctx, input }) =>
      ctx.browser.decideDownload(input.conversationId, input.downloadId, input.save),
    ),

  dismissDownload: userProcedure
    .input(browserDownloadDecisionSchema.pick({ conversationId: true, downloadId: true }))
    .mutation(({ ctx, input }) =>
      ctx.browser.dismissDownload(input.conversationId, input.downloadId),
    ),

  /** Signs a clank out everywhere: forgets its kept browser's cookies, storage and cache. */
  clearSession: userProcedure
    .input(clankIdSchema)
    .mutation(({ ctx, input }) => ctx.browser.clearClankSession(input)),
});
