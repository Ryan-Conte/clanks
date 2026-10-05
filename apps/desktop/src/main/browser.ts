import type {
  BrowserHost,
  CdpSession,
  HostTab,
  Rect,
  SessionKey,
  TabEvents,
  TabState,
} from '@clanks/browser';
import { type BrowserWindow, type Session, WebContentsView, app, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, parse } from 'node:path';

/** How long an approved download has to start. */
const DOWNLOAD_START_MS = 30_000;
/** How long a hidden tab gets to draw a frame for a picture. */
const CAPTURE_TRIES = 10;

interface Tab {
  id: string;
  view: WebContentsView;
  events: TabEvents;
  guard: (url: string, mainFrame: boolean) => boolean;
  /** The window its view is on, if any. */
  window: BrowserWindow | null;
  /** Downloads the user approved, by address, waiting for the page to start them again. */
  approved: Map<string, { resolve: (path: string) => void; reject: (error: Error) => void }>;
  /** It's being closed on purpose, so losing its connection is expected. */
  closing: boolean;
}

/** The app's Chromium without its Electron and clanks tokens, so sites see a normal browser. */
function chromeUserAgent(): string {
  return app.userAgentFallback
    .replace(/\s*clanks\/\S+/i, '')
    .replace(/\s*Electron\/\S+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A file name in the Downloads folder that doesn't overwrite anything. */
function freePath(dir: string, filename: string): string {
  const { name, ext } = parse(filename.replace(/[\\/:*?"<>|]/g, '_') || 'download');
  let path = join(dir, `${name}${ext}`);
  for (let i = 1; existsSync(path); i++) path = join(dir, `${name} (${i})${ext}`);
  return path;
}

/**
 * The browser pane's views: one `WebContentsView` per tab, sandboxed, with no preload and no Node,
 * in a session of its own. Every frame navigation passes the tab's guard; permissions, file
 * pickers and downloads are refused unless the user says otherwise.
 */
export function createBrowserHost(options: {
  window: () => BrowserWindow | undefined;
  /** The app data folder, whose `browser/` holds kept sessions. */
  dataDir: string;
}): BrowserHost & { closeAll(): void } {
  const tabs = new Map<string, Tab>();
  const byContents = new Map<number, Tab>();
  const sessions = new Map<string, Session>();
  let shown: { tabId: string; bounds: Rect } | null = null;
  /** The pane's last size, which tabs keep while out of sight so their pages don't reflow. */
  let size = { width: 1024, height: 768 };

  const sessionFor = (key: SessionKey): Session => {
    const id = `${key.persistent ? 'kept' : 'memory'}:${key.key}`;
    const existing = sessions.get(id);
    if (existing) return existing;
    const created = key.persistent
      ? session.fromPath(join(options.dataDir, 'browser', key.key.replace(/[^\w-]/g, '_')))
      : // No `persist:` prefix: it lives in memory and is gone when the app quits.
        session.fromPartition(`clanks-chat-${key.key}`);
    configure(created);
    sessions.set(id, created);
    return created;
  };

  const configure = (ses: Session) => {
    ses.setUserAgent(chromeUserAgent());
    // Camera, microphone, location, notifications, other apps: pages get none of it.
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') {
        callback({});
        return;
      }
      const tab =
        details.webContentsId !== undefined ? byContents.get(details.webContentsId) : undefined;
      const allowed = tab ? tab.guard(details.url, details.resourceType === 'mainFrame') : true;
      callback({ cancel: !allowed });
    });
    ses.on('will-download', (event, item, contents) => {
      const tab = byContents.get(contents.id);
      const url = item.getURL();
      const approved = tab?.approved.get(url);
      if (tab && approved) {
        tab.approved.delete(url);
        const path = freePath(app.getPath('downloads'), item.getFilename());
        item.setSavePath(path);
        item.once('done', (_event, state) => {
          if (state === 'completed') approved.resolve(path);
          else approved.reject(new Error(`The download was ${state}.`));
        });
        return;
      }
      // Nothing is saved without the user's say-so. The page asks again if they approve.
      event.preventDefault();
      tab?.events.download({
        url,
        filename: item.getFilename(),
        size: item.getTotalBytes() || null,
        mimeType: item.getMimeType(),
      });
    });
  };

  const scaled = (window: BrowserWindow, rect: Rect) => {
    const zoom = window.webContents.getZoomFactor();
    return {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    };
  };

  /**
   * Puts a tab's view on the window: in the pane if it's the shown tab, hidden at the pane's size
   * if not. A hidden view still lays out its page and takes input, so clanks can work in it; a
   * view off the window altogether gets no size at all.
   */
  const place = (tab: Tab) => {
    const window = options.window();
    if (!window || window.isDestroyed()) return;
    if (tab.window !== window) {
      window.contentView.addChildView(tab.view);
      tab.window = window;
    }
    if (shown?.tabId === tab.id) {
      tab.view.setBounds(scaled(window, shown.bounds));
      tab.view.setVisible(true);
    } else {
      tab.view.setBounds(
        scaled(window, { x: shown?.bounds.x ?? 0, y: shown?.bounds.y ?? 0, ...size }),
      );
      tab.view.setVisible(false);
    }
  };

  /**
   * A hidden view draws nothing, so it can't be pictured. For a moment it's shown with just its
   * top-left pixel in the window's corner, which is enough to draw the whole page.
   */
  const capture = async (tab: Tab): Promise<Electron.NativeImage> => {
    const window = tab.window;
    const contents = tab.view.webContents;
    const hidden = shown?.tabId !== tab.id && window && !window.isDestroyed();
    if (hidden) {
      const [width, height] = window.getContentSize() as [number, number];
      const zoom = window.webContents.getZoomFactor();
      tab.view.setBounds({
        x: width - 1,
        y: height - 1,
        width: Math.round(size.width * zoom),
        height: Math.round(size.height * zoom),
      });
      tab.view.setVisible(true);
    }
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const image = await contents.capturePage();
          if (!image.isEmpty()) return image;
        } catch (error) {
          if (attempt >= CAPTURE_TRIES) throw error;
        }
        if (attempt >= CAPTURE_TRIES) throw new Error('The page has nothing to show yet');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      if (hidden) place(tab);
    }
  };

  const open: BrowserHost['open'] = ({ session: key, guard, events }) => {
    const view = new WebContentsView({
      webPreferences: {
        session: sessionFor(key),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        autoplayPolicy: 'user-gesture-required',
      },
    });
    view.setBackgroundColor('#ffffff');
    const contents = view.webContents;
    contents.setAudioMuted(true);
    const tab: Tab = {
      id: randomUUID(),
      view,
      events,
      guard,
      window: null,
      approved: new Map(),
      closing: false,
    };
    tabs.set(tab.id, tab);
    byContents.set(contents.id, tab);

    const state = (): TabState => ({
      url: contents.getURL() || 'about:blank',
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      crashed: contents.isCrashed(),
    });
    const report = () => {
      if (!contents.isDestroyed()) events.state(state());
    };
    for (const name of [
      'did-start-loading',
      'did-stop-loading',
      'did-navigate',
      'did-navigate-in-page',
      'page-title-updated',
      'render-process-gone',
    ] as const) {
      contents.on(name as 'did-start-loading', report);
    }
    // New windows open as tabs, through the service, which checks the site lists.
    contents.setWindowOpenHandler(({ url }) => {
      events.windowOpen(url);
      return { action: 'deny' };
    });
    // Only web pages: no file://, no app protocols, no handing links to other apps.
    contents.on('will-navigate', (details) => {
      if (!/^(https?:|about:blank)/i.test(details.url)) details.preventDefault();
    });

    contents.debugger.attach('1.3');
    const cdp: CdpSession = {
      send: <T>(method: string, params?: Record<string, unknown>) =>
        contents.debugger.sendCommand(method, params) as Promise<T>,
      on(listener) {
        const handler = (_event: Electron.Event, method: string, params: unknown) =>
          listener(method, (params ?? {}) as Record<string, unknown>);
        contents.debugger.on('message', handler);
        return () => {
          if (!contents.isDestroyed()) contents.debugger.off('message', handler);
        };
      },
    };
    contents.debugger.on('detach', (_event, reason) => {
      if (!tab.closing && !contents.isDestroyed()) {
        console.warn(`The browser lost a tab's DevTools connection: ${reason}`);
      }
    });

    place(tab);
    // Until it has a page there's no renderer, and CDP commands wait for one.
    const ready = contents.loadURL('about:blank').catch(() => {});

    const hostTab: HostTab = {
      id: tab.id,
      cdp,
      ready,
      load: (url) => contents.loadURL(url),
      back: () => contents.navigationHistory.goBack(),
      forward: () => contents.navigationHistory.goForward(),
      reload: () => contents.reload(),
      async capture({ maxWidth, quality }) {
        let image = await capture(tab);
        if (image.getSize().width > maxWidth)
          image = image.resize({ width: maxWidth, quality: 'good' });
        return image.toJPEG(quality);
      },
      download: (url) =>
        new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            tab.approved.delete(url);
            reject(new Error("The download didn't start."));
          }, DOWNLOAD_START_MS);
          tab.approved.set(url, {
            resolve: (path) => {
              clearTimeout(timer);
              resolve(path);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          contents.downloadURL(url);
        }),
      close() {
        tab.closing = true;
        tabs.delete(tab.id);
        byContents.delete(contents.id);
        if (shown?.tabId === tab.id) shown = null;
        if (tab.window && !tab.window.isDestroyed()) tab.window.contentView.removeChildView(view);
        if (!contents.isDestroyed()) contents.close();
      },
    };
    return hostTab;
  };

  return {
    open,

    display(tabId, bounds) {
      const previous = shown?.tabId;
      if (tabId && bounds && tabs.has(tabId)) {
        shown = { tabId, bounds };
        size = { width: bounds.width, height: bounds.height };
      } else {
        shown = null;
      }
      for (const tab of tabs.values()) place(tab);
      // The shown tab goes on top of any others.
      const tab = shown ? tabs.get(shown.tabId) : undefined;
      if (tab && tab.window && previous !== tab.id) tab.window.contentView.addChildView(tab.view);
    },

    async clearSession(key) {
      const ses =
        sessions.get(`${key.persistent ? 'kept' : 'memory'}:${key.key}`) ??
        (key.persistent ? sessionFor(key) : undefined);
      if (!ses) return;
      await ses.clearStorageData();
      await ses.clearCache();
    },

    closeAll() {
      for (const tab of [...tabs.values()]) {
        tab.closing = true;
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
      }
      tabs.clear();
      byContents.clear();
    },
  };
}
