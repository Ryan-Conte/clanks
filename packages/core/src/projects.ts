import { z } from 'zod';
import type {
  BoardEvent,
  NeedsYouItem,
  SpecVersionInfo,
  TicketCard,
  TicketColumn,
  Usage,
} from './board';
import { type ClankId, clankIdSchema } from './crew';
import type { ProjectIntegration } from './integrations';
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

/** Where a project's repository is hosted, when it's a clone of one. */
export const repoHostSchema = z.enum(['github', 'gitlab']);

export type RepoHost = z.infer<typeof repoHostSchema>;

export const REPO_HOST_NAMES: Record<RepoHost, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** What a host calls a request to merge a branch, and how it numbers one: `PR #12`, `MR !12`. */
export function pullRequestName(host: RepoHost, number?: number): string {
  if (host === 'gitlab') return number === undefined ? 'merge request' : `MR !${number}`;
  return number === undefined ? 'pull request' : `PR #${number}`;
}

/** The GitHub or GitLab repository a project's workspace is a clone of. */
export interface ProjectRepo {
  host: RepoHost;
  /** `owner/name`, or `group/subgroup/name` on GitLab. */
  fullName: string;
  /** `https://github.com/owner/name`. */
  url: string;
  private: boolean;
}

/**
 * A limit on what the crew spends, in tokens, model time or cloud money. Null leaves that one
 * unlimited. When one is reached, runs pause and the scheduler starts no more.
 */
export const budgetSchema = z.object({
  tokens: z.number().int().min(1000).max(1e12).nullable(),
  minutes: z.number().min(1).max(1e6).nullable(),
  dollars: z.number().min(0.01).max(1e6).nullable(),
});

export type Budget = z.infer<typeof budgetSchema>;

/** Where the crew's shell commands run: on this computer, or in a Docker container per run. */
export const sandboxSchema = z.object({
  kind: z.enum(['host', 'docker']),
  /** The container may reach the network. Off, it can't install packages. */
  network: z.boolean(),
  /** The image containers start from. */
  image: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w./:@-]+$/, 'Use an image name such as node:22-bookworm'),
});

export type Sandbox = z.infer<typeof sandboxSchema>;

export const DEFAULT_SANDBOX: Sandbox = { kind: 'host', network: false, image: 'node:22-bookworm' };

/** How many runs a project has going at once, unless the user picks. */
export const DEFAULT_MAX_RUNS = 3;

/** A ticket that bounces more often than this comes to the user, unless the project says. */
export const DEFAULT_BOUNCE_LIMIT = 3;

export interface Project {
  id: string;
  name: string;
  /** A line about what's being made. */
  brief: string;
  key: string;
  /** The workspace: a local folder, or the clone of `repo`. Clanks work on copies of it. */
  folder: string;
  repo: ProjectRepo | null;
  /**
   * The branch tickets start from and merge into. Null uses whichever branch the folder has
   * checked out.
   */
  baseBranch: string | null;
  /** The model for the whole crew. Null leaves each clank on its own, or the app's crew model. */
  model: ModelChoice | null;
  /** Runs going at once in this project. */
  maxRuns: number;
  /** A ticket sent back more often than this comes to the user. */
  bounceLimit: number;
  /** Checks made optional, as `clank:type`, such as `gauge:pr`. The rest are required. */
  optionalChecks: string[];
  /** The whole project's budget. */
  budget: Budget | null;
  /** Budgets for single clanks in this project, by id. */
  clankBudgets: Record<ClankId, Budget>;
  sandbox: Sandbox;
  /** The crew finishes what's running and starts nothing new until the user lets it go on. */
  held: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Why a project, or a clank in it, can't spend any more: a budget was reached. */
export interface BudgetStatus {
  usage: Usage;
  /** What ran out, worded for the user, such as "500k tokens". Null while there's room. */
  reached: string | null;
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
  /** What the project has spent, against its budget. */
  spend: BudgetStatus;
}

/** Everything the board shows, sent again whenever it changes. */
export interface BoardSnapshot {
  project: ProjectSummary;
  tickets: TicketCard[];
  specs: SpecVersionInfo[];
  /** The newest last. */
  events: BoardEvent[];
  needsYou: NeedsYouItem[];
  /** What each clank in the crew has spent here, against its budget. */
  clanks: Record<ClankId, BudgetStatus>;
  /** The services turned on here, each with its mode and the clanks that may use it. */
  integrations: ProjectIntegration[];
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
    z.object({
      kind: z.literal('gitlab'),
      /** `group/name`, with any subgroups between. */
      repo: z.string().regex(/^[\w.-]+(\/[\w.-]+)+$/, 'Use group/name'),
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

/** A git branch name, roughly as git allows them. */
export const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/, "That isn't a branch name");

export const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    brief: z.string().trim().max(500),
    model: modelChoiceSchema.nullable(),
    baseBranch: branchNameSchema.nullable(),
    maxRuns: z.number().int().min(1).max(16),
    bounceLimit: z.number().int().min(1).max(20),
    optionalChecks: z.array(z.string().regex(/^[a-z][a-z0-9-]*:[a-z]+$/)).max(100),
    budget: budgetSchema.nullable(),
    clankBudgets: z.record(clankIdSchema, budgetSchema),
    sandbox: sandboxSchema,
    held: z.boolean(),
  })
  .partial();

export type ProjectPatch = z.infer<typeof projectPatchSchema>;

/** What a budget ran out of, worded for the user, or null while there's room. */
export function budgetReached(budget: Budget | null | undefined, usage: Usage): string | null {
  if (!budget) return null;
  if (budget.tokens !== null && usage.tokens >= budget.tokens) {
    return `${compactNumber(budget.tokens)} tokens`;
  }
  if (budget.minutes !== null && usage.ms >= budget.minutes * 60_000) {
    return `${budget.minutes} ${budget.minutes === 1 ? 'minute' : 'minutes'} of model time`;
  }
  if (budget.dollars !== null && usage.dollars >= budget.dollars) {
    return `$${budget.dollars.toFixed(2)} of cloud spend`;
  }
  return null;
}

/** 1500 as 1.5k, 2000000 as 2M. */
export function compactNumber(n: number): string {
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}k`;
  return String(n);
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

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

/** Who's signed in to GitLab, if anyone, and which GitLab: gitlab.com or one a team hosts. */
export interface GitLabStatus {
  signedIn: boolean;
  login: string | null;
  name: string | null;
  /** `https://gitlab.com`, or a self-hosted instance's address. */
  baseUrl: string;
  /** Why the last sign-in didn't work. */
  error: string | null;
}

export const DEFAULT_GITLAB_URL = 'https://gitlab.com';

export const gitlabSignInSchema = z.object({
  token: z
    .string()
    .trim()
    .min(20, "That's too short to be a GitLab token")
    .max(500)
    .regex(/^[\w.-]+$/, "That doesn't look like a GitLab token"),
  /** Empty for gitlab.com. */
  baseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((url) => url === '' || /^https?:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/i.test(url), {
      message: 'Use an address such as https://gitlab.example.com',
    })
    .default(''),
});

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
