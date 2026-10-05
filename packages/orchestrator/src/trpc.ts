import type { ModelManager } from '@clanks/models';
import type { ProviderRegistry } from '@clanks/providers';
import { initTRPC } from '@trpc/server';
import type { AppDataLayout } from './paths';
import type { SecretStore } from './secrets';
import type { SettingsService } from './settings';
import type { Store } from './store/store';

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  /** True for an installed build, false when running from source. */
  packaged: boolean;
  versions: { electron: string; chrome: string; node: string };
}

/** What the desktop shell does for the orchestrator: native dialogs and the file manager. */
export interface Host {
  /** Asks the user to pick a folder. Null if they cancel. */
  pickFolder(options: { title: string; defaultPath?: string }): Promise<string | null>;
  /** Opens a folder in the system file manager. */
  openFolder(path: string): Promise<void>;
}

export interface OrchestratorContext {
  appInfo: AppInfo;
  paths: AppDataLayout;
  store: Store;
  settings: SettingsService;
  secrets: SecretStore;
  models: ModelManager;
  providers: ProviderRegistry;
  host: Host | null;
}

const t = initTRPC.context<OrchestratorContext>().create({
  isServer: true,
  // Values cross Electron IPC by structured clone, which keeps Dates, Maps and Sets as they are.
  // An identity transformer tells tRPC so, which keeps the window's inferred types honest: a Date
  // stays a Date rather than becoming the string JSON would make of it.
  transformer: { serialize: (value: unknown) => value, deserialize: (value: unknown) => value },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
