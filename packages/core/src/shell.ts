/** Where the desktop shell sends the window, such as when a notification is clicked. */
export type ShellRoute =
  | { page: 'home' }
  | { page: 'settings' }
  /** A project's routines, with a run's card or one action open. */
  | { page: 'routines'; projectId: string; runId: string | null; actionId: string | null };

/** Whether a newer clanks is out, and how far along fetching it is. */
export interface UpdateStatus {
  /**
   * `unsupported` for a copy that can't update itself: one running from source, or an install
   * its platform's updater doesn't cover.
   */
  state:
    | 'unsupported'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'current'
    | 'error';
  /** The version that's out, once one is found. */
  version: string | null;
  /** How much of it has been fetched, from 0 to 1. */
  progress: number | null;
  error: string | null;
  checkedAt: Date | null;
  /** What's new in it, as its release says. */
  notes: string | null;
}

/** How one of the shell's arrangements with the OS stands. */
export type ShellArrangement = 'unsupported' | 'off' | 'on' | 'failed';

/** What the desktop shell has set up outside the app, for Settings to show. */
export interface ShellStatus {
  update: UpdateStatus;
  crashReports: {
    /** This build has somewhere to send reports. Without one they only stay on this computer. */
    canSend: boolean;
    /** Where crash dumps are kept. */
    folder: string | null;
  };
  launch: {
    /** Starting with the computer. */
    atLogin: ShellArrangement;
    /** The OS task that starts the app before the next run or action. */
    forRuns: ShellArrangement;
    /** What the platform can't do, or why setting it up failed. */
    note: string | null;
    /** When the task will next start the app. */
    next: Date | null;
  };
}
