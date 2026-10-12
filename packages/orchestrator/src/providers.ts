import {
  CLOUD_PROVIDERS,
  type CloudProviderId,
  type ModelChoice,
  type ProviderModel,
  type ProviderStatus,
  type ServerInput,
  serverInputSchema,
} from '@clanks/core';
import {
  BUILTIN_PROVIDER,
  type Provider,
  ProviderError,
  type ProviderRegistry,
  createAnthropicProvider,
  createGoogleProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
  createServerProvider,
} from '@clanks/providers';
import { eq } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import type { SecretStore } from './secrets';
import { provider as providerTable } from './store/schema';
import type { Db } from './store/store';

export const CLOUD_NAMES: Record<CloudProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
};

const CLOUD_URLS: Record<CloudProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** The keychain entry for a provider's API key. */
export function providerSecret(id: string): string {
  return `provider:${id}`;
}

export interface ProviderServiceOptions {
  db: Db;
  secrets: SecretStore;
  registry: ProviderRegistry;
  /** Tests point the cloud providers at stand-ins. */
  endpoints?: Partial<Record<CloudProviderId, string>>;
  fetch?: typeof fetch;
}

/**
 * The optional providers: cloud models with the user's own keys, and model servers the user runs
 * elsewhere. Keys stay in the keychain and are read only when a request needs one.
 */
export class ProviderService extends EventEmitter<{ change: [] }> {
  constructor(private readonly options: ProviderServiceOptions) {
    super();
    for (const id of CLOUD_PROVIDERS) options.registry.register(this.createCloud(id));
    for (const row of this.servers()) options.registry.register(this.createServer(row));
  }

  list(): ProviderStatus[] {
    const { secrets } = this.options;
    return [
      {
        id: BUILTIN_PROVIDER,
        kind: 'builtin',
        name: 'This machine',
        baseUrl: null,
        hasKey: false,
        configured: true,
      },
      ...CLOUD_PROVIDERS.map((id) => {
        const hasKey = secrets.has(providerSecret(id));
        return {
          id,
          kind: id,
          name: CLOUD_NAMES[id],
          baseUrl: CLOUD_URLS[id],
          hasKey,
          configured: hasKey,
        } satisfies ProviderStatus;
      }),
      ...this.servers().map(
        (row) =>
          ({
            id: row.id,
            kind: 'server',
            name: row.name,
            baseUrl: row.baseUrl,
            hasKey: row.secretRef !== null && secrets.has(row.secretRef),
            configured: true,
          }) satisfies ProviderStatus,
      ),
    ];
  }

  /** Whether a model choice can be used: its provider exists and, if it needs a key, has one. */
  isConfigured(provider: string): boolean {
    return this.list().some((p) => p.id === provider && p.configured);
  }

  name(provider: string): string {
    return this.list().find((p) => p.id === provider)?.name ?? provider;
  }

  setKey(id: CloudProviderId, key: string): void {
    this.options.secrets.set(providerSecret(id), key.trim());
    this.emit('change');
  }

  removeKey(id: CloudProviderId): void {
    this.options.secrets.delete(providerSecret(id));
    this.emit('change');
  }

  /** Adds a model server once it answers like one, so a typo in the address shows up now. */
  async addServer(input: ServerInput, signal?: AbortSignal): Promise<ProviderStatus> {
    const values = serverInputSchema.parse(input);
    const id = this.uniqueId(values.name);
    const baseUrl = values.baseUrl.replace(/\/+$/, '');
    const probe = createServerProvider({
      id,
      name: values.name,
      baseUrl,
      apiKey: () => values.apiKey || undefined,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    await probe.listModels(signal);

    const secretRef = values.apiKey ? providerSecret(id) : null;
    if (secretRef) this.options.secrets.set(secretRef, values.apiKey!);
    const row = {
      id,
      kind: 'openai_compatible' as const,
      name: values.name,
      baseUrl,
      secretRef,
      createdAt: new Date(),
    };
    this.options.db.insert(providerTable).values(row).run();
    this.options.registry.register(this.createServer(row));
    this.emit('change');
    return this.list().find((p) => p.id === id)!;
  }

  removeServer(id: string): void {
    const row = this.servers().find((s) => s.id === id);
    if (!row) throw new ProviderError(`There's no model server ${id}`);
    this.options.db.delete(providerTable).where(eq(providerTable.id, id)).run();
    if (row.secretRef) this.options.secrets.delete(row.secretRef);
    this.options.registry.unregister(id);
    this.emit('change');
  }

  /** The models a provider offers. Cloud lists are fetched with the key and kept a few minutes. */
  async models(id: string, signal?: AbortSignal): Promise<ProviderModel[]> {
    const models = await this.options.registry.get(id).listModels(signal);
    return models.map((m) => ({
      id: m.id,
      title: m.title,
      contextWindow: m.contextWindow > 0 ? m.contextWindow : null,
    }));
  }

  /** How much a model can take in, from its provider's last listing. Zero if unknown. */
  contextWindow(choice: ModelChoice): number {
    if (!this.options.registry.has(choice.provider)) return 0;
    return this.options.registry.get(choice.provider).capabilities(choice.model).contextWindow;
  }

  private servers() {
    return this.options.db.select().from(providerTable).all();
  }

  private uniqueId(name: string): string {
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30) || 'server';
    const taken = new Set(this.servers().map((s) => s.id));
    let id = `server-${slug}`;
    for (let n = 2; taken.has(id); n++) id = `server-${slug}-${n}`;
    return id;
  }

  private createCloud(id: CloudProviderId): Provider {
    const apiKey = () => this.readKey(providerSecret(id));
    const baseUrl = this.options.endpoints?.[id];
    const fetchOption = this.options.fetch ? { fetch: this.options.fetch } : {};
    switch (id) {
      case 'anthropic':
        return createAnthropicProvider({
          apiKey,
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...fetchOption,
        });
      case 'openai':
        return createOpenAIProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...fetchOption });
      case 'google':
        return createGoogleProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...fetchOption });
      case 'openrouter':
        return createOpenRouterProvider({
          apiKey,
          ...(baseUrl ? { baseUrl } : {}),
          ...fetchOption,
        });
    }
  }

  private createServer(row: {
    id: string;
    name: string;
    baseUrl: string;
    secretRef: string | null;
  }) {
    return createServerProvider({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      apiKey: () => (row.secretRef ? this.readKey(row.secretRef) : undefined),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }

  /** A key, or nothing if it's missing or the keychain can't be read. */
  private readKey(ref: string): string | undefined {
    try {
      return this.options.secrets.get(ref);
    } catch {
      return undefined;
    }
  }
}
