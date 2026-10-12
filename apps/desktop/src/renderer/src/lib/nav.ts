import type { PackageKind } from '@clanks/core';
import { createContext, useContext } from 'react';

/** A project's views. Overview is the conversation with the crew at work beside it. */
export type ProjectTab =
  'overview' | 'board' | 'spec' | 'design' | 'routines' | 'context' | 'settings';

/** The groups the settings are in. */
export type SettingsSection = 'you' | 'safety' | 'connections' | 'models' | 'app';

/** A package in a marketplace, by where it's listed. */
export interface PackageRef {
  index: string;
  kind: PackageKind;
  id: string;
}

/** Where the window is. Chats aren't saved until their first message, so a new one is a draft. */
export type Route =
  | { page: 'home' }
  /** First run's screen, opened again from wherever the crew turns out to have no model. */
  | { page: 'setup' }
  /** A new chat, in a project when it has one, where a ticket's drawer can be open beside it. */
  | { page: 'draft'; clankId: string; projectId?: string | null; ticket?: string | null }
  /**
   * A chat. One of the user's own in a project shows in that project's overview; `projectId` says
   * which when the caller knows, for a chat so new the list hasn't caught up.
   */
  | { page: 'chat'; id: string; projectId?: string | null; ticket?: string | null }
  | { page: 'crew'; clankId: string | null }
  /** The form for a custom clank. */
  | { page: 'new-clank' }
  /**
   * A project, with a ticket's drawer open on the overview or the board, a run's design open in
   * Studio, or a routine, a run or an action brought into view on its Routines tab.
   */
  | {
      page: 'project';
      id: string;
      tab: ProjectTab;
      ticket?: string | null;
      run?: string | null;
      focus?: string | null;
    }
  /** The form for a project, starting from what was written on Home when it came from there. */
  | { page: 'new-project'; idea?: string; templateId?: string | null }
  | { page: 'models' }
  /** The marketplace, or one package in it. */
  | { page: 'marketplace'; open?: PackageRef | null }
  /** The settings, at one of their groups when something sends the user to it. */
  | { page: 'settings'; section?: SettingsSection | null };

export interface Nav {
  route: Route;
  go: (route: Route) => void;
}

export const NavContext = createContext<Nav>({ route: { page: 'home' }, go: () => {} });

export function useNav(): Nav {
  return useContext(NavContext);
}

/** Opens a ticket's drawer beside the conversation the window is in, or closes it. */
export function useOpenTicket(projectId: string): (ticketId: string | null) => void {
  const { route, go } = useNav();
  return (ticket) => {
    if (route.page === 'chat' || route.page === 'draft') go({ ...route, ticket });
    else go({ page: 'project', id: projectId, tab: 'overview', ticket });
  };
}
