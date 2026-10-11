import type { BrowserHost } from '@clanks/browser';
import { LEAD_CLANK } from '@clanks/core';
import { ModelManager, type ModelManagerOptions, parseModelRef } from '@clanks/models';
import { BUILTIN_PROVIDER, ProviderRegistry, createBuiltinProvider } from '@clanks/providers';
import { McpManager } from '@clanks/tools';
import { PathError, git, resolveInside } from '@clanks/workspace';
import { ActivityService } from './activity/service';
import { ArtifactService } from './artifacts/service';
import { BoardError, BoardService } from './board/service';
import { BrowserService } from './browser/service';
import { ChatService } from './chat/service';
import { ChatStore } from './chat/store';
import { ContextService } from './context/service';
import { CrewService } from './crew/crew';
import { removeCustomClank } from './crew/remove';
import { DeliveryService } from './delivery/service';
import { DesignError, type DesignHost, DesignService } from './design/service';
import { EmailService, type MailTransport, type SmtpConfig } from './email/service';
import { GitHubService } from './github/service';
import { GitLabService } from './gitlab/service';
import { IntegrationService } from './integrations/service';
import { LocalApi } from './local-api/server';
import { DEFAULT_MARKETPLACE_INDEX, MarketplaceService } from './marketplace/service';
import { McpService } from './mcp/service';
import { ProjectService } from './projects/service';
import { readScheduleWithModel } from './routines/schedule';
import { RoutineService, type RoutineServiceOptions } from './routines/service';
import { SandboxService } from './sandbox/service';
import { TerminalService } from './terminal/service';
import { ToolService } from './tools/service';
import { WorkspaceService } from './workspace/service';
import { type AppDataLayout, appDataLayout, ensureAppDataLayout } from './paths';
import { ProviderService, type ProviderServiceOptions } from './providers';
import { type AppRouter, appRouter } from './router';
import { type SecretCipher, SecretStore } from './secrets';
import { SettingsService } from './settings';
import { ShellService } from './shell';
import { sqliteModelRepository } from './store/models';
import { openStore } from './store/store';
import type { AppInfo, Host, OrchestratorContext } from './trpc';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  /** The integrations that ship with the app, one folder each. Without it, there are none. */
  bundledIntegrationsDir?: string | null;
  /** The marketplace the app starts with, rather than the public one. */
  marketplaceIndex?: string | null;
  /** Tests stand in for the services integrations call, and for the marketplace's host. */
  integrationsFetch?: typeof fetch;
  marketplaceFetch?: typeof fetch;
  cipher: SecretCipher;
  appInfo: AppInfo;
  /** The llama.cpp builds shipped with the app, one folder per backend. */
  bundledRuntimeDir?: string;
  host?: Host;
  /** The browser pane's views and sessions. Without one, clanks get no browser tools. */
  browserHost?: BrowserHost;
  /** Draws designs' frames out of sight. Without one, designs aren't measured or pictured. */
  designHost?: DesignHost;
  /** Tests swap in their own Hugging Face, builds and hardware probe. */
  models?: Partial<ModelManagerOptions>;
  /** Tests point the cloud providers at stand-ins. */
  cloud?: Pick<ProviderServiceOptions, 'endpoints' | 'fetch'>;
  /** The GitHub OAuth app signing in with a code goes through. Without one, users paste a token. */
  githubClientId?: string | null;
  /** Tests point GitHub at a stand-in, and don't wait between polls. */
  githubFetch?: typeof fetch;
  githubSleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Tests point GitLab at a stand-in. */
  gitlabFetch?: typeof fetch;
  /** Tests stand in for the mail server approved emails go out through. */
  mailTransport?: (config: SmtpConfig) => MailTransport;
  /** Tests set the routines' clock, draw their frames and list their tags, and tick by hand. */
  routines?: Partial<Pick<RoutineServiceOptions, 'now' | 'framePng' | 'tags' | 'readSchedule'>> & {
    /** False leaves the scheduler's timers off, for a test that ticks itself. */
    start?: boolean;
  };
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

  const github = new GitHubService({
    secrets,
    store: {
      read: (key) => settings.readInternal(key as `${string}.${string}`),
      write: (key, value) => settings.writeInternal(key as `${string}.${string}`, value),
    },
    clientId: options.githubClientId ?? null,
    ...(options.githubFetch ? { fetch: options.githubFetch } : {}),
    ...(options.githubSleep ? { sleep: options.githubSleep } : {}),
  });
  const gitlab = new GitLabService({
    secrets,
    store: {
      read: (key) => settings.readInternal(key as `${string}.${string}`),
      write: (key, value) => settings.writeInternal(key as `${string}.${string}`, value),
    },
    ...(options.gitlabFetch ? { fetch: options.gitlabFetch } : {}),
  });
  const hosts = (host: 'github' | 'gitlab') => (host === 'gitlab' ? gitlab : github);
  const projects = new ProjectService({ db: store.db, crew, hosts });
  const artifacts = new ArtifactService({ db: store.db, dir: paths.artifacts });
  const email = new EmailService({
    settings,
    secrets,
    ...(options.mailTransport ? { transport: options.mailTransport } : {}),
  });
  const contextNotes = new ContextService({ db: store.db });
  const mcpManager = new McpManager({ name: 'clanks', version: options.appInfo.version });
  const mcp = new McpService({ db: store.db, secrets, manager: mcpManager });
  const sandbox = new SandboxService();
  const integrations = new IntegrationService({
    db: store.db,
    secrets,
    bundledDir: options.bundledIntegrationsDir ?? null,
    installedDir: paths.integrations,
    mcp,
    onProjectChange: (projectId) => {
      if (projects.find(projectId)) projects.touch(projectId);
    },
    docker: () => sandbox.docker(),
    ...(options.host ? { openUrl: (url: string) => options.host!.openUrl(url) } : {}),
    ...(options.integrationsFetch ? { fetch: options.integrationsFetch } : {}),
  });

  const chatStore = new ChatStore(store.db);
  const activity = new ActivityService(store.db);
  const workspace: WorkspaceService = new WorkspaceService({
    db: store.db,
    worktreesDir: paths.worktrees,
    checkpointsDir: paths.checkpoints,
    conversations: {
      get: (id) => chatStore.conversation(id),
      lastMessageId: (id) => chatStore.lastMessage(id)?.id ?? null,
    },
    workName: (id) => {
      const conversation = chatStore.conversation(id);
      return conversation ? board.workName(conversation) : null;
    },
    workBase: (id) => {
      const conversation = chatStore.conversation(id);
      return conversation ? board.workBase(conversation) : Promise.resolve(null);
    },
  });
  const delivery: DeliveryService = new DeliveryService({
    hosts,
    workspace,
    scratchDir: join(paths.worktrees, '_merges'),
  });
  // The user's edits in Studio come in bursts: one checkpoint a burst is plenty.
  const designTimers = new Map<string, NodeJS.Timeout>();
  const design = new DesignService({
    host: options.designHost ?? null,
    userName: () => settings.get().profile.name || 'The user',
    userEdited: (conversationId, file, lines) => {
      workspace.noteDesign(conversationId, file, lines);
      clearTimeout(designTimers.get(conversationId));
      const timer = setTimeout(() => {
        designTimers.delete(conversationId);
        void workspace
          .checkpoint(conversationId, { author: 'user', label: 'You edited the design' })
          // Work the user changed after it was handed in goes on its branch, to be merged with it.
          .then(() => board.absorb(conversationId))
          .catch((error: unknown) => console.error('Recording a design edit failed', error));
      }, 1200);
      timer.unref();
      designTimers.set(conversationId, timer);
    },
  });
  const board: BoardService = new BoardService({
    db: store.db,
    projects,
    crew,
    context: contextNotes,
    delivery,
    artifacts,
    email,
    integrations,
    userName: () => settings.get().profile.name || 'the user',
    prices: () => settings.get().cloudPrices,
    // eslint-disable-next-line @typescript-eslint/require-await -- a bad path rejects
    writeDocument: async (conversationId, path, text) => {
      const run = workspace.run(conversationId);
      if (!run) {
        throw new BoardError(
          "This run has no workspace, so the document can't go into the project. Leave `path` out.",
        );
      }
      try {
        const file = resolveInside(run.worktree, run.cwd, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
      } catch (error) {
        if (error instanceof PathError) throw new BoardError(error.message);
        throw error;
      }
    },
    designCheck: async (conversationId, file) => {
      const run = workspace.run(conversationId);
      if (!run) throw new BoardError("This run has no workspace, so there's no design to hand in.");
      try {
        return await design.check(run.cwd, file);
      } catch (error) {
        if (error instanceof DesignError) throw new BoardError(error.message);
        throw error;
      }
    },
    capacity: {
      slots: (choice) =>
        choice.provider === BUILTIN_PROVIDER ? models.slotsFor(choice.model) : null,
      wouldWait: (choice) => choice.provider === BUILTIN_PROVIDER && models.wouldWait(choice.model),
      state: (choice) =>
        choice.provider === BUILTIN_PROVIDER
          ? (models.runtime().loaded.find((l) => l.modelId === choice.model)?.state ?? null)
          : null,
    },
  });
  const terminal = new TerminalService();
  const tools = new ToolService({
    db: store.db,
    crew,
    mcp,
    manager: mcpManager,
    settings,
    secrets,
    integrations,
  });

  const browser = new BrowserService({
    host: options.browserHost ?? null,
    settings: (clankId) => crew.get(clankId).overrides.browser,
    userName: () => settings.get().profile.name || 'The user',
  });

  const chat = new ChatService({
    store: chatStore,
    crew,
    providers,
    providerInfo: providerSettings,
    settings,
    library: () => models.library(),
    vision: (choice) => {
      try {
        return providers.get(choice.provider).capabilities(choice.model).vision;
      } catch {
        return false;
      }
    },
    workspace,
    terminal,
    activity,
    tools,
    browser,
    design,
    sandbox,
    board,
    artifactsDir: paths.artifacts,
    artifacts,
    routines: {
      access: (projectId, clankId, conversationId) =>
        routines.access(projectId, clankId, conversationId),
    },
  });
  board.attach({
    createRun: (input) => chat.createRun(input),
    post: (id, text) => chat.post(id, text),
    delete: (id) => chat.delete(id),
    stop: (id) => chat.halt(id),
    release: async (id) => {
      terminal.closeConversation(id);
      await sandbox.remove(id);
      await workspace.remove(id);
    },
    inFlight: (id) => chat.inFlight(id),
    replying: (id) => chat.replying(id),
    active: () => chat.active(),
    conversation: (id) => chatStore.conversation(id),
    inProject: (id) => chatStore.inProject(id),
    forTicket: (id) => chatStore.forTicket(id),
    modelFor: (clankId, projectId) => chat.modelFor(clankId, projectId),
    recap: (id) => chat.recap(id),
    consult: (input) => chat.consult(input),
    pictures: (id) => chat.pictures(id),
  });
  // A run's tool calls show on its ticket's card as they happen.
  chat.on('live', (id, event) => {
    if (event.type !== 'delta') board.touchConversation(id);
  });
  const marketplace = new MarketplaceService({
    db: store.db,
    settings,
    crew,
    integrations,
    github,
    defaultIndex: options.marketplaceIndex || DEFAULT_MARKETPLACE_INDEX,
    removeClank: (id) => removeCustomClank({ crew, projects, chat }, id),
    userName: () => settings.get().profile.name,
    ...(options.marketplaceFetch ? { fetch: options.marketplaceFetch } : {}),
  });
  // What's installed is checked against its marketplace now and then: for a newer version to
  // offer, or a notice that it was taken down. With nothing installed, nothing is fetched.
  const checkPackages = () => {
    if (marketplace.snapshot().installed.length === 0) return;
    void marketplace.refresh().catch(() => {});
  };
  const packagesSoon = setTimeout(checkPackages, 20_000);
  packagesSoon.unref();
  const packagesTimer = setInterval(checkPackages, 6 * 60 * 60_000);
  packagesTimer.unref();
  const routines: RoutineService = new RoutineService({
    db: store.db,
    projects,
    crew,
    board,
    integrations,
    context: contextNotes,
    settings,
    artifactsDir: paths.artifacts,
    // A frame as it will be sent, at its own size: from the design its ticket's maker handed in,
    // then the project's own, then whatever else the crew is designing.
    framePng: async (projectId, frame, ticket) => {
      const project = projects.find(projectId);
      if (!project) return null;
      const tickets = board.tickets(projectId);
      const runs = chatStore
        .inProject(projectId)
        .filter((c) => c.role === 'maker')
        .filter((c) => tickets.find((t) => t.id === c.ticketId)?.type === 'design')
        .sort((a, b) => +b.updatedAt - +a.updatedAt);
      const dirs = [
        ...runs
          .filter((c) => c.ticketId === ticket?.id)
          .flatMap((c) => workspace.run(c.id)?.cwd ?? []),
        project.folder,
        ...runs.flatMap((c) => workspace.run(c.id)?.cwd ?? []),
      ];
      for (const dir of new Set(dirs)) {
        const found = await design.framePicture(dir, frame).catch(() => null);
        if (!found) continue;
        const exported = await design
          .exportFrame(dir, { file: found.file, frame, format: 'png' })
          .catch(() => null);
        return exported?.data ?? found.png;
      }
      return null;
    },
    tags: async (folder) =>
      (await git(['tag', '--list'], { cwd: folder }))
        .split(/\r?\n/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    // Async, so having no model to ask is a rejection rather than a throw.
    readSchedule: async (words, zone, now) =>
      readScheduleWithModel(
        providers,
        chat.modelFor(LEAD_CLANK),
        { words, zone, now },
        AbortSignal.timeout(90_000),
      ),
    templates: () => marketplace.routineTemplates(),
    ...options.routines,
  });
  chat.recover();
  board.recover();
  // Models loading, unloading and freeing up may let waiting runs start; so may a crew model.
  let pumpTimer: NodeJS.Timeout | null = null;
  const pumpSoon = () => {
    if (pumpTimer) return;
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      board.pumpAll();
    }, 1000);
    pumpTimer.unref();
  };
  models.on('change', pumpSoon);
  settings.on('change', pumpSoon);
  board.pumpAll();
  // Pull requests' checks, and any merged on GitHub, every few minutes.
  const prTimer = setInterval(() => void board.refreshPullRequests(), 3 * 60_000);
  prTimer.unref();

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
    workspace,
    terminal,
    activity,
    tools,
    mcp,
    browser,
    projects,
    board,
    context: contextNotes,
    design,
    sandbox,
    github,
    gitlab,
    artifacts,
    email,
    integrations,
    marketplace,
    routines,
    localApi,
    shell: new ShellService(),
    host: options.host ?? null,
  };
  if (options.routines?.start !== false) routines.start();
  const ready = models.start();
  // Callers that don't wait still shouldn't see an unhandled rejection; the UI shows the problem.
  ready.catch((error: unknown) => console.error('The model manager failed to start', error));

  return {
    paths,
    context,
    router: appRouter,
    ready,
    close: () => {
      clearInterval(prTimer);
      clearTimeout(packagesSoon);
      clearInterval(packagesTimer);
      routines.close();
      integrations.close();
      if (pumpTimer) clearTimeout(pumpTimer);
      for (const timer of designTimers.values()) clearTimeout(timer);
      void localApi.stop();
      github.cancelDeviceFlow();
      chat.close();
      sandbox.closeAll();
      browser.closeAll();
      terminal.closeAll();
      void mcpManager.closeAll();
      models.close();
      store.close();
    },
  };
}
