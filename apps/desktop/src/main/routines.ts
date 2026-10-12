import type { ShellArrangement } from '@clanks/core';
import type { Orchestrator } from '@clanks/orchestrator';
import {
  BACKGROUND_SWITCH,
  LAUNCH_TASK,
  launchTime,
  launchdCommands,
  launchdPlist,
  sleepNote,
  systemdCommands,
  systemdUnits,
  whenText,
  windowsTaskCommands,
  windowsTaskXml,
} from '@clanks/routines';
import { Notification, app, powerMonitor, powerSaveBlocker } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/** A line of the tray's menu about what's coming up. */
export interface TrayLine {
  label: string;
}

export interface RoutineShell {
  /** What's coming up, for the tray's menu. */
  lines(): TrayLine[];
  paused(): boolean;
  setPaused(paused: boolean): void;
  dispose(): void;
}

const run = (command: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
  });

/**
 * What routines need from the computer: a notification when something waits on the user, staying
 * awake while work is due, starting with the computer, and being started by the OS a few minutes
 * before the next run when the app isn't running. Each follows its setting.
 */
export function attachRoutines(options: {
  orchestrator: Orchestrator;
  /** Shows the window, for a notification that was clicked. */
  open: () => void;
  /** The tray's menu shows what's coming up, so it's built again when that changes. */
  onChange: () => void;
}): RoutineShell {
  const { routines, settings, shell } = options.orchestrator.context;
  let blocker: number | null = null;
  let launchAt: number | null = null;
  let loginItem: boolean | null = null;
  let timer: NodeJS.Timeout | null = null;
  // Kept so a notification isn't collected, and its click lost, while it's on screen.
  const shown = new Set<Notification>();

  routines.on('notice', (notice) => {
    if (!settings.get().notifications || !Notification.isSupported()) return;
    const notification = new Notification({ title: notice.title, body: notice.body });
    shown.add(notification);
    const forget = () => shown.delete(notification);
    // It opens the card. Nothing is approved from a notification.
    notification.on('click', () => {
      forget();
      options.open();
      shell.open({
        page: 'routines',
        projectId: notice.projectId,
        runId: notice.runId,
        actionId: notice.actionId,
      });
    });
    notification.on('close', forget);
    notification.show();
  });

  /** The computer stays awake while a run is working or an action is about to go out. */
  const keepAwake = () => {
    const wanted = settings.get().keepAwake && routines.busy();
    if (wanted && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!wanted && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  };

  const atLogin = (): ShellArrangement => {
    const wanted = settings.get().launchAtLogin;
    if (!app.isPackaged) return 'unsupported';
    if (wanted === loginItem) return wanted ? 'on' : 'off';
    try {
      if (process.platform === 'linux') {
        const file = join(homedir(), '.config', 'autostart', 'clanks.desktop');
        if (wanted) {
          mkdirSync(join(file, '..'), { recursive: true });
          writeFileSync(
            file,
            [
              '[Desktop Entry]',
              'Type=Application',
              'Name=clanks',
              `Exec="${process.execPath}" ${BACKGROUND_SWITCH}`,
              'X-GNOME-Autostart-enabled=true',
              '',
            ].join('\n'),
          );
        } else if (existsSync(file)) rmSync(file);
      } else {
        app.setLoginItemSettings({ openAtLogin: wanted, args: [BACKGROUND_SWITCH] });
      }
      loginItem = wanted;
      return wanted ? 'on' : 'off';
    } catch {
      return 'failed';
    }
  };

  /** Points the OS task at the next run or action, or removes it when nothing is coming. */
  const launchTask = async (): Promise<{ state: ShellArrangement; next: Date | null }> => {
    if (!app.isPackaged) return { state: 'unsupported', next: null };
    const wanted = settings.get().launchForRuns && !settings.get().routinesPaused;
    const due = wanted ? routines.nextWake() : null;
    const at = due ? launchTime(due, new Date()) : null;
    const minute = at ? Math.floor(+at / 60_000) : null;
    if (minute === launchAt) return { state: wanted ? 'on' : 'off', next: at };
    const folder = app.getPath('userData');
    try {
      if (process.platform === 'win32') {
        const file = join(folder, 'next-routine.xml');
        const commands = windowsTaskCommands(file);
        if (at) {
          // Task Scheduler reads its XML as UTF-16 with a byte order mark.
          writeFileSync(
            file,
            `${String.fromCharCode(0xfeff)}${windowsTaskXml({ exe: process.execPath, at, wake: true })}`,
            'utf16le',
          );
          await run(commands.register[0]!, commands.register.slice(1));
        } else if (launchAt !== null) {
          await run(commands.remove[0]!, commands.remove.slice(1)).catch(() => {});
        }
      } else if (process.platform === 'darwin') {
        const file = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCH_TASK.macos}.plist`);
        const commands = launchdCommands(file, userInfo().uid);
        // The bundle, not the binary inside it: `open -a` takes the app.
        const bundle = process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/, '');
        if (at) {
          mkdirSync(join(file, '..'), { recursive: true });
          writeFileSync(file, launchdPlist({ app: bundle, at }));
          await run(commands.register[0]![0]!, commands.register[0]!.slice(1)).catch(() => {});
          await run(commands.register[1]![0]!, commands.register[1]!.slice(1));
        } else if (launchAt !== null) {
          await run(commands.remove[0]!, commands.remove.slice(1)).catch(() => {});
          if (existsSync(file)) rmSync(file);
        }
      } else {
        const units = join(homedir(), '.config', 'systemd', 'user');
        const commands = systemdCommands();
        if (at) {
          const written = systemdUnits({ exe: process.execPath, at });
          mkdirSync(units, { recursive: true });
          writeFileSync(join(units, `${LAUNCH_TASK.linux}.service`), written.service);
          writeFileSync(join(units, `${LAUNCH_TASK.linux}.timer`), written.timer);
          for (const command of commands.register) await run(command[0]!, command.slice(1));
        } else if (launchAt !== null) {
          for (const command of commands.remove) {
            await run(command[0]!, command.slice(1)).catch(() => {});
          }
        }
      }
      launchAt = minute;
      return { state: wanted ? 'on' : 'off', next: at };
    } catch (error) {
      console.error("The task that starts clanks before a run couldn't be set", error);
      return { state: 'failed', next: null };
    }
  };

  let applying = false;
  const apply = async () => {
    if (applying) return;
    applying = true;
    try {
      keepAwake();
      const login = atLogin();
      const task = await launchTask();
      shell.set({
        launch: {
          atLogin: login,
          forRuns: task.state,
          note: app.isPackaged
            ? sleepNote(process.platform)
            : 'Running from source: the installed app sets these up.',
          next: task.next,
        },
      });
      options.onChange();
    } finally {
      applying = false;
    }
  };
  // Changes come in bursts while the crew works: once they've settled is soon enough.
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void apply(), 1500);
  };
  routines.on('change', soon);
  settings.on('change', soon);
  const minute = setInterval(() => void apply(), 60_000);
  // What came due while the computer slept is dealt with as soon as it wakes.
  const woke = () => routines.resume();
  powerMonitor.on('resume', woke);
  powerMonitor.on('unlock-screen', woke);
  void apply();

  return {
    lines: () => {
      const overview = routines.overview();
      const now = new Date();
      const zone = settings.get().profile.timeZone || undefined;
      return overview.coming.slice(0, 5).map((coming) => ({
        label: `${whenText(coming.at, zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now)}  ${coming.title}${coming.kind === 'action' && coming.status === 'pending_approval' ? ' (needs approval)' : ''}`,
      }));
    },
    paused: () => settings.get().routinesPaused,
    setPaused: (paused) => {
      settings.update({ routinesPaused: paused });
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      clearInterval(minute);
      powerMonitor.off('resume', woke);
      powerMonitor.off('unlock-screen', woke);
      if (blocker !== null) powerSaveBlocker.stop(blocker);
    },
  };
}
