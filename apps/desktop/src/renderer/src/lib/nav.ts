import type { PackageKind } from '@clanks/core';
import { createContext, useContext } from 'react';

/** A project's views. */
export type ProjectTab = 'board' | 'spec' | 'design' | 'routines' | 'context' | 'settings';

/** A package in a marketplace, by where it's listed. */
export interface PackageRef {
  index: string;
  kind: PackageKind;
  id: string;
}

/** Where the window is. Chats aren't saved until their first message, so a new one is a draft. */
export type Route =
  | { page: 'home' }
  /** A new chat, in a project when it has one. */
  | { page: 'draft'; clankId: string; projectId?: string | null }
  | { page: 'chat'; id: string }
  | { page: 'crew'; clankId: string | null }
  /** The form for a custom clank. */
  | { page: 'new-clank' }
  /**
   * A project, with a ticket's drawer open on the board, a run's design open in Studio, or a
   * routine, a run or an action brought into view on its Routines tab.
   */
  | {
      page: 'project';
      id: string;
      tab: ProjectTab;
      ticket?: string | null;
      run?: string | null;
      focus?: string | null;
    }
  | { page: 'new-project' }
  | { page: 'models' }
  /** The marketplace, or one package in it. */
  | { page: 'marketplace'; open?: PackageRef | null }
  | { page: 'settings' };

export interface Nav {
  route: Route;
  go: (route: Route) => void;
}

export const NavContext = createContext<Nav>({ route: { page: 'home' }, go: () => {} });

export function useNav(): Nav {
  return useContext(NavContext);
}
