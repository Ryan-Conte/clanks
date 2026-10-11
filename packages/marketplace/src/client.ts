import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  INDEX_FILE,
  INDEX_FORMAT,
  type IndexPackage,
  MAX_FILE_BYTES,
  MAX_INDEX_BYTES,
  type MarketplaceIndex,
  MarketplaceError,
  PACKAGE_FILES,
  indexSchema,
  packageDigest,
  packagePath,
  sha256,
} from './format';

export interface FetchOptions {
  fetch: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Where a marketplace is: an https address of its `index.json`, or a folder (or an index file) on
 * this computer, for a team's own on a shared drive.
 */
type Location = { kind: 'web'; index: URL } | { kind: 'disk'; index: string; root: string };

function locate(url: string): Location {
  if (/^https:\/\//i.test(url)) {
    const index = new URL(url);
    if (index.username || index.password) {
      throw new MarketplaceError("A marketplace's address can't have a login in it");
    }
    return { kind: 'web', index };
  }
  let path = url;
  if (/^file:\/\//i.test(url)) {
    try {
      path = fileURLToPath(url);
    } catch {
      throw new MarketplaceError(`${url} isn't a file address`);
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    throw new MarketplaceError('A marketplace is at an https:// address, or in a folder');
  }
  const isFolder = existsSync(path) && statSync(path).isDirectory();
  return isFolder
    ? { kind: 'disk', index: join(path, INDEX_FILE), root: path }
    : { kind: 'disk', index: path, root: join(path, '..') };
}

async function read(
  location: Location,
  relative: string | null,
  limit: number,
  options: FetchOptions,
): Promise<Uint8Array> {
  if (location.kind === 'disk') {
    const file = relative === null ? location.index : join(location.root, ...relative.split('/'));
    if (!existsSync(file)) throw new MarketplaceError(`${file} isn't there`);
    if (statSync(file).size > limit) throw new MarketplaceError(`${file} is too big to be read`);
    return readFileSync(file);
  }
  const url = relative === null ? location.index : new URL(relative, location.index);
  // Files sit beside the index; nothing an index says can send a request anywhere else.
  if (url.origin !== location.index.origin) {
    throw new MarketplaceError(`${url.host} isn't where this marketplace is`);
  }
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'clanks' },
      redirect: 'error',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new MarketplaceError(
      `Couldn't reach ${url.host}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new MarketplaceError(
      response.status === 404
        ? `${url.host} has nothing at ${url.pathname}`
        : `${url.host} answered ${response.status}`,
    );
  }
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > limit) throw new MarketplaceError(`${url.pathname} is too big to be read`);
  return data;
}

/** Reads a marketplace's index. Everything in it is someone else's word, so all of it is checked. */
export async function fetchIndex(url: string, options: FetchOptions): Promise<MarketplaceIndex> {
  const text = Buffer.from(await read(locate(url), null, MAX_INDEX_BYTES, options)).toString(
    'utf8',
  );
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MarketplaceError("What's there isn't a marketplace index: it isn't JSON");
  }
  const format = (data as { format?: unknown } | null)?.format;
  if (typeof format === 'number' && format > INDEX_FORMAT) {
    throw new MarketplaceError(
      'This marketplace is in a newer format than this version of clanks reads. Update clanks.',
    );
  }
  const parsed = indexSchema.safeParse(data);
  if (!parsed.success) {
    throw new MarketplaceError(
      `What's there isn't a marketplace index:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** A version's files, each checked against the index before anything is done with it. */
export interface VerifiedPackage {
  version: string;
  sha256: string;
  /** By name. Text, since a package is prompts and manifests. */
  files: Map<string, string>;
}

/**
 * Fetches one version of a package and checks every file against the digests its index gives.
 * A file that doesn't match is never returned, so nothing unverified can be previewed or installed.
 */
export async function fetchPackage(
  indexUrl: string,
  pkg: IndexPackage,
  version: string,
  options: FetchOptions,
): Promise<VerifiedPackage> {
  const entry = pkg.versions.find((v) => v.version === version);
  if (!entry) throw new MarketplaceError(`${pkg.name} has no version ${version}`);
  const allowed = PACKAGE_FILES[pkg.kind];
  const location = locate(indexUrl);
  const files = new Map<string, string>();
  for (const file of entry.files) {
    if (!allowed.includes(file.path)) {
      throw new MarketplaceError(
        `${pkg.name} lists ${file.path}, which isn't a file a ${pkg.kind} is made of`,
      );
    }
    const data = await read(
      location,
      `${packagePath(pkg.kind, pkg.id, version)}/${file.path}`,
      MAX_FILE_BYTES,
      options,
    );
    if (sha256(data) !== file.sha256) {
      throw new MarketplaceError(
        `${pkg.name} ${version}: ${file.path} doesn't match its checksum, so it wasn't used. It may have been changed after it was published.`,
      );
    }
    files.set(file.path, Buffer.from(data).toString('utf8'));
  }
  if (packageDigest(entry.files) !== entry.sha256) {
    throw new MarketplaceError(
      `${pkg.name} ${version} doesn't match its checksum, so it wasn't used.`,
    );
  }
  return { version, sha256: entry.sha256, files };
}
