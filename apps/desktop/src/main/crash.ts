import type { Orchestrator } from '@clanks/orchestrator';
import { app, crashReporter } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where crash reports go, when the user has turned sending on. It's set when the app is built
 * (`MAIN_VITE_CLANKS_CRASH_URL`), or with `CLANKS_CRASH_URL` when it's run. A build with neither
 * has nowhere to send them, and says so.
 */
function submitUrl(): string | null {
  const url = process.env.CLANKS_CRASH_URL || import.meta.env.MAIN_VITE_CLANKS_CRASH_URL || '';
  return /^https:\/\//i.test(url) ? url : null;
}

/**
 * Starts collecting crash dumps, on this computer only. Called before the app is ready, so a
 * crash while starting is caught too. Nothing leaves the computer until `attachCrashReports` finds
 * the user has asked for that.
 */
export function startCrashReports(): void {
  const url = submitUrl();
  try {
    crashReporter.start({
      productName: 'clanks',
      ...(url ? { submitURL: url } : {}),
      uploadToServer: false,
      compress: true,
      // Nothing that says who the user is or what they were working on.
      globalExtra: { version: app.getVersion(), platform: process.platform, arch: process.arch },
    });
  } catch (error) {
    console.error("Crash reports couldn't be set up", error);
  }
  // An error nothing caught is written down rather than lost, and the app carries on.
  process.on('uncaughtException', (error) => {
    console.error('An error nothing caught', error);
    try {
      const folder = join(app.getPath('userData'), 'logs');
      mkdirSync(folder, { recursive: true });
      appendFileSync(
        join(folder, 'errors.log'),
        `${new Date().toISOString()} ${app.getVersion()} ${error.stack ?? error.message}\n\n`,
      );
    } catch {
      // The drive is full, or gone: there's nowhere left to say so.
    }
  });
}

/** Sends crash reports only while the user's setting says to, and this build has somewhere to. */
export function attachCrashReports(orchestrator: Orchestrator): void {
  const { settings, shell } = orchestrator.context;
  const canSend = submitUrl() !== null;
  const apply = () => {
    try {
      crashReporter.setUploadToServer(canSend && settings.get().crashReports);
    } catch {
      // Linux can't change this once started: reports stay on the computer there.
    }
  };
  shell.set({ crashReports: { canSend, folder: app.getPath('crashDumps') } });
  settings.on('change', apply);
  apply();
}
