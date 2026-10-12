import type { ShellRoute, ShellStatus, UpdateStatus } from '@clanks/core';
import { EventEmitter } from 'node:events';

const NO_UPDATES: UpdateStatus = {
  state: 'unsupported',
  version: null,
  progress: null,
  error: null,
  checkedAt: null,
  notes: null,
};

/**
 * What the desktop shell tells the window besides answering its calls: where to go when the user
 * clicks a notification, whether a newer clanks is out, and what it could and couldn't set up
 * with the OS. The shell sets these; the window reads them. Emits `open` and `change`.
 */
export class ShellService extends EventEmitter<{ open: [route: ShellRoute]; change: [] }> {
  private current: ShellStatus = {
    update: NO_UPDATES,
    crashReports: { canSend: false, folder: null },
    launch: { atLogin: 'unsupported', forRuns: 'unsupported', note: null, next: null },
  };

  status(): ShellStatus {
    return this.current;
  }

  /** The shell says what changed. */
  set(patch: Partial<ShellStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit('change');
  }

  /** Sends the window somewhere, such as to the routine a notification was about. */
  open(route: ShellRoute): void {
    this.emit('open', route);
  }
}
