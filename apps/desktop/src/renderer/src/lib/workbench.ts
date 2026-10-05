import type { WorkspaceState } from '@clanks/core';
import { createContext, useContext } from 'react';

export type WorkbenchTab = 'diff' | 'terminal' | 'activity';

/** Where something asked the workbench to look: a step in the diff, a command's output. */
export interface WorkbenchFocus {
  tab?: WorkbenchTab;
  /** The diff at this checkpoint: what that step changed, or the run up to it. */
  checkpointId?: string;
  diff?: 'step' | 'upTo';
  /** A terminal session to show. */
  sessionId?: string;
  /** Counts up, so asking for the same place twice still moves the panes. */
  nonce: number;
}

export interface Workbench {
  /** The chat's workspace, kept live. Null until it first arrives, or for a draft. */
  state: WorkspaceState | null;
  conversationId: string | null;
  /** The chat's clank is writing a reply. */
  replying: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  focus: WorkbenchFocus | null;
  show: (focus: Omit<WorkbenchFocus, 'nonce'>) => void;
}

export const WorkbenchContext = createContext<Workbench>({
  state: null,
  conversationId: null,
  replying: false,
  open: false,
  setOpen: () => {},
  focus: null,
  show: () => {},
});

export function useWorkbench(): Workbench {
  return useContext(WorkbenchContext);
}
