import { type AppDataLayout, appDataLayout, ensureAppDataLayout } from './paths';
import { type AppRouter, appRouter } from './router';
import { type SecretCipher, SecretStore } from './secrets';
import { SettingsService } from './settings';
import { openStore } from './store/store';
import type { AppInfo, OrchestratorContext } from './trpc';

export interface OrchestratorOptions {
  /** The app data folder. */
  dataDir: string;
  /** Folder holding the SQL migrations, shipped next to the main bundle. */
  migrationsFolder: string;
  cipher: SecretCipher;
  appInfo: AppInfo;
}

export interface Orchestrator {
  paths: AppDataLayout;
  context: OrchestratorContext;
  router: AppRouter;
  close(): void;
}

export function startOrchestrator(options: OrchestratorOptions): Orchestrator {
  const paths = appDataLayout(options.dataDir);
  ensureAppDataLayout(paths);
  const store = openStore({ file: paths.database, migrationsFolder: options.migrationsFolder });
  const context: OrchestratorContext = {
    appInfo: options.appInfo,
    paths,
    store,
    settings: new SettingsService(store.db),
    secrets: new SecretStore(paths.secrets, options.cipher),
  };
  return { paths, context, router: appRouter, close: () => store.close() };
}
