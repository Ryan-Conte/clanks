import { BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { resourcePath } from './paths';

/** The clanks.si background. Matches `--color-ink` in the window's styles. */
const INK = '#050506';
/** Matches the title bar's height in the window (`h-10`). */
const TITLE_BAR_HEIGHT = 40;

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'clanks',
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: INK,
    // The window draws its own title bar, in the app's colours. macOS keeps its traffic lights;
    // Windows and Linux draw their controls over the bar's right end.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 13 } }
      : { titleBarOverlay: { color: INK, symbolColor: '#a1a1aa', height: TITLE_BAR_HEIGHT } }),
    ...(process.platform === 'linux' ? { icon: resourcePath('icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  // The app window only ever shows the app. Links open in the user's own browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return window;
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
