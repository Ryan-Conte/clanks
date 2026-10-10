import { type BrowserHost, PageDriver } from '@clanks/browser';
import type { DesignHost } from '@clanks/orchestrator';
import type { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

const TIMEOUT_MS = 60_000;

/**
 * `--smoke-test`: proves a build works end to end, then quits. The window must load, React must
 * mount, its tRPC calls must make it through the preload bridge to the orchestrator and the
 * migrated database, the crew's bundled priming docs must load, the bundled llama.cpp build must
 * start and report this machine's devices, the browser pane must read and click a page, and a
 * design's frame must be drawn, measured and pictured out of sight.
 * CI runs this against the packaged app on every platform, with `--screenshot=<file>` to keep a
 * picture of the window.
 */
export async function runSmokeTest(
  window: BrowserWindow,
  browser: BrowserHost,
  design: DesignHost,
  screenshot?: string,
): Promise<string> {
  // Anything the window reports goes to the log, so a failure in CI says why.
  const { webContents } = window;
  webContents.on('console-message', ({ level, message }) =>
    console.log(`[window ${level}] ${message}`),
  );
  webContents.on('preload-error', (_event, path, error) =>
    console.error(`[window] preload ${path} failed`, error),
  );
  webContents.on('did-fail-load', (_event, code, description, url) =>
    console.error(`[window] failed to load ${url}: ${description} (${code})`),
  );
  webContents.on('render-process-gone', (_event, details) =>
    console.error(`[window] renderer gone: ${details.reason}`),
  );

  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    if (window.isDestroyed()) throw new Error('The window closed');
    if (!window.webContents.isLoading()) {
      const [text, crew] = (await window.webContents.executeJavaScript(
        `[document.querySelector('[data-testid="hardware"] dl')?.innerText ?? '',
          document.querySelector('[data-testid="crew"]')?.innerText ?? '']`,
      )) as [string, string];
      if (text && crew.includes('Atlas')) {
        if (screenshot) await saveScreenshot(window, screenshot);
        const browsed = await checkBrowser(browser);
        const drawn = await checkDesign(design);
        return `${text.trim().replace(/\s*\n\s*/g, ' | ')} | ${browsed} | ${drawn}`;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The app didn't show this machine's hardware and the crew within ${TIMEOUT_MS / 1000}s`,
      );
    }
    await sleep(250);
  }
}

const SMOKE_PAGE = `<title>Smoke</title><h1>Waves</h1>
<button onclick="document.title = 'Clicked'">Paddle out</button>`;

/** Opens a tab, reads it as the clanks do, clicks its button over CDP and takes a picture. */
async function checkBrowser(host: BrowserHost): Promise<string> {
  const tab = host.open({
    session: { key: 'smoke-test', persistent: false },
    guard: () => true,
    events: { state: () => {}, windowOpen: () => {}, download: () => {} },
  });
  try {
    await tab.ready;
    const driver = new PageDriver(tab.cdp);
    await driver.attach();
    await tab.load(`data:text/html,${encodeURIComponent(SMOKE_PAGE)}`);
    const page = await driver.snapshot();
    if (!page.lines.includes('[1] button "Paddle out"')) {
      throw new Error(`The browser read the page as: ${page.lines.join(' | ')}`);
    }
    await driver.click(1);
    if ((await driver.evaluate<string>('document.title')) !== 'Clicked') {
      throw new Error("Clicking the page's button over CDP did nothing");
    }
    const picture = await tab.capture({ maxWidth: 400, quality: 50 });
    return `browser read and clicked a page (${picture.length}-byte picture)`;
  } finally {
    tab.close();
  }
}

const SMOKE_FRAME = `<div data-design-root style="display: inline-block; position: relative;">
<div data-key="n1" data-id="n1" style="box-sizing: border-box; display: flex; width: 320px; padding: 16px; background: #0a6cff;">
<div data-key="n2" data-id="n2" style="font-family: 'Inter Variable'; font-size: 24px; color: #ffffff;">Waves</div>
</div></div>`;

/** Draws a frame the way lint and `design_render` do: laid out, measured, and pictured. */
async function checkDesign(host: DesignHost): Promise<string> {
  const drawing = await host.draw({
    html: SMOKE_FRAME,
    width: 320,
    capture: { maxWidth: 1024, maxPixels: 1_000_000, minScale: 0.4 },
  });
  const frame = drawing.boxes.n1;
  const text = drawing.boxes.n2;
  if (!frame || Math.round(frame.w) !== 320 || !text || text.w <= 0 || text.w >= 320) {
    throw new Error(`A frame was measured as ${JSON.stringify(drawing.boxes)}`);
  }
  if (!drawing.png || drawing.png.length < 100) throw new Error("A frame's picture came out empty");
  return `drew a frame (${Math.round(frame.w)}x${Math.round(frame.h)}, ${drawing.png.length}-byte picture)`;
}

/** Best effort: capturing can fail before the first frame is drawn, which isn't a failed test. */
async function saveScreenshot(window: BrowserWindow, file: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      writeFileSync(file, (await window.webContents.capturePage()).toPNG());
      return;
    } catch (error) {
      if (attempt === 3) {
        console.warn("Couldn't save a screenshot", error);
        return;
      }
      await sleep(500);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
