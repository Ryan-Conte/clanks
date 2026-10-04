import { Menu, Tray, nativeImage } from 'electron';
import { resourcePath } from './paths';

export interface TrayActions {
  open: () => void;
  quit: () => void;
}

/** The tray icon keeps clanks reachable while its window is closed and work carries on. */
export function createTray({ open, quit }: TrayActions): Tray {
  // macOS tints template images to match the menu bar; elsewhere use the colour icon.
  const icon = nativeImage.createFromPath(
    resourcePath(process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  const tray = new Tray(icon);
  tray.setToolTip('clanks');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open clanks', click: open },
      { type: 'separator' },
      { label: 'Quit clanks', click: quit },
    ]),
  );
  // On macOS a click opens the menu; on Windows and Linux it opens the window.
  if (process.platform !== 'darwin') tray.on('click', open);
  return tray;
}
