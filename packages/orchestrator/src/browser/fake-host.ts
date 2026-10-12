import type {
  AXNode,
  BrowserHost,
  CdpSession,
  DownloadRequest,
  HostTab,
  PageLook,
  Rect,
  SessionKey,
  TabEvents,
  TabState,
} from '@clanks/browser';
import { BROKEN_IMAGES, PAGE_LOOK } from '@clanks/browser';
import { randomUUID } from 'node:crypto';

/** A page the fake browser can show. */
export interface FakePage {
  title: string;
  text?: string[];
  /** Its links, buttons and fields, in order. Clicking a link with an `href` follows it. */
  elements?: { role: 'link' | 'button' | 'textbox'; name: string; href?: string; type?: string }[];
  /** What the search results script finds on it. */
  results?: { title: string; url: string; snippet: string }[];
  /** What the script that reads a page's look finds on it. */
  look?: PageLook;
  /** The pictures on it that don't load. */
  broken?: { alt: string; src: string }[];
}

export interface FakeTab extends HostTab {
  session: SessionKey;
  url: string;
  closed: boolean;
  events: TabEvents;
  guard: (url: string, mainFrame: boolean) => boolean;
  /** What's been typed into each field, by backend node id. */
  values: Map<number, string>;
}

const elementId = (index: number) => 100 + index;
/** Each element's box: a row of its own, so a click's position says which it hit. */
const rowOf = (backend: number) => (backend - 99) * 30;

function tree(page: FakePage): AXNode[] {
  const nodes: AXNode[] = [
    { nodeId: 'root', ignored: false, role: { type: 'role', value: 'RootWebArea' }, childIds: [] },
  ];
  const root = nodes[0]!;
  (page.text ?? []).forEach((line, i) => {
    const id = `p${i}`;
    root.childIds!.push(id);
    nodes.push({
      nodeId: id,
      parentId: 'root',
      ignored: false,
      role: { type: 'role', value: 'paragraph' },
      childIds: [`${id}t`],
    });
    nodes.push({
      nodeId: `${id}t`,
      parentId: id,
      ignored: false,
      role: { type: 'role', value: 'StaticText' },
      name: { type: 'computedString', value: line },
    });
  });
  (page.elements ?? []).forEach((element, i) => {
    const id = `e${i}`;
    root.childIds!.push(id);
    nodes.push({
      nodeId: id,
      parentId: 'root',
      ignored: false,
      role: { type: 'role', value: element.role },
      name: { type: 'computedString', value: element.name },
      backendDOMNodeId: elementId(i),
      ...(element.href
        ? { properties: [{ name: 'url', value: { type: 'string', value: element.href } }] }
        : {}),
    });
  });
  return nodes;
}

/**
 * A browser made of canned pages, speaking just enough CDP for the page driver: reading, clicking
 * links, typing, scrolling and screenshots. Tests drive pop-ups and downloads by hand.
 */
export function fakeBrowserHost(pages: Record<string, FakePage>) {
  const tabs: FakeTab[] = [];
  const cleared: SessionKey[] = [];
  let displayed: { tabId: string | null; bounds: Rect | null } = { tabId: null, bounds: null };

  const open: BrowserHost['open'] = ({ session, guard, events }) => {
    let listener: ((method: string, params: Record<string, unknown>) => void) | undefined;
    const emit = (method: string, params: Record<string, unknown>) => listener?.(method, params);
    const history: string[] = [];
    const page = () => pages[tab.url] ?? { title: '' };

    const state = (): TabState => ({
      url: tab.url,
      title: page().title,
      loading: false,
      canGoBack: history.length > 1,
      canGoForward: false,
      crashed: false,
    });
    const go = (url: string, record = true) => {
      emit('Page.frameStartedLoading', { frameId: 'main' });
      tab.url = url;
      if (record) history.push(url);
      tab.values.clear();
      emit('Page.frameNavigated', { frame: { id: 'main', url } });
      emit('Page.frameStoppedLoading', { frameId: 'main' });
      events.state(state());
    };

    const cdp: CdpSession = {
      send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const reply = (value: unknown) => Promise.resolve(value as T);
        const value = (v: unknown) => reply({ result: { type: typeof v, value: v } });
        switch (method) {
          case 'Page.getFrameTree':
            return reply({ frameTree: { frame: { id: 'main', url: tab.url } } });
          case 'Accessibility.getFullAXTree':
            return reply({ nodes: tree(page()) });
          case 'Runtime.evaluate': {
            const expression = params.expression as string;
            if (expression === PAGE_LOOK) return value(page().look ?? null);
            if (expression === BROKEN_IMAGES) return value(page().broken ?? []);
            if (expression.includes("querySelectorAll('.result')"))
              return value(page().results ?? []);
            const position = { top: 0, viewport: 600, height: 600 };
            if (expression.includes('document.title')) {
              return value({ title: page().title, url: tab.url, ...position });
            }
            if (expression.includes('activeElement')) return value(false);
            return value(position);
          }
          case 'DOM.resolveNode': {
            const backend = params.backendNodeId as number;
            const exists = (page().elements ?? []).some((_e, i) => elementId(i) === backend);
            if (!exists) return Promise.reject(new Error('No node with given id found'));
            return reply({ object: { type: 'object', objectId: `node-${backend}` } });
          }
          case 'DOM.getContentQuads': {
            const y = rowOf(params.backendNodeId as number);
            return reply({ quads: [[0, y - 10, 100, y - 10, 100, y + 10, 0, y + 10]] });
          }
          case 'Page.getLayoutMetrics':
            return reply({ cssLayoutViewport: { clientWidth: 800, clientHeight: 2000 } });
          case 'DOM.getNodeForLocation':
            return reply({ backendNodeId: Math.round((params.y as number) / 30) + 99 });
          case 'Runtime.callFunctionOn': {
            const fn = params.functionDeclaration as string;
            const backend = Number(String(params.objectId).slice(5));
            const element = page().elements?.[backend - 100];
            if (fn.includes('HTMLLabelElement')) return value('');
            if (fn.includes('getAttribute(name)')) {
              return value({
                tag: element?.role === 'textbox' ? 'input' : 'button',
                type: element?.type ?? (element?.role === 'textbox' ? 'text' : ''),
                autocomplete: '',
                editable: false,
                disabled: false,
                readOnly: false,
              });
            }
            if (fn.includes('innerText : String(this.value'))
              return value(tab.values.get(backend) ?? '');
            return value(undefined);
          }
          case 'DOM.focus':
            tab.focused = params.backendNodeId as number;
            return reply({});
          case 'Input.insertText':
            if (tab.focused !== null) tab.values.set(tab.focused, params.text as string);
            return reply({});
          case 'Input.dispatchMouseEvent': {
            if (params.type === 'mouseReleased') {
              const index = Math.round((params.y as number) / 30) - 1;
              const href = page().elements?.[index]?.href;
              if (href) {
                const target = new URL(href, tab.url).href;
                if (guard(target, true)) go(target);
              }
            }
            return reply({});
          }
          case 'Page.getNavigationHistory':
            return reply({
              currentIndex: history.length - 1,
              entries: history.map((url, id) => ({ id, url })),
            });
          case 'Page.navigateToHistoryEntry': {
            const id = params.entryId as number;
            history.length = id + 1;
            go(history[id]!, false);
            return reply({});
          }
          case 'Page.captureScreenshot':
            return reply({ data: Buffer.from('shot').toString('base64') });
          default:
            return reply({});
        }
      },
      on(next) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };

    const tab: FakeTab & { focused: number | null } = {
      id: randomUUID(),
      cdp,
      ready: Promise.resolve(),
      session,
      url: 'about:blank',
      closed: false,
      events,
      guard,
      values: new Map(),
      focused: null,
      load(url) {
        if (!guard(url, true))
          return Promise.reject(new Error(`ERR_BLOCKED_BY_CLIENT (-20) loading '${url}'`));
        if (!pages[url])
          return Promise.reject(new Error(`ERR_NAME_NOT_RESOLVED (-105) loading '${url}'`));
        go(url);
        return Promise.resolve();
      },
      back() {
        void cdp.send('Page.navigateToHistoryEntry', { entryId: history.length - 2 });
      },
      forward() {},
      reload() {
        go(tab.url, false);
      },
      capture: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff])),
      download: (url) => Promise.resolve(`/downloads/${url.split('/').pop()}`),
      close() {
        tab.closed = true;
      },
    };
    tabs.push(tab);
    return tab;
  };

  const host: BrowserHost = {
    open,
    display(tabId, bounds) {
      displayed = { tabId, bounds };
    },
    clearSession(session) {
      cleared.push(session);
      return Promise.resolve();
    },
  };

  return {
    host,
    tabs,
    cleared,
    displayed: () => displayed,
    /** A page in a tab asks for a new window. */
    popup: (tab: FakeTab, url: string) => tab.events.windowOpen(url),
    /** A page in a tab starts a download. */
    download: (tab: FakeTab, request: DownloadRequest) => tab.events.download(request),
    /** A redirect the page makes on its own, which the guard checks. */
    redirect: (tab: FakeTab, url: string) => tab.guard(url, true),
  };
}
