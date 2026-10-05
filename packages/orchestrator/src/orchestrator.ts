import { ModelManager, type ModelManagerOptions, parseModelRef } from '@clanks/models';
import { ProviderRegistry, createBuiltinProvider } from '@clanks/providers';
import { ChatService } from './chat/service';
import { ChatStore } from './chat/store';
import { CrewService } from './crew/crew';
import { LocalApi } from './local-api/server';
import { type AppDataLayout, appDataLayout, ensureAppDataLayout } from './paths';
import { ProviderService, type ProviderServiceOptions } from './providers';
import { type AppRouter, appRouter } from './router';
import { type SecretCipher, SecretStore } from './secrets';
import { SettingsService } from './settings';
import { sqliteModelRepository } from './store/models';
import { openStore } from './store/store';
import type { AppInfo, Host, OrchestratorContext } from './trpc';

/** The keychain entry for a Hugging Face token, used for gated and private repos. */
export const HF_TOKEN = 'hf:token';
const MODELS_DIR = 'models.dir';

export interface OrchestratorOptions {
  /** The app data folder. */
  dataDir: string;
  /** Folder holding the SQL migrations, shipped next to the main bundle. */
  migrationsFolder: string;
  /** The crew's priming docs, shipped next to the main bundle. */
  bundledCrewDir: string;
  cipher: SecretCipher;
  appInfo: AppInfo;
  /** The llama.cpp builds shipped with the app, one folder per backend. */
  bundledRuntimeDir?: string;
  host?: Host;
  /** Tests swap in their own Hugging Face, builds and hardware probe. */
  models?: Partial<ModelManagerOptions>;
  /** Tests point the cloud providers at stand-ins. */
  cloud?: Pick<ProviderServiceOptions, 'endpoints' | 'fetch'>;
}

export interface Orchestrator {
  paths: AppDataLayout;
  context: OrchestratorContext;
  router: AppRouter;
  /** Settles once the hardware is probed and interrupted pulls have picked up again. */
  ready: Promise<void>;
  close(): void;
}

export function startOrchestrator(options: OrchestratorOptions): Orchestrator {
  const paths = appDataLayout(options.dataDir);
  ensureAppDataLayout(paths);
  const store = openStore({ file: paths.database, migrationsFolder: options.migrationsFolder });
  const settings = new SettingsService(store.db);
  const secrets = new SecretStore(paths.secrets, options.cipher);

  const models = new ModelManager({
    runtimeDir: paths.runtime,
    logsDir: paths.logs,
    defaultModelsDir: paths.models,
    modelsDir: {
      get: () => {
        const dir = settings.readInternal(MODELS_DIR);
        return typeof dir === 'string' ? dir : null;
      },
      set: (dir) => settings.writeInternal(MODELS_DIR, dir),
    },
    ...(options.bundledRuntimeDir ? { bundledRuntimeDir: options.bundledRuntimeDir } : {}),
    repo: sqliteModelRepository(store.db),
    settings: () => settings.get(),
    hfToken: () => (secrets.has(HF_TOKEN) ? secrets.get(HF_TOKEN) : undefined),
    ...options.models,
  });

  const providers = new ProviderRegistry();
  providers.register(
    createBuiltinProvider({
      models: () =>
        models.library().map((m) => ({
          id: m.id,
          title: m.title,
          capabilities: m.capabilities,
          contextLength: m.facts.contextLength,
        })),
      acquire: (id, signal) => models.acquire(id, signal),
    }),
  );

  const providerSettings = new ProviderService({
    db: store.db,
    secrets,
    registry: providers,
    ...options.cloud,
  });

  const crew = new CrewService({
    bundledDir: options.bundledCrewDir,
    editedDir: paths.crew,
    db: store.db,
  });

  const chat = new ChatService({
    store: new ChatStore(store.db),
    crew,
    providers,
    providerInfo: providerSettings,
    settings,
    library: () => models.library(),
  });
  chat.recover();

  const localApi = new LocalApi({
    providers,
    models: {
      library: () => models.library(),
      loaded: () => models.runtime().loaded,
      pull: (ref) => {
        parseModelRef(ref);
        return models.pull(ref);
      },
      pulls: () => models.pulls.list(),
    },
  });
  const { localApiEnabled, localApiPort } = settings.get();
  void localApi.apply(localApiEnabled, localApiPort);

  const context: OrchestratorContext = {
    appInfo: options.appInfo,
    paths,
    store,
    settings,
    secrets,
    models,
    providers,
    providerSettings,
    crew,
    chat,
    localApi,
    host: options.host ?? null,
  };
  const ready = models.start();
  // Callers that don't wait still shouldn't see an unhandled rejection; the UI shows the problem.
  ready.catch((error: unknown) => console.error('The model manager failed to start', error));

  return {
    paths,
    context,
    router: appRouter,
    ready,
    close: () => {
      void localApi.stop();
      chat.close();
      models.close();
      store.close();
    },
  };
}
