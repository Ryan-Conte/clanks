import {
  type BrowserHost,
  BrowserError,
  type BrowserSearchResult,
  type DownloadRequest,
  type HostTab,
  PageDriver,
  type Rect,
  SEARCH_HOST,
  SEARCH_RESULTS,
  type SessionKey,
  isAborted,
  netErrorText,
  searchUrl,
  siteRefusal,
} from '@clanks/browser';
import type { BrowserDownload, BrowserState, BrowserTabInfo, ClankBrowser } from '@clanks/core';
import {
  type BrowserAccess,
  type BrowserResult,
  type SearchResult,
  type ToolImage,
  ToolFailure,
} from '@clanks/tools';
import { headTail } from '@clanks/workspace';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** A clank can have this many tabs open in one chat. */
const MAX_TABS = 8;
/** How long a step waits for a page before going on with what has loaded. */
const LOAD_TIMEOUT_MS = 20_000;
/** How long a browser tool waits for the user to hand back before giving up. */
const HAND_BACK_WAIT_MS = 15 * 60_000;
/** The page after each step, kept for the user. */
const THUMBNAIL = { maxWidth: 960, quality: 60 };
/** What a model that can see gets from `browser_screenshot`. */
const SCREENSHOT = { maxWidth: 1280, quality: 75 };

interface Tab {
  info: BrowserTabInfo;
  host: HostTab;
  driver: PageDriver;
  /** Settles once the driver is listening to the page. */
  ready: Promise<void>;
  /** Pages the guard refused since the clank last heard. */
  blocked: string[];
}

interface ChatBrowser {
  conversationId: string;
  clankId: string;
  session: SessionKey;
  tabs: Tab[];
  current: string | null;
  control: 'clank' | 'user';
  /** Browser tools running now, and waiting for the user to hand back. */
  busy: number;
  waiting: number;
  handBack: Set<() => void>;
  downloads: BrowserDownload[];
  /** What happened in the browser that the clank hasn't heard about yet. */
  notes: string[];
  counter: number;
}

export interface BrowserServiceOptions {
  /** Null outside the desktop app, where there's no browser. */
  host: BrowserHost | null;
  /** A clank's site lists and whether its browser keeps cookies, as its profile says now. */
  settings: (clankId: string) => ClankBrowser;
  userName: () => string;
}

/**
 * The browser pane: every chat's tabs, who's driving, and downloads waiting for the user. Clanks
 * reach it through `access`, one tool call at a time; the window watches `change`.
 */
export class BrowserService extends EventEmitter<{ change: [conversationId: string] }> {
  private readonly chats = new Map<string, ChatBrowser>();
  /** The tab the pane shows, if any. */
  private displayed: { conversationId: string; tabId: string } | null = null;

  constructor(private readonly options: BrowserServiceOptions) {
    super();
    this.setMaxListeners(100);
  }

  get available(): boolean {
    return this.options.host !== null;
  }

  state(conversationId: string): BrowserState {
    const chat = this.chats.get(conversationId);
    return {
      available: this.available,
      tabs: chat?.tabs.map((t) => ({ ...t.info })) ?? [],
      current: chat?.current ?? null,
      control: chat?.control ?? 'clank',
      busy: (chat?.busy ?? 0) > 0,
      waiting: (chat?.waiting ?? 0) > 0,
      downloads: chat?.downloads.map((d) => ({ ...d })) ?? [],
    };
  }

  /** The browser for one tool call by a clank. */
  access(
    conversationId: string,
    clank: { id: string; name: string },
    options: { signal: AbortSignal; maxChars: number },
  ): BrowserAccess {
    const { signal, maxChars } = options;
    const chat = () => this.chat(conversationId, clank.id);
    const tabStep = (
      run: (tab: Tab, chat: ChatBrowser) => Promise<BrowserResult>,
      thumbnail = true,
    ) =>
      this.step(
        chat(),
        signal,
        async (c) => {
          const tab = this.currentTab(c);
          await tab.ready;
          return run(tab, c);
        },
        thumbnail,
      );
    /** The page as text, from a line on, as browser_read gives it. */
    const page = async (tab: Tab, fromLine = 1) => {
      const snapshot = await tab.driver.snapshot();
      const header = [
        snapshot.title || '(no title)',
        snapshot.url,
        ...(tab.driver.loading
          ? ['(The page is still loading; read it again if parts are missing.)']
          : []),
      ].join('\n');
      return pageText(header, snapshot.lines, fromLine, maxChars);
    };
    /** After an action: the new page if it led to one, else nothing more. */
    const landed = async (tab: Tab, before: string) =>
      tab.driver.currentUrl === before ? '' : ` It led to a new page:\n\n${await page(tab)}`;

    return {
      open: (url) =>
        this.step(chat(), signal, async (c) => {
          this.checkSite(c, url);
          if (c.tabs.length >= MAX_TABS) {
            throw new BrowserError(
              `There are ${MAX_TABS} tabs open already. Close one with browser_close first.`,
            );
          }
          const tab = this.newTab(c, false);
          c.current = tab.info.id;
          this.changed(c);
          const status = await this.load(c, tab, url);
          return {
            content: `Opened ${tab.info.handle}, now the current tab.${status}\n\n${await page(tab)}`,
          };
        }),

      navigate: (url) =>
        this.step(chat(), signal, async (c) => {
          this.checkSite(c, url);
          let tab = c.current ? this.tab(c, c.current) : undefined;
          if (!tab) {
            tab = this.newTab(c, false);
            c.current = tab.info.id;
            this.changed(c);
          }
          await tab.ready;
          const status = await this.load(c, tab, url);
          return { content: `Went to ${url}.${status}\n\n${await page(tab)}` };
        }),

      read: (fromLine) => tabStep(async (tab) => ({ content: await page(tab, fromLine) })),

      click: (ref) =>
        tabStep(async (tab) => {
          const before = tab.driver.currentUrl;
          await tab.driver.click(ref);
          return { content: `Clicked [${ref}].${await landed(tab, before)}` };
        }),

      type: (ref, text, submit) =>
        tabStep(async (tab) => {
          const before = tab.driver.currentUrl;
          const value = await tab.driver.type(ref, text, submit);
          const holds = value.length > 200 ? `${value.slice(0, 199)}…` : value;
          return {
            content: `Typed into [${ref}]; it now holds "${holds}".${submit ? ' Pressed Enter.' : ''}${await landed(tab, before)}`,
          };
        }),

      press: (keys) =>
        tabStep(async (tab) => {
          const before = tab.driver.currentUrl;
          await tab.driver.press(keys);
          return { content: `Pressed ${keys}.${await landed(tab, before)}` };
        }),

      scroll: (direction, ref) =>
        tabStep(async (tab) => {
          const { before, after } = await tab.driver.scroll(direction, ref);
          if (ref !== null) return { content: `Scrolled [${ref}] into view.` };
          if (after.top === before.top) {
            return {
              content: `The page didn't move: it's at the ${direction === 'down' ? 'bottom' : 'top'} already, or it scrolls inside a box. To reach something in a box, scroll to its ref.`,
            };
          }
          const range = Math.max(1, after.height - after.viewport);
          const share = Math.min(100, Math.round((after.top / range) * 100));
          return { content: `Scrolled ${direction}. The page is now ${share}% of the way down.` };
        }),

      screenshot: () =>
        tabStep(async (tab) => {
          const data = await tab.host.capture(SCREENSHOT);
          return {
            content: `A screenshot of ${await describe(tab)}, as it looks in the browser pane.`,
            image: { data, mediaType: 'image/jpeg' },
          };
        }, false),

      console: () =>
        tabStep((tab) => {
          const entries = tab.driver.console();
          if (entries.length === 0) {
            return Promise.resolve({ content: "The page hasn't logged anything since it loaded." });
          }
          const lines = entries.map(
            (e) => `[${e.level}] ${e.text}${e.source ? ` (${e.source})` : ''}`,
          );
          return Promise.resolve({ content: headTail(lines.join('\n'), maxChars) });
        }, false),

      back: () =>
        tabStep(async (tab) => {
          if (!(await tab.driver.back()))
            return { content: "There's no earlier page in this tab." };
          return { content: `Went back.\n\n${await page(tab)}` };
        }),

      close: () =>
        this.step(
          chat(),
          signal,
          (c) => {
            const tab = this.currentTab(c);
            const next = this.closeTabOf(c, tab);
            return Promise.resolve({
              content: next
                ? `Closed ${tab.info.handle}. The current tab is now ${next.info.handle}: "${next.info.title}" (${next.info.url}).`
                : `Closed ${tab.info.handle}. No tabs are open now.`,
            });
          },
          false,
        ),

      search: async (query, count) => {
        const c = chat();
        let found: { results: SearchResult[]; page: string | null } = { results: [], page: null };
        const step = await this.step(
          c,
          signal,
          async () => {
            let tab = c.tabs.find((t) => t.info.search);
            if (!tab) {
              if (c.tabs.length >= MAX_TABS) {
                throw new BrowserError(
                  `There are ${MAX_TABS} tabs open already. Close one with browser_close first.`,
                );
              }
              tab = this.newTab(c, true);
            }
            c.current = tab.info.id;
            this.changed(c);
            await tab.ready;
            await this.load(c, tab, searchUrl(query));
            const results = await tab.driver
              .evaluate<BrowserSearchResult[]>(SEARCH_RESULTS)
              .catch(() => []);
            if (results.length > 0) {
              found = { results: results.slice(0, count), page: null };
            } else {
              const snapshot = await tab.driver.snapshot();
              found = { results: [], page: snapshot.lines.join('\n') || '(The page is empty.)' };
            }
            return { content: '' };
          },
          false,
        );
        if (step.error) throw new ToolFailure(step.content);
        return found;
      },
    };
  }

  /** The user takes the wheel: the clank's browser tools wait until they hand back. */
  takeOver(conversationId: string): void {
    const chat = this.require(conversationId);
    if (chat.control === 'user') return;
    chat.control = 'user';
    for (const tab of chat.tabs)
      void tab.ready.then(() => tab.driver.setUploads(true)).catch(() => {});
    this.changed(chat);
  }

  handBack(conversationId: string): void {
    const chat = this.chats.get(conversationId);
    if (!chat || chat.control === 'clank') return;
    chat.control = 'clank';
    for (const tab of chat.tabs)
      void tab.ready.then(() => tab.driver.setUploads(false)).catch(() => {});
    for (const resume of [...chat.handBack]) resume();
    this.changed(chat);
  }

  /** Shows a tab in the pane at `bounds`, or hides the pane when either is null. */
  show(conversationId: string, tabId: string | null, bounds: Rect | null): void {
    const host = this.options.host;
    if (!host) return;
    const chat = this.chats.get(conversationId);
    const tab = chat && tabId ? this.tab(chat, tabId) : undefined;
    if (!tab || !bounds || bounds.width < 1 || bounds.height < 1) {
      // Only the chat that's showing can hide the pane.
      if (!this.displayed || this.displayed.conversationId === conversationId) {
        this.displayed = null;
        host.display(null, null);
      }
      return;
    }
    this.displayed = { conversationId, tabId: tab.info.id };
    host.display(tab.host.id, bounds);
  }

  /** The user picks a tab: the pane shows it, and the clank works in it from now on. */
  select(conversationId: string, tabId: string): void {
    const chat = this.require(conversationId);
    const tab = this.requireTab(chat, tabId);
    if (chat.current === tabId) return;
    chat.current = tabId;
    chat.notes.push(
      `${this.options.userName()} switched to ${tab.info.handle}, which is now the current tab.`,
    );
    this.changed(chat);
  }

  /** The user goes to an address, while they have control. */
  async navigate(conversationId: string, input: string): Promise<void> {
    const chat = this.require(conversationId);
    if (chat.control !== 'user')
      throw new BrowserError('Take over the browser to go somewhere else.');
    const url = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
    if (!/^https?:\/\//i.test(url)) throw new BrowserError('Only http and https pages open here.');
    let tab = chat.current ? this.tab(chat, chat.current) : undefined;
    if (!tab) {
      tab = this.newTab(chat, false);
      chat.current = tab.info.id;
      this.changed(chat);
    }
    await tab.ready;
    await tab.host.load(url).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!isAborted(message))
        throw new BrowserError(`Couldn't open ${url}: ${netErrorText(message)}.`);
    });
  }

  history(conversationId: string, tabId: string, action: 'back' | 'forward' | 'reload'): void {
    const tab = this.requireTab(this.require(conversationId), tabId);
    tab.host[action]();
  }

  /** The user closes a tab. */
  closeTab(conversationId: string, tabId: string): void {
    const chat = this.require(conversationId);
    const tab = this.requireTab(chat, tabId);
    this.closeTabOf(chat, tab);
    chat.notes.push(`${this.options.userName()} closed ${tab.info.handle}.`);
  }

  /** The user's answer to a download a page started. */
  async decideDownload(conversationId: string, downloadId: string, save: boolean): Promise<void> {
    const chat = this.require(conversationId);
    const download = chat.downloads.find((d) => d.id === downloadId);
    if (!download || download.status !== 'waiting') {
      throw new BrowserError("That download isn't waiting any more.");
    }
    const user = this.options.userName();
    if (!save) {
      download.status = 'blocked';
      chat.notes.push(`${user} didn't allow the download of ${download.filename}.`);
      this.changed(chat);
      return;
    }
    const tab = this.tab(chat, download.tabId);
    if (!tab) {
      download.status = 'failed';
      download.error = 'Its tab was closed.';
      this.changed(chat);
      return;
    }
    download.status = 'saving';
    this.changed(chat);
    try {
      download.path = await tab.host.download(download.url);
      download.status = 'saved';
      chat.notes.push(`${user} saved the download ${download.filename} to their computer.`);
    } catch (error) {
      download.status = 'failed';
      download.error = error instanceof Error ? error.message : String(error);
    }
    this.changed(chat);
  }

  dismissDownload(conversationId: string, downloadId: string): void {
    const chat = this.require(conversationId);
    chat.downloads = chat.downloads.filter(
      (d) => d.id !== downloadId || d.status === 'waiting' || d.status === 'saving',
    );
    this.changed(chat);
  }

  /** Closes a chat's tabs and forgets its in-memory session, for a deleted chat. */
  closeConversation(conversationId: string): void {
    const chat = this.chats.get(conversationId);
    if (!chat) return;
    for (const tab of [...chat.tabs]) this.closeTabOf(chat, tab);
    for (const resume of [...chat.handBack]) resume();
    this.chats.delete(conversationId);
    if (!chat.session.persistent)
      void this.options.host?.clearSession(chat.session).catch(() => {});
    this.emit('change', conversationId);
  }

  closeAll(): void {
    for (const id of [...this.chats.keys()]) this.closeConversation(id);
  }

  /** Forgets a clank's kept-signed-in browser: its cookies, storage and cache. */
  async clearClankSession(clankId: string): Promise<void> {
    await this.options.host?.clearSession({ key: clankId, persistent: true });
  }

  private chat(conversationId: string, clankId: string): ChatBrowser {
    let chat = this.chats.get(conversationId);
    if (!chat) {
      const persistent = this.options.settings(clankId).persistent;
      chat = {
        conversationId,
        clankId,
        session: persistent
          ? { key: clankId, persistent: true }
          : { key: conversationId, persistent: false },
        tabs: [],
        current: null,
        control: 'clank',
        busy: 0,
        waiting: 0,
        handBack: new Set(),
        downloads: [],
        notes: [],
        counter: 0,
      };
      this.chats.set(conversationId, chat);
    }
    return chat;
  }

  private require(conversationId: string): ChatBrowser {
    const chat = this.chats.get(conversationId);
    if (!chat) throw new BrowserError('This chat has no browser tabs.');
    return chat;
  }

  private tab(chat: ChatBrowser, tabId: string): Tab | undefined {
    return chat.tabs.find((t) => t.info.id === tabId);
  }

  private requireTab(chat: ChatBrowser, tabId: string): Tab {
    const tab = this.tab(chat, tabId);
    if (!tab) throw new BrowserError('That tab was closed.');
    return tab;
  }

  private currentTab(chat: ChatBrowser): Tab {
    const tab = chat.current ? this.tab(chat, chat.current) : undefined;
    if (!tab) throw new BrowserError('No tab is open. Open a page with browser_open first.');
    return tab;
  }

  /**
   * Runs one browser step: waits while the user has control, then reports what happened, with
   * anything else the clank should hear and a picture of the page for the user.
   */
  private async step(
    chat: ChatBrowser,
    signal: AbortSignal,
    run: (chat: ChatBrowser) => Promise<BrowserResult>,
    thumbnail = true,
  ): Promise<BrowserResult> {
    if (!this.options.host) return { content: "There's no browser here.", error: true };
    let waited: boolean;
    try {
      waited = await this.untilHandedBack(chat, signal);
    } catch (error) {
      if (error instanceof BrowserError) return { content: error.message, error: true };
      throw error;
    }
    chat.busy++;
    this.changed(chat);
    try {
      let result: BrowserResult;
      try {
        result = await run(chat);
      } catch (error) {
        if (!(error instanceof BrowserError)) throw error;
        result = { content: error.message, error: true };
      }
      const tab = chat.current ? this.tab(chat, chat.current) : undefined;
      const notes = [
        ...(waited
          ? [
              `${this.options.userName()} took over the browser and handed it back. The page may have changed: read it again before acting on it.`,
            ]
          : []),
        ...chat.notes.splice(0),
        ...(tab?.driver.takeNotes() ?? []),
      ];
      const content = [result.content, ...notes].filter(Boolean).join('\n\n');
      let image = result.image;
      if (!image && thumbnail && tab) image = await this.thumbnail(tab);
      return { ...result, content, ...(image ? { image } : {}) };
    } finally {
      chat.busy--;
      this.changed(chat);
    }
  }

  private async thumbnail(tab: Tab): Promise<ToolImage | undefined> {
    try {
      return { data: await tab.host.capture(THUMBNAIL), mediaType: 'image/jpeg' };
    } catch {
      // A hidden or crashed page can't be pictured. The step still counts.
      return undefined;
    }
  }

  /** Waits while the user has the browser. True if it had to wait. */
  private async untilHandedBack(chat: ChatBrowser, signal: AbortSignal): Promise<boolean> {
    if (chat.control === 'clank') return false;
    chat.waiting++;
    this.changed(chat);
    let outcome: 'back' | 'stopped' | 'timeout';
    try {
      outcome = await new Promise((resolve) => {
        const done = (how: 'back' | 'stopped' | 'timeout') => {
          clearTimeout(timer);
          chat.handBack.delete(resume);
          signal.removeEventListener('abort', stop);
          resolve(how);
        };
        const resume = () => done('back');
        const stop = () => done('stopped');
        const timer = setTimeout(() => done('timeout'), HAND_BACK_WAIT_MS);
        chat.handBack.add(resume);
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
    } finally {
      chat.waiting--;
      this.changed(chat);
    }
    if (outcome === 'stopped') throw new BrowserError('Stopped while waiting for the browser.');
    if (outcome === 'timeout' || !this.chats.has(chat.conversationId)) {
      const user = this.options.userName();
      throw new BrowserError(
        `${user} still has the browser. Carry on without it, or ask ${user} to hand it back.`,
      );
    }
    return true;
  }

  private checkSite(chat: ChatBrowser, url: string): void {
    const refusal = siteRefusal(this.options.settings(chat.clankId), url);
    if (refusal) throw new BrowserError(`${refusal} Don't try to reach it another way.`);
  }

  /** Whether a frame may load a page: the clank's site lists, unless the user is driving. */
  private guard(chat: ChatBrowser, tab: Tab | undefined, url: string, mainFrame: boolean): boolean {
    if (chat.control === 'user') return true;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!mainFrame && /^(about|data|blob):$/.test(parsed.protocol)) return true;
    // The search tab may always reach the search engine; where its results lead is checked.
    if (tab?.info.search && parsed.host === SEARCH_HOST) return true;
    if (siteRefusal(this.options.settings(chat.clankId), url) === null) return true;
    if (mainFrame && tab) tab.blocked.push(url);
    return false;
  }

  private newTab(chat: ChatBrowser, search: boolean): Tab {
    const host = this.options.host;
    if (!host) throw new BrowserError("There's no browser here.");
    // The view's events can arrive before the tab is put together.
    const self: { tab?: Tab } = {};
    const hostTab = host.open({
      session: chat.session,
      guard: (url, mainFrame) => this.guard(chat, self.tab, url, mainFrame),
      events: {
        state: (state) => {
          if (!self.tab) return;
          Object.assign(self.tab.info, state);
          this.changed(chat);
        },
        windowOpen: (url) => this.popup(chat, url),
        download: (request) => this.download(chat, self.tab, request),
      },
    });
    const driver = new PageDriver(hostTab.cdp, { loadTimeoutMs: LOAD_TIMEOUT_MS });
    const handle = `t${++chat.counter}`;
    const tab: Tab = {
      info: {
        id: hostTab.id,
        handle,
        url: 'about:blank',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        search,
      },
      host: hostTab,
      driver,
      ready: hostTab.ready
        .then(() => driver.attach())
        .then(() => (chat.control === 'user' ? driver.setUploads(true) : undefined)),
      blocked: [],
    };
    self.tab = tab;
    // A page that never answers CDP still gets used; its steps will say what failed.
    tab.ready.catch((error: unknown) => console.error('Attaching to a browser tab failed', error));
    chat.tabs.push(tab);
    return tab;
  }

  /** Loads a page and waits for it, within reason. Returns a note if it's still loading. */
  private async load(chat: ChatBrowser, tab: Tab, url: string): Promise<string> {
    tab.blocked = [];
    let slow = false;
    try {
      const timer = new Promise<'slow'>((resolve) =>
        setTimeout(() => resolve('slow'), LOAD_TIMEOUT_MS),
      );
      slow = (await Promise.race([tab.host.load(url), timer])) === 'slow';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocked = tab.blocked.at(-1);
      if (blocked) {
        throw new BrowserError(
          `${url} led to ${blocked}, which this clank may not open: ${siteRefusal(this.options.settings(chat.clankId), blocked) ?? 'it is not allowed'}`,
        );
      }
      // Cut short by a redirect or a download: what loaded instead is what counts.
      if (!isAborted(message))
        throw new BrowserError(`Couldn't open ${url}: ${netErrorText(message)}.`);
    }
    await tab.driver.waitForQuiet(3000);
    return slow || tab.driver.loading ? ' It is still loading.' : '';
  }

  /** A page asked for a new window: it opens as a tab, which becomes current. */
  private popup(chat: ChatBrowser, url: string): void {
    if (chat.control === 'clank' && siteRefusal(this.options.settings(chat.clankId), url)) {
      chat.notes.push(`The page tried to open ${url} in a new tab, which this clank may not open.`);
      return;
    }
    if (chat.tabs.length >= MAX_TABS) {
      chat.notes.push(
        `The page tried to open ${url} in a new tab, but ${MAX_TABS} tabs are open already.`,
      );
      return;
    }
    const tab = this.newTab(chat, false);
    chat.current = tab.info.id;
    chat.notes.push(
      `The page opened ${url} in a new tab, ${tab.info.handle}, which is now the current tab.`,
    );
    this.changed(chat);
    void tab.ready
      .then(() => tab.host.load(url))
      .catch(() => {
        // The tab shows what went wrong; the clank reads it there.
      });
  }

  private download(chat: ChatBrowser, tab: Tab | undefined, request: DownloadRequest): void {
    if (!tab) return;
    chat.downloads.push({
      id: randomUUID(),
      tabId: tab.info.id,
      url: request.url,
      filename: request.filename,
      size: request.size,
      status: 'waiting',
      path: null,
      error: null,
    });
    chat.notes.push(
      `The page started downloading ${request.filename}. Downloads wait for ${this.options.userName()} to approve them, and clanks can't open downloaded files.`,
    );
    this.changed(chat);
  }

  /** Closes a tab and returns the one that's current now. */
  private closeTabOf(chat: ChatBrowser, tab: Tab): Tab | undefined {
    tab.driver.dispose();
    tab.host.close();
    chat.tabs = chat.tabs.filter((t) => t !== tab);
    if (this.displayed?.tabId === tab.info.id) this.displayed = null;
    if (chat.current === tab.info.id) chat.current = chat.tabs.at(-1)?.info.id ?? null;
    this.changed(chat);
    return chat.current ? this.tab(chat, chat.current) : undefined;
  }

  private changed(chat: ChatBrowser): void {
    this.emit('change', chat.conversationId);
  }
}

/** A page as one line: its title and address. */
async function describe(tab: Tab): Promise<string> {
  try {
    const page = await tab.driver.evaluate<{ title: string; url: string }>(
      '({ title: document.title, url: location.href })',
    );
    return `"${page.title || '(no title)'}" (${page.url})`;
  } catch {
    return `"${tab.info.title || '(no title)'}" (${tab.info.url})`;
  }
}

/**
 * A page's lines from `fromLine`, as many as fit in `maxChars`, with a note saying where to go
 * on from.
 */
export function pageText(
  header: string,
  lines: string[],
  fromLine: number,
  maxChars: number,
): string {
  if (lines.length === 0) {
    return `${header}\n\n(The page has no text yet. It may still be loading, or be all pictures.)`;
  }
  const start = Math.min(Math.max(1, fromLine), lines.length);
  const budget = Math.max(1000, maxChars - header.length - 200);
  const taken: string[] = [];
  let used = 0;
  for (let i = start - 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (taken.length > 0 && used + line.length + 1 > budget) break;
    taken.push(line.length > budget ? `${line.slice(0, budget)}…` : line);
    used += line.length + 1;
  }
  const end = start + taken.length - 1;
  const notes: string[] = [];
  if (start > 1 || end < lines.length) {
    notes.push(
      end < lines.length
        ? `[Lines ${start}–${end} of ${lines.length}. Call browser_read with from_line ${end + 1} to read on.]`
        : `[Lines ${start}–${end} of ${lines.length}: the end of the page.]`,
    );
  }
  return [header, taken.join('\n'), ...notes].join('\n\n');
}
