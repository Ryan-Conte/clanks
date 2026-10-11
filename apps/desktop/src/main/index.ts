import { type Orchestrator, startOrchestrator } from '@clanks/orchestrator';
import { type BrowserWindow, type Tray, app, dialog, nativeTheme, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBrowserHost } from './browser';
import { createDesignHost } from './design';
import { attachIpcHandler } from './ipc/electron';
import { createIpcHandler } from './ipc/server';
import { keychainCipher } from './keychain';
import { dataDir, resourcePath } from './paths';
import { runSmokeTest } from './smoke-test';
import { createTray } from './tray';
import { createMainWindow } from './window';

const smokeTest = app.commandLine.hasSwitch('smoke-test');

// Before anything reads them: the lock and the orchestrator live in the data folder, and
// Chromium's caches and storage for the app window go in a folder of their own inside it.
app.setPath('userData', dataDir());
app.setPath('sessionData', join(app.getPath('userData'), 'chromium'));
if (process.platform === 'win32') app.setAppUserModelId('si.clanks.app');

if (!app.requestSingleInstanceLock()) {
  // Another clanks owns this data folder. It shows its window when we try to start.
  app.quit();
} else {
  let orchestrator: Orchestrator | undefined;
  let mainWindow: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let designHost: ReturnType<typeof createDesignHost> | undefined;
  let quitting = false;

  const openWindow = () => {
    if (!orchestrator) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      const window = createMainWindow();
      window.on('close', (event) => {
        // Closing the window leaves the crew working in the tray, unless the user turned that off.
        if (!quitting && orchestrator?.context.settings.get().closeToTray) {
          event.preventDefault();
          window.hide();
        }
      });
      // The window frames are drawn in is never shown, so it mustn't keep the app open once this
      // one is gone. It's made again the next time a frame is drawn.
      window.on('closed', () => designHost?.close());
      mainWindow = window;
      return window;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  };

  app.on('second-instance', openWindow);
  app.on('activate', openWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  // The window frames are drawn in is never shown, so it doesn't count as an open one.
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    tray?.destroy();
    designHost?.close();
    orchestrator?.close();
  });

  app
    .whenReady()
    .then(async () => {
      const browserHost = createBrowserHost({
        window: () => mainWindow,
        dataDir: app.getPath('userData'),
      });
      designHost = createDesignHost();
      const started = startOrchestrator({
        dataDir: app.getPath('userData'),
        migrationsFolder: join(__dirname, 'migrations'),
        bundledCrewDir: join(__dirname, 'crew'),
        bundledIntegrationsDir: join(__dirname, 'integrations'),
        // A marketplace of your own to start from, for trying one out before it's public.
        marketplaceIndex: process.env.CLANKS_MARKETPLACE_INDEX || null,
        cipher: keychainCipher,
        bundledRuntimeDir: resourcePath('llama'),
        browserHost,
        designHost,
        // Signing in to GitHub with a code needs an OAuth app; without one, users paste a token.
        githubClientId: process.env.CLANKS_GITHUB_CLIENT_ID || null,
        host: {
          pickFolder: async ({ title, defaultPath }) => {
            const options: Electron.OpenDialogOptions = {
              title,
              ...(defaultPath ? { defaultPath } : {}),
              properties: ['openDirectory', 'createDirectory'],
            };
            const result = mainWindow
              ? await dialog.showOpenDialog(mainWindow, options)
              : await dialog.showOpenDialog(options);
            return result.canceled ? null : (result.filePaths[0] ?? null);
          },
          openFolder: async (path) => {
            const error = await shell.openPath(path);
            if (error) throw new Error(error);
          },
          saveFile: async ({ title, defaultName, extensions }, data) => {
            const options: Electron.SaveDialogOptions = {
              title,
              defaultPath: join(app.getPath('downloads'), defaultName),
              ...(extensions.length > 0
                ? { filters: [{ name: extensions.join(', ').toUpperCase(), extensions }] }
                : {}),
            };
            const result = mainWindow
              ? await dialog.showSaveDialog(mainWindow, options)
              : await dialog.showSaveDialog(options);
            if (result.canceled || !result.filePath) return null;
            await writeFile(result.filePath, data);
            return result.filePath;
          },
          openUrl: async (url) => {
            // Only ever a web page: a service's sign-in, which belongs in the user's own browser.
            if (!/^https:\/\//i.test(url)) throw new Error(`${url} isn't an https address`);
            await shell.openExternal(url);
          },
        },
        appInfo: {
          name: app.getName(),
          version: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          packaged: app.isPackaged,
          versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
          },
        },
      });
      orchestrator = started;

      const ipc = createIpcHandler({
        router: started.router,
        createContext: () => started.context,
        onError: (error, { type, path }) => {
          if (error.code === 'INTERNAL_SERVER_ERROR')
            console.error(`${type} ${path} failed`, error);
        },
      });
      attachIpcHandler(ipc, (sender) => sender === mainWindow?.webContents);

      // The app is dark, like clanks.si, so native menus and dialogs should be too.
      nativeTheme.themeSource = 'dark';
      tray = createTray({ open: openWindow, quit: () => app.quit() });
      const window = openWindow();

      if (smokeTest && window) {
        const info = await runSmokeTest(
          window,
          browserHost,
          designHost,
          app.commandLine.getSwitchValue('screenshot'),
          () => started.context.integrations.snapshot().integrations.map((i) => i.id),
        );
        console.log(`Smoke test passed: ${info}`);
        app.quit();
      }
    })
    .catch((error: unknown) => {
      console.error('clanks failed to start', error);
      app.exit(1);
    });
}
