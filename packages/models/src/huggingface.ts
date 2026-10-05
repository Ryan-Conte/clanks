import { z } from 'zod';
import { describe } from './download';
import { ModelsError } from './errors';
import type { RepoFile } from './refs';

export const HUGGING_FACE = 'https://huggingface.co';

export class HuggingFaceError extends ModelsError {}

const repoInfoSchema = z.object({
  sha: z.string(),
  gated: z.union([z.boolean(), z.string()]).optional(),
  cardData: z.object({ license: z.string().optional() }).loose().optional(),
});

const treeSchema = z.array(
  z.object({
    type: z.string(),
    path: z.string(),
    size: z.number(),
    lfs: z.object({ oid: z.string(), size: z.number() }).optional(),
  }),
);

export interface RepoInfo {
  /** The commit everything is read at, so the files can't change between checks and download. */
  revision: string;
  license: string | null;
  gated: boolean;
}

export interface HuggingFaceOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  /** A token for gated or private repos, from the keychain. Sent to Hugging Face only. */
  token?: () => string | undefined;
}

/** Just enough of the Hugging Face Hub API to find a repo's GGUF files and their checksums. */
export class HuggingFaceClient {
  readonly endpoint: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: HuggingFaceOptions = {}) {
    this.endpoint = (options.endpoint ?? HUGGING_FACE).replace(/\/$/, '');
    this.doFetch = options.fetch ?? fetch;
  }

  headers(): Record<string, string> {
    const token = this.options.token?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async repoInfo(repo: string, signal?: AbortSignal): Promise<RepoInfo> {
    const info = repoInfoSchema.parse(await this.get(`/api/models/${repo}`, repo, signal));
    return {
      revision: info.sha,
      license: info.cardData?.license ?? null,
      gated: info.gated !== undefined && info.gated !== false,
    };
  }

  async listFiles(repo: string, revision: string, signal?: AbortSignal): Promise<RepoFile[]> {
    const tree = treeSchema.parse(
      await this.get(`/api/models/${repo}/tree/${revision}?recursive=true`, repo, signal),
    );
    return tree
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.lfs?.oid ?? null }));
  }

  fileUrl(repo: string, revision: string, path: string): string {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `${this.endpoint}/${repo}/resolve/${revision}/${encoded}`;
  }

  private async get(path: string, repo: string, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.endpoint}${path}`, { headers: this.headers(), signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new HuggingFaceError(`Couldn't reach Hugging Face: ${describe(error)}`, {
        cause: error,
      });
    }
    if (response.ok) return response.json();
    // Hugging Face answers 401 for a repo that doesn't exist too, so as not to reveal private ones.
    if (response.status === 401 || response.status === 403) {
      throw new HuggingFaceError(
        `Couldn't open ${repo}: it doesn't exist, or it's private or gated. For a gated model, ` +
          'accept its licence on huggingface.co and add a Hugging Face token in Settings.',
      );
    }
    if (response.status === 404) throw new HuggingFaceError(`There's no ${repo} on Hugging Face.`);
    throw new HuggingFaceError(`Hugging Face answered HTTP ${response.status} for ${repo}.`);
  }
}
