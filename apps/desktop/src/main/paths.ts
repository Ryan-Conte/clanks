import { app } from 'electron';
import { join, resolve, sep } from 'node:path';

/**
 * The app data folder. Set before the app is ready, since Chromium keeps its own data there too.
 * `CLANKS_DATA_DIR` overrides it, for tests and for running a second copy side by side.
 */
export function dataDir(): string {
  const override = process.env.CLANKS_DATA_DIR;
  if (override) return resolve(override);
  // Running from source never touches an installed copy's data.
  const name = app.isPackaged ? 'clanks' : 'clanks-dev';
  // Models, worktrees and the database belong to this machine, so on Windows they go in
  // Local AppData rather than the roaming profile.
  const base =
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : app.getPath('appData');
  return join(base, name);
}

/** A file in `resources/`, unpacked from the asar archive so the OS can read it directly. */
export function resourcePath(name: string): string {
  return join(app.getAppPath(), 'resources', name).replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  );
}
