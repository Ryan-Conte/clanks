import { type PackageKind, compareVersions, packageKindSchema } from '@clanks/core';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  INDEX_FORMAT,
  type IndexPackage,
  MARKETPLACE_FILE,
  MAX_FILE_BYTES,
  type MarketplaceIndex,
  MarketplaceError,
  PACKAGE_FILE,
  PACKAGE_FILES,
  type PackageMeta,
  marketplaceFileSchema,
  packageDigest,
  packageMetaSchema,
  sha256,
} from './format';

/** What a kind-specific check says about a package that passed it. */
export interface Checked {
  /** For an integration: it runs an MCP server's code. */
  runsCode?: boolean;
}

export interface BuildOptions {
  /**
   * Checks a package's own files: a clank's doc, an integration's manifest. Throws with what's
   * wrong. The app's own checks go here, so an index only ever lists what the app would install.
   */
  check(meta: PackageMeta, files: Map<string, string>): Checked;
  now?: () => Date;
}

export interface BuildResult {
  index: MarketplaceIndex;
  /** Why each package that was left out was. An index with problems shouldn't be published. */
  problems: string[];
}

/** `package.yaml` as text, checked. */
export function parsePackageMeta(text: string): PackageMeta {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    throw new MarketplaceError(
      `${PACKAGE_FILE} isn't valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = packageMetaSchema.safeParse(data);
  if (!parsed.success) {
    throw new MarketplaceError(`${PACKAGE_FILE} has problems:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** `package.yaml` for a package, as it's written when publishing. */
export function packageYaml(meta: PackageMeta): string {
  return [
    `kind: ${meta.kind}`,
    `id: ${meta.id}`,
    `name: ${JSON.stringify(meta.name)}`,
    `summary: ${JSON.stringify(meta.summary)}`,
    `version: ${meta.version}`,
    `publisher: ${meta.publisher}`,
    `licence: ${meta.licence}`,
    '',
  ].join('\n');
}

/**
 * Builds a marketplace's `index.json` from its folder: `packages/<kind>/<id>/<version>/`, each
 * with a `package.yaml` that agrees with where it is. Run by the marketplace repository's CI on
 * every pull request and every merge.
 */
export function buildIndex(dir: string, options: BuildOptions): BuildResult {
  const problems: string[] = [];
  const about = readMarketplaceFile(dir);
  const packages: IndexPackage[] = [];
  const root = join(dir, 'packages');
  for (const kind of folders(root)) {
    if (!packageKindSchema.safeParse(kind).success) {
      problems.push(`packages/${kind}: there's no such kind of package`);
      continue;
    }
    for (const id of folders(join(root, kind))) {
      const key = `${kind}/${id}`;
      const versions: IndexPackage['versions'] = [];
      let latest: PackageMeta | null = null;
      let runsCode = false;
      for (const version of folders(join(root, kind, id))) {
        const where = `packages/${key}/${version}`;
        try {
          const read = readVersion(join(root, kind, id, version), kind as PackageKind);
          const { meta } = read;
          if (meta.kind !== kind || meta.id !== id || meta.version !== version) {
            throw new MarketplaceError(
              `${PACKAGE_FILE} says ${meta.kind}/${meta.id} ${meta.version}, which isn't where it is`,
            );
          }
          if (latest && meta.publisher !== latest.publisher) {
            throw new MarketplaceError(
              `it's published by ${meta.publisher}, but ${id} belongs to ${latest.publisher}`,
            );
          }
          const checked = options.check(meta, read.text);
          versions.push({ version, sha256: packageDigest(read.files), files: read.files });
          if (!latest || compareVersions(version, latest.version) > 0) {
            latest = meta;
            runsCode = checked.runsCode ?? false;
          }
        } catch (error) {
          problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!latest || versions.length === 0) continue;
      versions.sort((a, b) => compareVersions(a.version, b.version));
      packages.push({
        kind: latest.kind,
        id,
        name: latest.name,
        summary: latest.summary,
        publisher: latest.publisher,
        licence: latest.licence,
        reviewed: about.reviewed.includes(key),
        revoked: about.revoked[key] ?? null,
        runsCode,
        versions,
      });
    }
  }
  packages.sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1));
  return {
    index: {
      format: INDEX_FORMAT,
      name: about.name,
      repo: about.repo,
      generated: (options.now?.() ?? new Date()).toISOString(),
      packages,
    },
    problems,
  };
}

function readMarketplaceFile(dir: string): z.infer<typeof marketplaceFileSchema> {
  const file = join(dir, MARKETPLACE_FILE);
  if (!existsSync(file)) throw new MarketplaceError(`${dir} has no ${MARKETPLACE_FILE}`);
  const parsed = marketplaceFileSchema.safeParse(parseYaml(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new MarketplaceError(
      `${MARKETPLACE_FILE} has problems:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function readVersion(
  dir: string,
  kind: PackageKind,
): {
  meta: PackageMeta;
  files: IndexPackage['versions'][number]['files'];
  text: Map<string, string>;
} {
  const allowed = PACKAGE_FILES[kind];
  const names = readdirSync(dir).sort();
  const stray = names.filter((name) => !allowed.includes(name));
  if (stray.length > 0) {
    throw new MarketplaceError(
      `${stray.join(', ')} ${stray.length === 1 ? "isn't a file" : "aren't files"} a ${kind} is made of (${allowed.join(', ')})`,
    );
  }
  if (!names.includes(PACKAGE_FILE)) throw new MarketplaceError(`it has no ${PACKAGE_FILE}`);
  const files: IndexPackage['versions'][number]['files'] = [];
  const text = new Map<string, string>();
  for (const name of names) {
    const data = readFileSync(join(dir, name));
    if (data.byteLength > MAX_FILE_BYTES) throw new MarketplaceError(`${name} is too big`);
    // A carriage return would make the same file hash differently on Windows and elsewhere.
    if (data.includes(13)) {
      throw new MarketplaceError(`${name} has Windows line endings. Save it with LF ones.`);
    }
    files.push({ path: name, sha256: sha256(data), size: data.byteLength });
    text.set(name, data.toString('utf8'));
  }
  return { meta: parsePackageMeta(text.get(PACKAGE_FILE)!), files, text };
}

function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    .sort();
}
