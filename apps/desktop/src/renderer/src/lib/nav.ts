import { createContext, useContext } from 'react';

/** A project's views. */
export type ProjectTab = 'board' | 'spec' | 'design' | 'context' | 'settings';

/** Where the window is. Chats aren't saved until their first message, so a new one is a draft. */
export type Route =
  | { page: 'home' }
  /** A new chat, in a project when it has one. */
  | { page: 'draft'; clankId: string; projectId?: string | null }
  | { page: 'chat'; id: string }
  | { page: 'crew'; clankId: string | null }
  /** A project, with a ticket's drawer open on the board, or a run's design open in Studio. */
  | { page: 'project'; id: string; tab: ProjectTab; ticket?: string | null; run?: string | null }
  | { page: 'new-project' }
  | { page: 'models' }
  | { page: 'settings' };

export interface Nav {
  route: Route;
  go: (route: Route) => void;
}

export const NavContext = createContext<Nav>({ route: { page: 'home' }, go: () => {} });

export function useNav(): Nav {
  return useContext(NavContext);
}
