import {
  type PackageKind,
  integrationIdSchema,
  licenceSchema,
  packageIdSchema,
  packageKindSchema,
  versionSchema,
} from '@clanks/core';
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** A marketplace problem worded for the user. */
export class MarketplaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MarketplaceError';
  }
}

/** The index format this app reads. An index of a later one is refused rather than half-read. */
export const INDEX_FORMAT = 1;

export const INDEX_FILE = 'index.json';
/** What a marketplace says about itself, at the root of its repository. */
export const MARKETPLACE_FILE = 'marketplace.yaml';
export const PACKAGE_FILE = 'package.yaml';
export const CLANK_FILE = 'clank.md';
export const CREW_FILE = 'crew.yaml';
export const ROUTINE_FILE = 'routine.yaml';
export const TEMPLATE_FILE = 'template.yaml';

/** The most one of a package's files may be. They're prompts and manifests, never binaries. */
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;

/**
 * The files a package of each kind is made of, by their fixed names. Nothing else is ever fetched
 * or written, whatever an index lists.
 */
export const PACKAGE_FILES: Record<PackageKind, readonly string[]> = {
  clank: [PACKAGE_FILE, CLANK_FILE],
  integration: [PACKAGE_FILE, 'manifest.yaml', 'openapi.yaml', 'guide.md'],
  crew: [PACKAGE_FILE, CREW_FILE],
  routine: [PACKAGE_FILE, ROUTINE_FILE],
  template: [PACKAGE_FILE, TEMPLATE_FILE],
};

/** A GitHub account's name, which is who a package is published by. */
const publisherSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'Use a GitHub account name');

/** `package.yaml`: what every package says about itself. */
export const packageMetaSchema = z
  .object({
    kind: packageKindSchema,
    id: packageIdSchema,
    name: z.string().trim().min(1).max(60),
    summary: z.string().trim().min(1).max(240),
    version: versionSchema,
    publisher: publisherSchema,
    licence: licenceSchema,
  })
  .strict();

export type PackageMeta = z.infer<typeof packageMetaSchema>;

/** `crew.yaml`: the clanks a kind of project wants, and the integrations they expect. */
export const crewFileSchema = z
  .object({
    /** Clanks by id: ones that ship with the app, or clank packages in the same marketplace. */
    clanks: z.array(packageIdSchema).min(1).max(20),
    integrations: z.array(integrationIdSchema).max(20).default([]),
  })
  .strict();

export type CrewFile = z.infer<typeof crewFileSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const indexFileSchema = z
  .object({
    path: z.string().regex(/^[a-z][a-z0-9_.-]{0,40}$/),
    sha256: sha256Schema,
    size: z.number().int().min(0).max(MAX_FILE_BYTES),
  })
  .strict();

const indexVersionSchema = z
  .object({
    version: versionSchema,
    /** The digest of the whole version: its files' own digests, by name. */
    sha256: sha256Schema,
    files: z.array(indexFileSchema).min(1).max(8),
  })
  .strict();

export type IndexVersion = z.infer<typeof indexVersionSchema>;

const indexPackageSchema = z
  .object({
    kind: packageKindSchema,
    id: packageIdSchema,
    name: z.string().trim().min(1).max(60),
    summary: z.string().trim().min(1).max(240),
    publisher: publisherSchema,
    licence: licenceSchema,
    /** A maintainer has read it. */
    reviewed: z.boolean().default(false),
    /** Why it was taken down. Installed copies are turned off, with this as the notice. */
    revoked: z.string().trim().max(500).nullable().default(null),
    /** An integration that runs an MCP server's code on the user's computer. */
    runsCode: z.boolean().default(false),
    /** Oldest first. */
    versions: z.array(indexVersionSchema).min(1).max(200),
  })
  .strict();

export type IndexPackage = z.infer<typeof indexPackageSchema>;

export const indexSchema = z
  .object({
    format: z.literal(INDEX_FORMAT),
    name: z.string().trim().min(1).max(80),
    /** The GitHub repository a pull request publishes to, as `owner/name`. */
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .nullable()
      .default(null),
    generated: z.string().max(40).optional(),
    packages: z.array(indexPackageSchema).max(10_000),
  })
  .strict();

export type MarketplaceIndex = z.infer<typeof indexSchema>;

/** `marketplace.yaml`: a marketplace's name, where it takes pull requests, and its maintainers' calls. */
export const marketplaceFileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .nullable()
      .default(null),
    /** Packages a maintainer has read, as `kind/id`. */
    reviewed: z.array(z.string()).default([]),
    /** Packages taken down, as `kind/id`, each with why. */
    revoked: z.record(z.string(), z.string().trim().min(1).max(500)).default({}),
  })
  .strict();

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * One digest for a whole version: its files' digests, in name order. It changes if any file does,
 * or if one is added or left out.
 */
export function packageDigest(files: { path: string; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.sha256}  ${file.path}\n`);
  return sha256(lines.join(''));
}

/** Where a version's files are in a marketplace, relative to its index. */
export function packagePath(kind: PackageKind, id: string, version: string): string {
  return `packages/${kind}/${id}/${version}`;
}

/** The newest version an index has of a package. */
export function latestVersion(pkg: IndexPackage): IndexVersion {
  return pkg.versions.reduce((latest, version) =>
    compare(version.version, latest.version) > 0 ? version : latest,
  );
}

function compare(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
