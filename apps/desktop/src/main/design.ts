import type { DesignHost, Drawing } from '@clanks/orchestrator';
import { BrowserWindow } from 'electron';
import { join } from 'node:path';

/** How long a frame gets to load its fonts and images and lay itself out. */
const DRAW_TIMEOUT_MS = 20_000;

/**
 * Draws designs' frames where nobody sees them: a hidden, sandboxed window on a page of the app's
 * own that has Studio's fonts, with no preload and no Node. A frame's HTML goes in, and its
 * layers' boxes and a picture come out, so what a clank's lint and render see is exactly what a
 * browser draws. One drawing at a time.
 */
export function createDesignHost(): DesignHost & { close(): void } {
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
      // As big as the limits allow, and no smaller than can still be read; then cut at the foot.
      const scale = Math.max(
        Math.min(1, minScale),
        Math.min(1, maxWidth / width, Math.sqrt(maxPixels / (width * height))),
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

  return {
    draw(input) {
      const next = queue.then(
        () => draw(input),
        () => draw(input),
      );
      queue = next.catch(() => {});
      return next;
    },
    close() {
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
