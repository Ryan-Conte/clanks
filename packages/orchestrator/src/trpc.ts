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

export interface OrchestratorContext {
  appInfo: AppInfo;
  paths: AppDataLayout;
  store: Store;
  settings: SettingsService;
  secrets: SecretStore;
}

const t = initTRPC.context<OrchestratorContext>().create({ isServer: true });

export const router = t.router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;
