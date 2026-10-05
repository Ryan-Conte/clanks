import type { CdpSession } from './cdp';

/** Where something sits in the app window, in its CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a tab is showing. */
export interface TabState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page's renderer crashed. Reloading brings it back. */
  crashed: boolean;
}

/** A download a page started. Nothing is saved until the user approves it. */
export interface DownloadRequest {
  url: string;
  filename: string;
  /** Bytes, when the server says. */
  size: number | null;
  mimeType: string;
}

/** What a tab tells the browser service as it happens. */
export interface TabEvents {
  state(state: TabState): void;
  /** A page asked for a new window. It opens as a tab instead, if the guard lets it. */
  windowOpen(url: string): void;
  /** A page started a download. It was stopped; it runs again only if the user approves. */
  download(request: DownloadRequest): void;
}

/** Tabs that share a key share cookies and storage; nothing else does. */
export interface SessionKey {
  key: string;
  /** Kept on disk, so a clank stays signed in. Otherwise it lives in memory until the app quits. */
  persistent: boolean;
}

/** One page in its own view, isolated from the app and from the user's own browser. */
export interface HostTab {
  readonly id: string;
  readonly cdp: CdpSession;
  /** Settles once the tab has a page (a blank one at first), which CDP needs to answer. */
  readonly ready: Promise<void>;
  /** Resolves when the page has loaded; rejects with the browser's reason when it can't. */
  load(url: string): Promise<void>;
  back(): void;
  forward(): void;
  reload(): void;
  /** The page as the user sees it, as a JPEG at most `maxWidth` pixels wide. */
  capture(options: { maxWidth: number; quality: number }): Promise<Uint8Array>;
  /** Runs a download the user approved. Resolves with where it was saved. */
  download(url: string): Promise<string>;
  close(): void;
}

/** What the desktop app does for the browser: views, sessions and layout. */
export interface BrowserHost {
  open(options: {
    session: SessionKey;
    /**
     * Whether a frame may load `url`. Checked on every navigation of the page and its frames,
     * redirects included.
     */
    guard: (url: string, mainFrame: boolean) => boolean;
    events: TabEvents;
  }): HostTab;
  /** Shows a tab in the browser pane at `bounds`, or hides the pane. */
  display(tabId: string | null, bounds: Rect | null): void;
  /** Forgets a session's cookies, storage and cache. */
  clearSession(session: SessionKey): Promise<void>;
}
