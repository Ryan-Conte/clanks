import { type AXNode, BrowserError, type CdpSession, type EvaluateResult } from './cdp';
import { type KeyDefinition, type KeyPress, parseKeys } from './keys';
import { RefTable, formatSnapshot } from './snapshot';

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug' | 'navigation';
  text: string;
  /** Where it came from, such as `app.js:12`. */
  source: string | null;
  at: Date;
}

/** Where the page is scrolled to, in CSS pixels. */
export interface ScrollPosition {
  top: number;
  viewport: number;
  height: number;
}

export interface PageSnapshot {
  title: string;
  url: string;
  lines: string[];
  scroll: ScrollPosition;
}

export interface DriverOptions {
  /** How long a step waits for a page to load before it goes on anyway. */
  loadTimeoutMs?: number;
  /** Tests make waits instant. */
  sleep?: (ms: number) => Promise<void>;
}

/** Input types that take typed text. */
const TEXT_INPUTS = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/** Autocomplete values for secrets clanks never type, whatever the field looks like. */
const SECRET_FIELDS = /(?:current|new)-password|one-time-code|cc-number|cc-csc|cc-exp/;

const OBJECT_GROUP = 'clanks';
const MAX_CONSOLE = 300;

interface ElementInfo {
  tag: string;
  type: string;
  autocomplete: string;
  editable: boolean;
  disabled: boolean;
  readOnly: boolean;
}

const ELEMENT_INFO = `function () {
  const tag = this.tagName ? this.tagName.toLowerCase() : '';
  const attr = (name) => ((this.getAttribute && this.getAttribute(name)) || '').toLowerCase();
  return {
    tag,
    type: tag === 'input' ? attr('type') : '',
    autocomplete: attr('autocomplete'),
    editable: !!this.isContentEditable,
    disabled: !!this.disabled,
    readOnly: !!this.readOnly,
  };
}`;

/** Empty when the element at the click point is this one or part of it; else what's there. */
const COVERED_BY = `function (other) {
  for (let node = other; node; node = node.parentNode || (node instanceof ShadowRoot ? node.host : null)) {
    if (node === this) return '';
    if (node instanceof HTMLLabelElement && node.control === this) return '';
  }
  if (other.contains && other.contains(this) && other !== document.body && other !== document.documentElement) return '';
  const el = other.nodeType === 1 ? other : other.parentElement;
  if (!el) return 'something';
  const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  return text ? el.tagName.toLowerCase() + ' "' + text + '"' : el.tagName.toLowerCase();
}`;

const SELECT_ALL = `function () {
  if (typeof this.select === 'function') { this.select(); return; }
  const range = document.createRange();
  range.selectNodeContents(this);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;

const VALUE = `function () {
  return this.isContentEditable ? this.innerText : String(this.value ?? '');
}`;

const PICK_OPTION = `function (wanted) {
  const want = wanted.trim().toLowerCase();
  const options = [...this.options];
  const label = (o) => (o.label || o.text || '').trim();
  const match =
    options.find((o) => label(o).toLowerCase() === want || o.value.toLowerCase() === want) ||
    options.find((o) => label(o).toLowerCase().includes(want));
  if (!match) return { picked: null, options: options.map(label) };
  this.value = match.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { picked: label(match), options: [] };
}`;

const SCROLL_POSITION = `({
  top: Math.round(scrollY),
  viewport: innerHeight,
  height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
})`;

const FOCUSED_SECRET = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || '').toLowerCase() : '';
  const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
  return type === 'password' || ${SECRET_FIELDS.toString()}.test(auto);
})()`;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drives one page over CDP the way a person would: it reads the page as text with numbered refs,
 * clicks and types where a person would, and keeps the page's console. Errors it throws are
 * `BrowserError`s worded for the clank.
 */
export class PageDriver {
  readonly refs = new RefTable();
  private mainFrame: string | null = null;
  private url = '';
  private loadingNow = false;
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly pendingNotes: string[] = [];
  private readonly unsubscribe: () => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly loadTimeoutMs: number;

  constructor(
    private readonly cdp: CdpSession,
    options: DriverOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.loadTimeoutMs = options.loadTimeoutMs ?? 15_000;
    this.unsubscribe = cdp.on((method, params) => this.onEvent(method, params));
  }

  /** Starts listening to the page. File pickers are blocked until `setUploads(true)`. */
  async attach(): Promise<void> {
    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('Runtime.enable'),
      this.cdp.send('Log.enable'),
      this.cdp.send('DOM.enable'),
      this.cdp.send('Accessibility.enable'),
    ]);
    await this.setUploads(false);
    const { frameTree } = await this.cdp.send<{
      frameTree: { frame: { id: string; url: string } };
    }>('Page.getFrameTree');
    this.mainFrame = frameTree.frame.id;
    this.url = frameTree.frame.url;
  }

  dispose(): void {
    this.unsubscribe();
    for (const wake of this.waiters) wake();
  }

  get loading(): boolean {
    return this.loadingNow;
  }

  /** The page's address as of its last navigation. */
  get currentUrl(): string {
    return this.url;
  }

  /** Things the page did that the clank should hear about, such as a dialog it answered. */
  takeNotes(): string[] {
    return this.pendingNotes.splice(0);
  }

  /**
   * With uploads off, the page's file pickers never open: clanks can't upload files. The user can
   * while they have control.
   */
  async setUploads(allowed: boolean): Promise<void> {
    await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: !allowed });
  }

  /** Waits for the page to finish loading, up to `timeoutMs`. False if it didn't. */
  waitForLoad(timeoutMs = this.loadTimeoutMs): Promise<boolean> {
    return this.waitFor(() => !this.loadingNow, timeoutMs);
  }

  /**
   * Waits for a page that just loaded to stay loaded for a moment: pages often navigate again, or
   * start loading more, straight after their load event.
   */
  async waitForQuiet(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.waitForLoad(Math.max(0, deadline - Date.now()));
      await this.sleep(250);
      if (!this.loadingNow) return;
    }
  }

  async snapshot(): Promise<PageSnapshot> {
    await this.waitForLoad(Math.min(this.loadTimeoutMs, 8000));
    let lines: string[] = [];
    let info: ScrollPosition & { title: string; url: string } = {
      title: '',
      url: this.url,
      top: 0,
      viewport: 0,
      height: 0,
    };
    // Right after a page loads, its accessibility tree can still be empty for a moment.
    for (let attempt = 1; attempt <= 6; attempt++) {
      const { nodes } = await this.cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
      info = await this.evaluate<ScrollPosition & { title: string; url: string }>(
        `({ title: document.title, url: location.href, ...${SCROLL_POSITION} })`,
      );
      lines = formatSnapshot(nodes, this.refs, { url: info.url });
      if (lines.length > 0) break;
      await this.sleep(400);
    }
    return {
      title: info.title,
      url: info.url,
      lines,
      scroll: { top: info.top, viewport: info.viewport, height: info.height },
    };
  }

  async click(ref: number): Promise<void> {
    const backendNodeId = this.nodeFor(ref);
    try {
      const objectId = await this.resolve(backendNodeId, ref);
      await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
      const point = await this.pointFor(backendNodeId, ref);
      const cover = await this.coveredBy(objectId, point);
      if (cover) {
        throw new BrowserError(
          `Something else is on top of [${ref}] where it would be clicked: ${cover}. Close it or scroll past it first; pop-ups such as cookie banners often do this.`,
        );
      }
      await this.mouseClick(point);
    } finally {
      await this.release();
    }
    await this.settle();
  }

  /**
   * Types into a text field, replacing what's there, or picks an option of a drop-down by its
   * label. Refuses password and card fields. Returns what the field holds afterwards.
   */
  async type(ref: number, text: string, submit: boolean): Promise<string> {
    const backendNodeId = this.nodeFor(ref);
    let value: string;
    try {
      const objectId = await this.resolve(backendNodeId, ref);
      const info = await this.call<ElementInfo>(objectId, ELEMENT_INFO);
      if (info.type === 'password' || SECRET_FIELDS.test(info.autocomplete)) {
        throw new BrowserError(
          `[${ref}] is a password or payment field. Clanks never type into those: ask for the user to take over the browser and fill it in themselves.`,
        );
      }
      if (info.disabled) throw new BrowserError(`[${ref}] is disabled, so it can't be typed into.`);
      if (info.tag === 'select') {
        const { picked, options } = await this.call<{ picked: string | null; options: string[] }>(
          objectId,
          PICK_OPTION,
          [text],
        );
        if (picked === null) {
          throw new BrowserError(
            `[${ref}] has no option "${text}". Its options: ${options.slice(0, 30).join(' | ') || 'none'}.`,
          );
        }
        value = picked;
      } else {
        const typable =
          info.editable ||
          info.tag === 'textarea' ||
          (info.tag === 'input' && TEXT_INPUTS.has(info.type));
        if (!typable) {
          throw new BrowserError(
            `[${ref}] isn't a text field${info.tag ? ` (it's ${info.tag === 'input' ? `an input of type ${info.type}` : `a ${info.tag}`})` : ''}. Use browser_click on it instead.`,
          );
        }
        if (info.readOnly) throw new BrowserError(`[${ref}] is read-only.`);
        await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
        await this.cdp.send('DOM.focus', { backendNodeId });
        await this.call(objectId, SELECT_ALL);
        if (text) await this.cdp.send('Input.insertText', { text });
        else await this.pressKey(parseKeys('Backspace')[0]!);
        value = await this.call<string>(objectId, VALUE);
      }
    } finally {
      await this.release();
    }
    if (submit) await this.pressKey(parseKeys('Enter')[0]!);
    await this.settle();
    return value;
  }

  async press(keys: string): Promise<void> {
    const presses = parseKeys(keys);
    if (presses.some((p) => p.printable) && (await this.evaluate<boolean>(FOCUSED_SECRET))) {
      throw new BrowserError(
        'The focused field is a password or payment field. Clanks never type into those: ask for the user to take over the browser.',
      );
    }
    for (const press of presses) {
      // Reloading is the browser's, not the page's, so it's done directly.
      if (press.reload) await this.cdp.send('Page.reload', {});
      else await this.pressKey(press);
    }
    await this.settle();
  }

  /**
   * Scrolls the page by most of a screen, or brings an element into view. Returns where the page
   * was and where it is now.
   */
  async scroll(
    direction: 'up' | 'down',
    ref: number | null,
  ): Promise<{ before: ScrollPosition; after: ScrollPosition }> {
    const before = await this.evaluate<ScrollPosition>(SCROLL_POSITION);
    if (ref !== null) {
      const backendNodeId = this.nodeFor(ref);
      try {
        await this.resolve(backendNodeId, ref);
        await this.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
      } finally {
        await this.release();
      }
    } else {
      const delta = Math.round(before.viewport * 0.8) * (direction === 'down' ? 1 : -1);
      const { cssLayoutViewport } = await this.cdp.send<{
        cssLayoutViewport: { clientWidth: number; clientHeight: number };
      }>('Page.getLayoutMetrics');
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(cssLayoutViewport.clientWidth / 2),
        y: Math.round(cssLayoutViewport.clientHeight / 2),
        deltaX: 0,
        deltaY: delta,
      });
      await this.sleep(350);
      const moved = await this.evaluate<ScrollPosition>(SCROLL_POSITION);
      // The wheel can land on something that doesn't scroll, such as an ad's frame.
      if (moved.top === before.top) await this.evaluate(`window.scrollBy(0, ${delta})`);
    }
    await this.sleep(150);
    const after = await this.evaluate<ScrollPosition>(SCROLL_POSITION);
    return { before, after };
  }

  /** What the page logged since it loaded, oldest first. */
  console(): ConsoleEntry[] {
    const start = this.consoleEntries.findLastIndex((e) => e.level === 'navigation');
    return this.consoleEntries.slice(start + 1);
  }

  async back(): Promise<boolean> {
    const history = await this.cdp.send<{
      currentIndex: number;
      entries: { id: number; url: string }[];
    }>('Page.getNavigationHistory');
    const previous = history.entries[history.currentIndex - 1];
    if (!previous) return false;
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: previous.id });
    await this.settle();
    return true;
  }

  /** The visible part of the page, straight from the renderer. */
  async screenshot(quality = 70): Promise<Uint8Array> {
    const { data } = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality,
    });
    return Buffer.from(data, 'base64');
  }

  /** Runs an expression in the page and returns its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.cdp.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new BrowserError(
        `The page's script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value as T;
  }

  /** Waits a moment for what an action started, such as a navigation, to finish. */
  async settle(): Promise<void> {
    await this.sleep(200);
    if (this.loadingNow) await this.waitForLoad();
    await this.sleep(150);
  }

  private nodeFor(ref: number): number {
    const node = this.refs.node(ref);
    if (node === undefined) {
      throw new BrowserError(
        `There's no [${ref}] on this page. Call browser_read to see the page and its refs.`,
      );
    }
    return node;
  }

  private async resolve(backendNodeId: number, ref: number): Promise<string> {
    try {
      const { object } = await this.cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId,
        objectGroup: OBJECT_GROUP,
      });
      if (object.objectId) return object.objectId;
    } catch {
      // Gone: said below.
    }
    throw new BrowserError(
      `[${ref}] is gone: the page changed since you read it. Call browser_read again.`,
    );
  }

  private async call<T>(objectId: string, fn: string, args: unknown[] = []): Promise<T> {
    const result = await this.cdp.send<EvaluateResult>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) =>
        typeof value === 'object' && value !== null && 'objectId' in value ? value : { value },
      ),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new BrowserError(
        `The page's script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value as T;
  }

  private async release(): Promise<void> {
    await this.cdp
      .send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP })
      .catch(() => {});
  }

  /** The middle of the element's visible box, in the viewport. */
  private async pointFor(backendNodeId: number, ref: number): Promise<{ x: number; y: number }> {
    let quads: number[][] = [];
    try {
      ({ quads } = await this.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', {
        backendNodeId,
      }));
    } catch {
      // No box: said below.
    }
    const { cssLayoutViewport } = await this.cdp.send<{
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    }>('Page.getLayoutMetrics');
    const width = cssLayoutViewport.clientWidth;
    const height = cssLayoutViewport.clientHeight;
    for (const quad of quads) {
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
      // Only the part that's on screen can be clicked.
      const left = Math.max(0, Math.min(...xs));
      const right = Math.min(width, Math.max(...xs));
      const top = Math.max(0, Math.min(...ys));
      const bottom = Math.min(height, Math.max(...ys));
      if (right - left >= 1 && bottom - top >= 1) {
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      }
    }
    throw new BrowserError(
      quads.length === 0
        ? `[${ref}] isn't shown on the page right now; it may be inside a closed menu.`
        : `[${ref}] is off screen and couldn't be scrolled into view.`,
    );
  }

  private async coveredBy(objectId: string, point: { x: number; y: number }): Promise<string> {
    try {
      const hit = await this.cdp.send<{ backendNodeId: number }>('DOM.getNodeForLocation', {
        x: Math.round(point.x),
        y: Math.round(point.y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      });
      const { object } = await this.cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: hit.backendNodeId,
        objectGroup: OBJECT_GROUP,
      });
      if (!object.objectId) return '';
      return await this.call<string>(objectId, COVERED_BY, [{ objectId: object.objectId }]);
    } catch {
      // Can't tell: click and see.
      return '';
    }
  }

  private async mouseClick(point: { x: number; y: number }): Promise<void> {
    const { x, y } = point;
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await this.cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  private async pressKey(press: KeyPress): Promise<void> {
    let mask = 0;
    const event = (type: string, key: KeyDefinition, extra: Record<string, unknown> = {}) =>
      this.cdp.send('Input.dispatchKeyEvent', {
        type,
        modifiers: mask,
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        ...extra,
      });
    for (const modifier of press.modifiers) {
      await event('rawKeyDown', modifier);
      mask |= { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier.key] ?? 0;
    }
    const shifted = (press.mask & 8) !== 0;
    let text = press.key.text;
    if (text && shifted && text.length === 1) text = text.toUpperCase();
    const types = press.printable || press.key.key === 'Enter' ? text : undefined;
    const key = types && text !== press.key.text ? { ...press.key, key: text! } : press.key;
    await event(
      types ? 'keyDown' : 'rawKeyDown',
      key,
      types ? { text: types, unmodifiedText: types } : {},
    );
    await event('keyUp', key);
    for (const modifier of [...press.modifiers].reverse()) {
      mask &= ~({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier.key] ?? 0);
      await event('keyUp', modifier);
    }
  }

  private waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
    if (check()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(ok);
      };
      const wake = () => {
        if (check()) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.waiters.add(wake);
    });
  }

  private changed(): void {
    for (const wake of [...this.waiters]) wake();
  }

  private log(entry: Omit<ConsoleEntry, 'at'>): void {
    // Electron warns every page it runs from source about its own settings. That's the app's
    // business, not the page's.
    if (entry.text.startsWith('%cElectron Security Warning')) return;
    this.consoleEntries.push({ ...entry, at: new Date() });
    if (this.consoleEntries.length > MAX_CONSOLE) this.consoleEntries.shift();
  }

  private onEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Page.frameNavigated': {
        const frame = params.frame as { id: string; parentId?: string; url: string };
        if (frame.parentId) return;
        this.mainFrame = frame.id;
        this.url = frame.url;
        // A new document: its elements are new, and so are their refs.
        this.refs.reset();
        this.log({ level: 'navigation', text: `Opened ${frame.url}`, source: null });
        break;
      }
      case 'Page.navigatedWithinDocument':
        if (params.frameId === this.mainFrame) this.url = params.url as string;
        break;
      case 'Page.frameStartedLoading':
        if (params.frameId === this.mainFrame || this.mainFrame === null) this.loadingNow = true;
        break;
      case 'Page.frameStoppedLoading':
        if (params.frameId === this.mainFrame) this.loadingNow = false;
        break;
      case 'Page.loadEventFired':
        this.loadingNow = false;
        break;
      case 'Page.javascriptDialogOpening': {
        // A dialog blocks the page until it's answered. Alerts are dismissed; questions are
        // answered no, since saying yes could confirm something the user never saw.
        const type = params.type as string;
        const message = (typeof params.message === 'string' ? params.message : '').slice(0, 300);
        const accept = type === 'alert' || type === 'beforeunload';
        void this.cdp.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
        this.pendingNotes.push(
          type === 'alert'
            ? `The page showed an alert: "${message}". It was closed.`
            : type === 'beforeunload'
              ? 'The page asked to confirm leaving it, and was left.'
              : `The page asked "${message}" in a ${type} dialog, and it was answered Cancel. Clanks can't answer page dialogs; ask the user if it matters.`,
        );
        this.log({ level: 'info', text: `Dialog (${type}): ${message}`, source: null });
        break;
      }
      case 'Page.fileChooserOpened':
        this.pendingNotes.push(
          "The page tried to open a file picker. Clanks can't upload files; ask the user if a file is needed.",
        );
        break;
      case 'Runtime.consoleAPICalled': {
        const type = params.type as string;
        const args =
          (params.args as { value?: unknown; description?: string; type: string }[]) ?? [];
        const text = args
          .map((a) =>
            a.value !== undefined
              ? typeof a.value === 'string'
                ? a.value
                : JSON.stringify(a.value)
              : (a.description ?? a.type),
          )
          .join(' ');
        const frame = (params.stackTrace as { callFrames?: { url: string; lineNumber: number }[] })
          ?.callFrames?.[0];
        this.log({
          level:
            type === 'error' || type === 'assert'
              ? 'error'
              : type === 'warning'
                ? 'warning'
                : type === 'debug'
                  ? 'debug'
                  : type === 'info'
                    ? 'info'
                    : 'log',
          text,
          source: frame?.url ? `${shortSource(frame.url)}:${frame.lineNumber + 1}` : null,
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as {
          text: string;
          url?: string;
          lineNumber?: number;
          exception?: { description?: string };
        };
        this.log({
          level: 'error',
          text: details.exception?.description?.split('\n')[0] ?? details.text,
          source: details.url
            ? `${shortSource(details.url)}:${(details.lineNumber ?? 0) + 1}`
            : null,
        });
        break;
      }
      case 'Log.entryAdded': {
        const entry = params.entry as { level: string; text: string; url?: string };
        this.log({
          level: entry.level === 'verbose' ? 'debug' : (entry.level as ConsoleEntry['level']),
          text: entry.text,
          source: entry.url ? shortSource(entry.url) : null,
        });
        break;
      }
      default:
        return;
    }
    this.changed();
  }
}

function shortSource(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}
