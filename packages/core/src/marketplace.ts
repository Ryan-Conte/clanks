import { z } from 'zod';
import type { IntegrationOperationInfo, OperationRisk } from './integrations';
import type { ToolPolicyLevel } from './tools';

/**
 * What a marketplace holds: clanks, integrations, crews, routines to start from, and project
 * templates.
 */
export const packageKindSchema = z.enum(['clank', 'integration', 'crew', 'routine', 'template']);

export type PackageKind = z.infer<typeof packageKindSchema>;

export const PACKAGE_KIND_NAMES: Record<PackageKind, string> = {
  clank: 'Clank',
  integration: 'Integration',
  crew: 'Crew',
  routine: 'Routine',
  template: 'Template',
};

/** The open licences a package can be published under. */
export const OPEN_LICENCES = ['MIT', 'Apache-2.0', 'CC-BY-4.0', 'CC0-1.0'] as const;

export const licenceSchema = z.enum(OPEN_LICENCES);

export type Licence = z.infer<typeof licenceSchema>;

/** `1.2.3`: three numbers, nothing after them. */
export const versionSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/, 'Use a version such as 1.0.0');

/** Below zero when `a` is older than `b`, above when newer. */
export function compareVersions(a: string, b: string): number {
  const [x = [], y = []] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The version after `version`, for a package's next release. */
export function nextVersion(version: string, part: 'major' | 'minor' | 'patch' = 'patch'): string {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** A package's id within its kind: a clank's id, an integration's, or a crew's name in kebab case. */
export const packageIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Use lowercase letters, digits, "-" and "_"');

/** A marketplace's address: an https URL of its `index.json`, or a folder or file on this computer. */
export const indexUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine(
    (url) => /^https:\/\/\S+$/i.test(url) || /^file:\/\/\S+$/i.test(url) || isLocalPath(url),
    'Use an https:// address, or a folder on this computer',
  );

function isLocalPath(url: string): boolean {
  return /^([A-Za-z]:[\\/]|\/|\\\\|~[\\/])/.test(url);
}

/** A marketplace as Settings lists it. */
export interface MarketplaceIndexInfo {
  url: string;
  /** What it calls itself, once it has been read. */
  name: string;
  /** The one that ships with the app, which can't be removed. */
  builtin: boolean;
  /** The GitHub repository publishing opens a pull request to, if it takes them. */
  repo: string | null;
  packages: number;
  fetchedAt: Date | null;
  /** Why it couldn't be read last time. */
  error: string | null;
}

/** What's installed of a package. */
export interface InstalledPackage {
  kind: PackageKind;
  id: string;
  name: string;
  version: string;
  /** The index it came from. */
  index: string;
  publisher: string;
  licence: string;
  sha256: string;
  /** The user chose to stay on this version: newer ones aren't offered. */
  pinned: boolean;
  status: 'active' | 'update_available' | 'revoked';
  /** The newest version its index has. */
  latest: string | null;
  /** Why it was revoked, as its index says. */
  notice: string | null;
  installedAt: Date;
}

/** A package in a marketplace's index. */
export interface MarketplaceEntry {
  index: string;
  indexName: string;
  kind: PackageKind;
  id: string;
  name: string;
  summary: string;
  publisher: string;
  licence: string;
  /** A maintainer of the index has read it. */
  reviewed: boolean;
  /** Why it was taken down. Null when it's fine. */
  revoked: string | null;
  latest: string;
  versions: string[];
  /** For an integration: it runs a server's code on this computer. */
  runsCode: boolean;
  installed: InstalledPackage | null;
  /** It ships with the app, so it's there without installing. */
  builtin: boolean;
}

/** A tool a clank's doc gives it, and how it starts on this machine. */
export interface PreviewTool {
  name: string;
  /** What the doc says. */
  asks: ToolPolicyLevel;
  /** What applies once installed: nothing above read starts higher than ask. */
  starts: ToolPolicyLevel;
}

export interface ClankPreview {
  id: string;
  name: string;
  role: string;
  summary: string;
  kind: 'maker' | 'checker';
  stage: string;
  after: string | null;
  appliesTo: string[];
  outputs: string[];
  bounceTo: string[];
  /** The whole priming doc, frontmatter and all. */
  doc: string;
  /** The prompt with the crew rules, in tokens. */
  tokens: number;
  tools: PreviewTool[];
  integrations: string[];
  needs: string[];
  minContext: number;
}

export interface IntegrationPreview {
  id: string;
  name: string;
  summary: string;
  kind: 'declarative' | 'mcp';
  hosts: string[];
  auth: string;
  operations: IntegrationOperationInfo[];
  guide: string;
  /** For an MCP server: the command that will run on this computer. */
  command: string | null;
  /** The manifest as written, for reading and for the diff on an update. */
  manifest: string;
}

export interface CrewPreview {
  /** Clanks that ship with the app, by id. */
  premade: string[];
  /** Clanks installed with it, each in full. */
  clanks: ClankPreview[];
  integrations: IntegrationPreview[];
  /** Packages it names that its index doesn't have. */
  missing: string[];
}

/** A routine template: what it would schedule, once the user fills it in and turns it on. */
export interface RoutinePreview {
  name: string;
  /** What starts it, in words. */
  trigger: string;
  /** Each step in a line: who makes what, and what goes out when. */
  steps: string[];
  /** The clanks its ticket steps are for. */
  clanks: string[];
  /** The integrations its actions call. */
  integrations: string[];
  /** The routine as written. */
  yaml: string;
}

/** A project template: the crew it wants and what it has the crew do first. */
export interface TemplatePreview {
  crew: string[];
  /** Clanks it names that aren't in the library. */
  missing: string[];
  ask: string;
  /** What Atlas is told when a project is made from it. */
  kickoff: string;
  /** Tickets it puts on the board straight away, each in a line. */
  tickets: string[];
  /** The template as written. */
  yaml: string;
}

/** What an update changes that the user should look at before accepting it. */
export interface UpdateChanges {
  from: string;
  /**
   * Every file that differs, as it is now and as it would be, for the diff. Empty when the
   * version is the same as what's there.
   */
  files: { name: string; before: string; after: string }[];
  /** Tools the new version lists that the old one didn't. */
  newTools: string[];
  /** Tools the new version's doc asks for more of than the old one's. */
  raisedTools: string[];
  newHosts: string[];
  newOperations: string[];
  /** Operations whose risk the new version rates lower than the old one did. */
  loweredRisks: { operation: string; from: OperationRisk; to: OperationRisk }[];
}

/** Everything about a package version, read and checked before anything is installed. */
export interface PackagePreview {
  entry: MarketplaceEntry;
  version: string;
  /** The digest its files were checked against. Installing asks for exactly this. */
  sha256: string;
  clank: ClankPreview | null;
  integration: IntegrationPreview | null;
  crew: CrewPreview | null;
  routine: RoutinePreview | null;
  template: TemplatePreview | null;
  /** Why it can't be installed as it is. */
  problems: string[];
  /** Set when a version is already installed. */
  changes: UpdateChanges | null;
}

/** What publishing would send, and what stands in the way. */
export interface PublishPreview {
  kind: PackageKind;
  id: string;
  name: string;
  summary: string;
  /** The version it would be published as. */
  version: string;
  /** The newest version the index already has, by anyone. */
  published: string | null;
  /** The repository the pull request goes to. Null when no index takes them. */
  repo: string | null;
  /** The GitHub account it would come from. Null when not signed in. */
  publisher: string | null;
  /** The files in the pull request, as they'd be written. */
  files: { path: string; text: string }[];
  /** What has to be fixed first. */
  problems: string[];
  /** Worth a look, but publishing can go ahead. */
  warnings: string[];
}

export const publishInputSchema = z.object({
  kind: z.enum(['clank', 'integration']),
  id: packageIdSchema,
  version: versionSchema,
  licence: licenceSchema,
});

export type PublishInput = z.infer<typeof publishInputSchema>;

export interface PublishResult {
  url: string;
  number: number;
  repo: string;
}

export interface MarketplaceSnapshot {
  indexes: MarketplaceIndexInfo[];
  entries: MarketplaceEntry[];
  installed: InstalledPackage[];
  /** The indexes are being read right now. */
  refreshing: boolean;
}
