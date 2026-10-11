import { Menu, type MenuItemConstructorOptions, Tray, nativeImage } from 'electron';
import { resourcePath } from './paths';
import type { RoutineShell } from './routines';

export interface TrayActions {
  open: () => void;
  quit: () => void;
  /** What's scheduled, once the orchestrator is up. */
  routines: () => RoutineShell | undefined;
}

export interface AppTray {
  /** Builds the menu again, after what it lists has changed. */
  refresh(): void;
  destroy(): void;
}

/**
 * The tray icon keeps clanks reachable while its window is closed and work carries on. Its menu
 * lists the next runs and actions, and has the switch that pauses every routine.
 */
export function createTray({ open, quit, routines }: TrayActions): AppTray {
  // macOS tints template images to match the menu bar; elsewhere use the colour icon.
  const icon = nativeImage.createFromPath(
    resourcePath(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  const tray = new Tray(icon);
  tray.setToolTip('clanks');
  const refresh = () => {
    const shell = routines();
    const lines = shell?.lines() ?? [];
    const coming: MenuItemConstructorOptions[] =
      lines.length > 0
        ? [
            { label: 'Coming up', enabled: false },
            ...lines.map((line) => ({ label: line.label, click: open })),
            { type: 'separator' as const },
          ]
        : [];
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open clanks', click: open },
        { type: 'separator' },
        ...coming,
        ...(shell
          ? [
              {
                label: 'Pause routines',
                type: 'checkbox' as const,
                checked: shell.paused(),
                click: () => shell.setPaused(!shell.paused()),
              },
              { type: 'separator' as const },
            ]
          : []),
        { label: 'Quit clanks', click: quit },
      ]),
    );
  };
  refresh();
  // On macOS a click opens the menu; on Windows and Linux it opens the window.
  if (process.platform !== 'darwin') tray.on('click', open);
  return { refresh, destroy: () => tray.destroy() };
}
