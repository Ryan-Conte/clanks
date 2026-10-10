import type { Painted } from '@clanks/design';
import type { DesignHost, Drawing } from '@clanks/orchestrator';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/** How long a frame gets to load its fonts and images and lay itself out. */
const DRAW_TIMEOUT_MS = 20_000;
/** CSS pixels to the inch, which is what a PDF's page is sized in. */
const PX_PER_INCH = 96;

/**
 * Draws designs' frames where nobody sees them: a hidden, sandboxed window on a page of the app's
 * own that has Studio's fonts, with no preload and no Node. A frame's HTML goes in, and its
 * layers' boxes and a picture come out, so what a clank's lint and render see is exactly what a
 * browser draws. The same page paints frames for SVG exports and prints frames and documents to
 * PDF, in the fonts Studio has. One job at a time.
 */
export function createDesignHost(): Required<DesignHost> & { close(): void } {
  let window: BrowserWindow | null = null;
  let loading: Promise<BrowserWindow> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const open = (): Promise<BrowserWindow> => {
    if (window && !window.isDestroyed()) return Promise.resolve(window);
    loading ??= (async () => {
      const created = new BrowserWindow({
        show: false,
        width: 1440,
        height: 900,
        webPreferences: {
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          spellcheck: false,
        },
      });
      // It only ever shows the app's own page.
      created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      created.webContents.on('will-navigate', (event) => event.preventDefault());
      const devServer = process.env.ELECTRON_RENDERER_URL;
      if (devServer) await created.loadURL(`${devServer}/frame.html`);
      else await created.loadFile(join(__dirname, '../renderer/frame.html'));
      created.webContents.debugger.attach('1.3');
      created.on('closed', () => {
        if (window === created) window = null;
      });
      window = created;
      return created;
    })().finally(() => {
      loading = null;
    });
    return loading;
  };

  const draw = async (input: Parameters<DesignHost['draw']>[0]): Promise<Drawing> => {
    const target = await open();
    const contents = target.webContents;
    const send = <T>(method: string, params: Record<string, unknown>) =>
      contents.debugger.sendCommand(method, params) as Promise<T>;
    target.setContentSize(Math.min(4000, Math.max(200, input.width)), 900);
    const evaluated = await send<{
      result: { value?: Omit<Drawing, 'png'> };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', {
      // The page's own script lays the frame out and measures it.
      expression: `window.clanksDraw(${JSON.stringify(input.html)})`,
      awaitPromise: true,
      returnByValue: true,
      timeout: DRAW_TIMEOUT_MS,
    });
    const measured = evaluated.result.value;
    if (evaluated.exceptionDetails || !measured) {
      throw new Error(
        `The frame couldn't be drawn: ${evaluated.exceptionDetails?.text ?? 'no result'}`,
      );
    }
    let png: Uint8Array | null = null;
    let picture: Drawing['picture'];
    if (input.capture && measured.width > 0 && measured.height > 0) {
      const { maxWidth, maxPixels, minScale } = input.capture;
      const { width, height } = measured;
      // Its own size unless a bigger one is asked for, as an export may.
      const wanted = input.capture.scale ?? 1;
      // As big as the limits allow, and no smaller than can still be read; then cut at the foot.
      const scale = Math.max(
        Math.min(wanted, minScale),
        Math.min(wanted, maxWidth / width, Math.sqrt(maxPixels / (width * height))),
      );
      const shown = Math.min(height, maxPixels / (scale * scale * width));
      picture = {
        width: Math.round(width * scale),
        height: Math.round(shown * scale),
        cut: shown < height - 1,
      };
      const shot = await send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.ceil(measured.width),
          height: Math.ceil(shown),
          scale,
        },
      });
      png = Buffer.from(shot.data, 'base64');
    }
    return { ...measured, png, picture };
  };

  /** Runs one of the page's own functions with some HTML, and resolves with what it returns. */
  const evaluate = async <T>(target: BrowserWindow, expression: string): Promise<T> => {
    const evaluated = (await target.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: DRAW_TIMEOUT_MS,
    })) as { result: { value?: T }; exceptionDetails?: { text: string } };
    if (evaluated.exceptionDetails) {
      throw new Error(`The frame couldn't be drawn: ${evaluated.exceptionDetails.text}`);
    }
    return evaluated.result.value as T;
  };

  const paint = async (input: { html: string; width: number }): Promise<Painted> => {
    const target = await open();
    target.setContentSize(Math.min(4000, Math.max(200, input.width)), 900);
    const painted = await evaluate<Painted | undefined>(
      target,
      `window.clanksPaint(${JSON.stringify(input.html)})`,
    );
    if (!painted) throw new Error("The frame couldn't be drawn: no result");
    return painted;
  };

  const print = async (
    input: Parameters<Required<DesignHost>['print']>[0],
  ): Promise<Uint8Array> => {
    const target = await open();
    const page = input.page === 'a4' ? null : input.page;
    if (page) target.setContentSize(Math.min(4000, Math.max(200, page.width)), 900);
    await evaluate<void>(
      target,
      `window.clanksPage(${JSON.stringify(input.html)}, ${JSON.stringify(page)})`,
    );
    // The page's own CSS says how big a sheet is and what margins it has.
    const pdf = await target.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: page
        ? { width: page.width / PX_PER_INCH, height: page.height / PX_PER_INCH }
        : 'A4',
    });
    return new Uint8Array(pdf);
  };

  /** One job at a time: they share the one page. */
  const queued = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => {});
    return next;
  };

  return {
    draw: (input) => queued(() => draw(input)),
    paint: (input) => queued(() => paint(input)),
    print: (input) => queued(() => print(input)),
    close() {
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
