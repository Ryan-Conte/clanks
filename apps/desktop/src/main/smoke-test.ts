import type { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

const TIMEOUT_MS = 60_000;

/**
 * `--smoke-test`: proves a build works end to end, then quits. The window must load, React must
 * mount, its tRPC calls must make it through the preload bridge to the orchestrator and the
 * migrated database, the crew's bundled priming docs must load, and the bundled llama.cpp build
 * must start and report this machine's devices.
 * CI runs this against the packaged app on every platform, with `--screenshot=<file>` to keep a
 * picture of the window.
 */
export async function runSmokeTest(window: BrowserWindow, screenshot?: string): Promise<string> {
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
        return text.trim().replace(/\s*\n\s*/g, ' | ');
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
