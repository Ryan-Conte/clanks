import { z } from 'zod';
import { conversationIdSchema } from './conversations';

/** A tab in a chat's browser pane. */
export interface BrowserTabInfo {
  id: string;
  /** Short, per chat: t1, t2. */
  handle: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page's renderer crashed. Reloading brings it back. */
  crashed: boolean;
  /** The tab `web_search` runs in. */
  search: boolean;
}

/** A download a page started, held until the user decides. */
export interface BrowserDownload {
  id: string;
  tabId: string;
  url: string;
  filename: string;
  /** Bytes, when the server said. */
  size: number | null;
  status: 'waiting' | 'saving' | 'saved' | 'blocked' | 'failed';
  /** Where it was saved, once it is. */
  path: string | null;
  error: string | null;
}

/** A chat's browser, as the pane shows it. */
export interface BrowserState {
  /** The app has a browser. It doesn't in tests or outside the desktop app. */
  available: boolean;
  tabs: BrowserTabInfo[];
  /** The tab the clank works in, which the pane shows. */
  current: string | null;
  /** Who's driving: the clank, or the user, who took over. */
  control: 'clank' | 'user';
  /** A browser tool is running. */
  busy: boolean;
  /** A browser tool is waiting for the user to hand back. */
  waiting: boolean;
  downloads: BrowserDownload[];
}

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().min(0).max(100_000),
  height: z.number().min(0).max(100_000),
});

/** Where the pane shows a tab, or null when it's hidden. */
export const browserShowSchema = z.object({
  conversationId: conversationIdSchema,
  tabId: z.uuid().nullable(),
  bounds: rectSchema.nullable(),
});

export const browserTabSchema = z.object({
  conversationId: conversationIdSchema,
  tabId: z.uuid(),
});

export const browserNavigateSchema = z.object({
  conversationId: conversationIdSchema,
  url: z.string().trim().min(1).max(4000),
});

export const browserDownloadDecisionSchema = z.object({
  conversationId: conversationIdSchema,
  downloadId: z.uuid(),
  save: z.boolean(),
});
