import type { UpdateStatus } from '@clanks/core';
import type { Orchestrator } from '@clanks/orchestrator';
import { app } from 'electron';
import electronUpdater from 'electron-updater';

/** How often a running app looks for a newer version, after the look at start-up. */
const CHECK_EVERY_MS = 6 * 60 * 60_000;

export interface Updater {
  check(): Promise<void>;
  download(): Promise<void>;
  /** Restarts into the version that was fetched. */
  install(): void;
  dispose(): void;
}

/** What a release says is new, as plain text: GitHub hands it over as HTML. */
function notesOf(notes: unknown): string | null {
  const text = Array.isArray(notes)
    ? notes.map((n: { note?: string | null }) => n.note ?? '').join('\n')
    : typeof notes === 'string'
      ? notes
      : '';
  const plain = text
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain ? plain.slice(0, 2000) : null;
}

/**
 * Looks for a newer clanks on its releases page, and fetches and installs one only when the user
 * says to. An installed copy checks when it starts and a few times a day, if the setting is on.
 * A copy running from source, or one its platform's updater doesn't cover, can't update itself.
 */
export function attachUpdater(orchestrator: Orchestrator): Updater {
  const { shell, settings } = orchestrator.context;
  const { autoUpdater } = electronUpdater;
  let status: UpdateStatus = {
    state: app.isPackaged ? 'idle' : 'unsupported',
    version: null,
    progress: null,
    error: null,
    checkedAt: null,
    notes: null,
  };
  const set = (patch: Partial<UpdateStatus>) => {
    status = { ...status, ...patch };
    shell.set({ update: status });
  };
  set({});
  if (!app.isPackaged) {
    return {
      check: () => Promise.resolve(),
      download: () => Promise.resolve(),
      install: () => {},
      dispose: () => {},
    };
  }

  // Nothing is fetched or installed until the user asks.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) =>
    set({
      state: 'available',
      version: info.version,
      notes: notesOf(info.releaseNotes),
      checkedAt: new Date(),
    }),
  );
  autoUpdater.on('update-not-available', () =>
    set({ state: 'current', version: null, checkedAt: new Date() }),
  );
  autoUpdater.on('download-progress', (progress) =>
    set({ state: 'downloading', progress: progress.percent / 100 }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    set({ state: 'ready', version: info.version, progress: 1 }),
  );
  autoUpdater.on('error', (error) => {
    // No releases page yet, or no network: not worth more than a line in Settings.
    const offline = /ENOTFOUND|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|404/i.test(
      error.message,
    );
    set({
      state: 'error',
      error: offline
        ? "The releases page couldn't be reached."
        : error.message.split('\n')[0]!.slice(0, 300),
      checkedAt: new Date(),
    });
  });

  const check = async () => {
    if (status.state === 'checking' || status.state === 'downloading') return;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // The error event has said why.
    }
  };
  const quiet = () => {
    if (settings.get().autoUpdate && status.state !== 'ready') void check();
  };
  const soon = setTimeout(quiet, 15_000);
  const often = setInterval(quiet, CHECK_EVERY_MS);

  return {
    check,
    download: async () => {
      if (status.state !== 'available') return;
      set({ state: 'downloading', progress: 0 });
      try {
        await autoUpdater.downloadUpdate();
      } catch {
        // The error event has said why.
      }
    },
    install: () => {
      if (status.state === 'ready') autoUpdater.quitAndInstall(false, true);
    },
    dispose: () => {
      clearTimeout(soon);
      clearInterval(often);
    },
  };
}
