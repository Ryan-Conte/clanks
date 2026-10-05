import { type Orchestrator, startOrchestrator } from '@clanks/orchestrator';
import { type BrowserWindow, type Tray, app, dialog, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
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
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    tray?.destroy();
    orchestrator?.close();
  });

  app
    .whenReady()
    .then(async () => {
      const started = startOrchestrator({
        dataDir: app.getPath('userData'),
        migrationsFolder: join(__dirname, 'migrations'),
        cipher: keychainCipher,
        bundledRuntimeDir: resourcePath('llama'),
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
        const info = await runSmokeTest(window, app.commandLine.getSwitchValue('screenshot'));
        console.log(`Smoke test passed: ${info}`);
        app.quit();
      }
    })
    .catch((error: unknown) => {
      console.error('clanks failed to start', error);
      app.exit(1);
    });
}
