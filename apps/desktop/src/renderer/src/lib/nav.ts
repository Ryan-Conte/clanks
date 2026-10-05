import { createContext, useContext } from 'react';

/** Where the window is. Chats aren't saved until their first message, so a new one is a draft. */
export type Route =
  | { page: 'home' }
  | { page: 'draft'; clankId: string }
  | { page: 'chat'; id: string }
  | { page: 'crew'; clankId: string | null }
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
