import { z } from 'zod';
import type { BoardEvent, NeedsYouItem, SpecVersionInfo, TicketCard, TicketColumn } from './board';
import { type ClankId, clankIdSchema } from './crew';
import { type ModelChoice, modelChoiceSchema } from './providers';

/** Atlas leads every project, so it's always in the crew. */
export const LEAD_CLANK = 'atlas';

/** The crew a new project starts with: what a software project needs. The rest are optional. */
export const DEFAULT_PROJECT_CREW: readonly ClankId[] = [
  'atlas',
  'scribe',
  'prism',
  'forge',
  'gauge',
];

/** The letters a project's ticket keys start with: SURF in SURF-12. */
export const projectKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9]{1,5}$/, 'Use 2 to 6 capital letters or digits, starting with a letter');

export const projectIdSchema = z.uuid();

/** The GitHub repository a project's workspace is a clone of. */
export interface ProjectRepo {
  /** `owner/name`. */
  fullName: string;
  /** `https://github.com/owner/name`. */
  url: string;
  private: boolean;
}

export interface Project {
  id: string;
  name: string;
  /** A line about what's being made. */
  brief: string;
  key: string;
  /** The workspace: a local folder, or the clone of `repo`. Clanks work on copies of it. */
  folder: string;
  repo: ProjectRepo | null;
  /** The model for the whole crew. Null leaves each clank on its own, or the app's crew model. */
  model: ModelChoice | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A clank in a project's crew. */
export interface ProjectMember {
  clankId: ClankId;
  /** Its model in this project. Null runs it on the project's. */
  model: ModelChoice | null;
}

/** A project as the sidebar and Home show it. */
export interface ProjectSummary extends Project {
  /** In roster order, Atlas first. */
  crew: ProjectMember[];
  counts: Record<TicketColumn, number>;
  /** Clanks with a run going now. */
  working: number;
  /** Things on the board waiting on the user. */
  needsYou: number;
}

/** Everything the board shows, sent again whenever it changes. */
export interface BoardSnapshot {
  project: ProjectSummary;
  tickets: TicketCard[];
  specs: SpecVersionInfo[];
  /** The newest last. */
  events: BoardEvent[];
  needsYou: NeedsYouItem[];
}

const folderSchema = z.string().min(1).max(4096);

export const newProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brief: z.string().trim().max(500).default(''),
  key: projectKeySchema,
  workspace: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('folder'), path: folderSchema }),
    z.object({
      kind: z.literal('github'),
      /** `owner/name`. */
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Use owner/name'),
      /** The folder to clone it into, which mustn't exist yet or must be empty. */
      into: folderSchema,
    }),
  ]),
  /** Atlas is added if it's missing. */
  crew: z.array(clankIdSchema).max(50),
  model: modelChoiceSchema.nullable(),
  /** Models for single clanks, by id. */
  models: z.record(clankIdSchema, modelChoiceSchema).default({}),
});

export type NewProject = z.infer<typeof newProjectSchema>;

export const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    brief: z.string().trim().max(500),
    model: modelChoiceSchema.nullable(),
  })
  .partial();

export type ProjectPatch = z.infer<typeof projectPatchSchema>;

/** Ticket key letters from a project's name: "Surf shop" is SURF, "my 2 cents" is MY. */
export function suggestKey(name: string): string {
  const words = name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const first = words[0] ?? '';
  let key =
    first.length >= 2 && /^[A-Z]/.test(first)
      ? first.slice(0, 4)
      : words
          .map((w) => w[0])
          .join('')
          .slice(0, 4);
  if (!/^[A-Z]/.test(key)) key = `P${key}`;
  key = key.replace(/[^A-Z0-9]/g, '').slice(0, 6);
  return key.length >= 2 ? key : 'PRJ';
}

/** A sign-in waiting for the user to enter its code on github.com. */
export interface GitHubDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
}

/** Who's signed in to GitHub, if anyone. */
export interface GitHubStatus {
  signedIn: boolean;
  login: string | null;
  name: string | null;
  /** Signing in with a code on github.com works: the app has an OAuth app to do it with. */
  deviceFlow: boolean;
  /** A code sign-in waiting for the user. */
  device: GitHubDeviceCode | null;
  /** Why the last sign-in didn't work. */
  error: string | null;
}

export interface GitHubRepo {
  /** `owner/name`. */
  fullName: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  pushedAt: Date | null;
}

export const githubTokenSchema = z
  .string()
  .trim()
  .min(20, "That's too short to be a GitHub token")
  .max(500)
  .regex(/^[\w-]+$/, "That doesn't look like a GitHub token");

export const newRepoSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[\w.-]+$/, 'Use letters, digits, ".", "-" and "_"'),
  description: z.string().trim().max(350).default(''),
  private: z.boolean().default(true),
});
