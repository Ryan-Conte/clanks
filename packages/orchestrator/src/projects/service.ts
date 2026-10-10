import {
  type Budget,
  DEFAULT_BOUNCE_LIMIT,
  DEFAULT_MAX_RUNS,
  DEFAULT_SANDBOX,
  LEAD_CLANK,
  type ModelChoice,
  type NewProject,
  type Project,
  type ProjectMember,
  type ProjectPatch,
  newProjectSchema,
} from '@clanks/core';
import { GitError, git, gitVersion, initRepo, repoInfo } from '@clanks/workspace';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Clank, CrewService } from '../crew/crew';
import type { GitHubService } from '../github/service';
import { project as projectTable, projectClank } from '../store/schema';
import type { Db } from '../store/store';

/** A project problem worded for the user. */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** Whether a folder can be a project's workspace as it is. */
export interface FolderCheck {
  path: string;
  /** `ready` is a repository with commits; the others are set up when the project is made. */
  status: 'ready' | 'not_repo' | 'no_commits' | 'no_git' | 'missing';
  /** The repository's top folder, when it's in one. */
  root: string | null;
}

export interface ProjectServiceOptions {
  db: Db;
  crew: CrewService;
  github: GitHubService;
  now?: () => Date;
}

type ProjectRow = typeof projectTable.$inferSelect;

/** One clank's row in a project's crew. */
const member = (projectId: string, clankId: string) =>
  and(eq(projectClank.projectId, projectId), eq(projectClank.clankId, clankId));

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    key: row.key,
    folder: row.folder,
    repo: row.repo ?? null,
    baseBranch: row.baseBranch ?? null,
    model: row.provider && row.model ? { provider: row.provider, model: row.model } : null,
    maxRuns: row.maxRuns,
    bounceLimit: row.bounceLimit,
    optionalChecks: row.optionalChecks ?? [],
    budget: row.budget ?? null,
    clankBudgets: row.clankBudgets ?? {},
    sandbox: row.sandbox ?? DEFAULT_SANDBOX,
    held: row.held,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Projects: a workspace, the crew working in it and their models. Emits `change` with a project's
 * id when it changes, and the board's own changes go through the board service.
 */
export class ProjectService extends EventEmitter<{ change: [projectId: string] }> {
  constructor(private readonly options: ProjectServiceOptions) {
    super();
    this.setMaxListeners(100);
  }

  /** Every project, most recently changed first. */
  list(): Project[] {
    return this.options.db
      .select()
      .from(projectTable)
      .all()
      .map(toProject)
      .sort((a, b) => +b.updatedAt - +a.updatedAt);
  }

  find(id: string): Project | undefined {
    const row = this.options.db.select().from(projectTable).where(eq(projectTable.id, id)).get();
    return row ? toProject(row) : undefined;
  }

  get(id: string): Project {
    const found = this.find(id);
    if (!found) throw new ProjectError('That project was deleted');
    return found;
  }

  /** The crew, in roster order, Atlas first. */
  members(id: string): ProjectMember[] {
    const rows = this.options.db
      .select()
      .from(projectClank)
      .where(eq(projectClank.projectId, id))
      .all();
    const order = this.options.crew.list().map((c) => c.id);
    return rows
      .filter((r) => this.options.crew.has(r.clankId))
      .sort((a, b) => order.indexOf(a.clankId) - order.indexOf(b.clankId))
      .map((r) => ({
        clankId: r.clankId,
        model: r.provider && r.model ? { provider: r.provider, model: r.model } : null,
      }));
  }

  /** The crew's clanks, ready to work. */
  clanks(id: string): Clank[] {
    return this.members(id).map((m) => this.options.crew.get(m.clankId));
  }

  inCrew(id: string, clankId: string): boolean {
    return this.members(id).some((m) => m.clankId === clankId);
  }

  /** The model a clank runs on in a project, if the project says: its own there, or the crew's. */
  modelFor(id: string, clankId: string): ModelChoice | null {
    const member = this.members(id).find((m) => m.clankId === clankId);
    return member?.model ?? this.find(id)?.model ?? null;
  }

  /** Whether a folder can be a workspace as it is, or needs git set up first. */
  async checkFolder(folder: string): Promise<FolderCheck> {
    const path = resolve(folder);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return { path, status: 'missing', root: null };
    }
    if (!(await gitVersion())) return { path, status: 'no_git', root: null };
    const info = await repoInfo(path);
    if (!info) return { path, status: 'not_repo', root: null };
    return { path, status: info.head ? 'ready' : 'no_commits', root: info.root };
  }

  /**
   * Makes a project. A local folder that isn't a repository yet becomes one, with what's in it
   * committed, since the crew works on copies made with git. A GitHub repository is cloned first.
   */
  async create(input: NewProject): Promise<Project> {
    const values = newProjectSchema.parse(input);
    const crew = [LEAD_CLANK, ...values.crew.filter((id) => id !== LEAD_CLANK)];
    for (const id of crew) {
      if (!this.options.crew.has(id)) throw new ProjectError(`There's no clank called ${id}`);
    }

    let folder: string;
    let repo: Project['repo'] = null;
    if (values.workspace.kind === 'github') {
      folder = resolve(values.workspace.into);
      repo = await this.options.github.clone(values.workspace.repo, folder);
    } else {
      folder = await this.prepareFolder(values.workspace.path);
    }

    const now = this.now();
    const row: ProjectRow = {
      id: randomUUID(),
      name: values.name,
      brief: values.brief,
      key: values.key,
      folder,
      repo,
      baseBranch: null,
      provider: values.model?.provider ?? null,
      model: values.model?.model ?? null,
      nextNumber: 1,
      maxRuns: DEFAULT_MAX_RUNS,
      bounceLimit: DEFAULT_BOUNCE_LIMIT,
      optionalChecks: [],
      budget: null,
      clankBudgets: {},
      sandbox: null,
      held: false,
      createdAt: now,
      updatedAt: now,
    };
    this.options.db.transaction((tx) => {
      tx.insert(projectTable).values(row).run();
      for (const clankId of new Set(crew)) {
        const model = values.models[clankId] ?? null;
        tx.insert(projectClank)
          .values({
            projectId: row.id,
            clankId,
            provider: model?.provider ?? null,
            model: model?.model ?? null,
          })
          .run();
      }
    });
    this.emit('change', row.id);
    return toProject(row);
  }

  update(id: string, patch: ProjectPatch): Project {
    this.get(id);
    const changes: Partial<ProjectRow> = { updatedAt: this.now() };
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.brief !== undefined) changes.brief = patch.brief;
    if (patch.model !== undefined) {
      changes.provider = patch.model?.provider ?? null;
      changes.model = patch.model?.model ?? null;
    }
    if (patch.baseBranch !== undefined) changes.baseBranch = patch.baseBranch;
    if (patch.maxRuns !== undefined) changes.maxRuns = patch.maxRuns;
    if (patch.bounceLimit !== undefined) changes.bounceLimit = patch.bounceLimit;
    if (patch.optionalChecks !== undefined) changes.optionalChecks = patch.optionalChecks;
    if (patch.budget !== undefined) changes.budget = cleanBudget(patch.budget);
    if (patch.clankBudgets !== undefined) {
      changes.clankBudgets = Object.fromEntries(
        Object.entries(patch.clankBudgets)
          .map(([id, budget]) => [id, cleanBudget(budget)] as const)
          .filter((entry): entry is [string, Budget] => entry[1] !== null),
      );
    }
    if (patch.sandbox !== undefined) changes.sandbox = patch.sandbox;
    if (patch.held !== undefined) changes.held = patch.held;
    this.options.db.update(projectTable).set(changes).where(eq(projectTable.id, id)).run();
    this.emit('change', id);
    return this.get(id);
  }

  /** Adds a clank to the crew, or takes one out. Atlas always stays. */
  setMember(id: string, clankId: string, included: boolean): ProjectMember[] {
    this.get(id);
    if (!this.options.crew.has(clankId))
      throw new ProjectError(`There's no clank called ${clankId}`);
    if (included) {
      this.options.db
        .insert(projectClank)
        .values({ projectId: id, clankId, provider: null, model: null })
        .onConflictDoNothing()
        .run();
    } else {
      if (clankId === LEAD_CLANK) throw new ProjectError('Atlas leads every project, so it stays');
      this.options.db.delete(projectClank).where(member(id, clankId)).run();
    }
    this.touch(id);
    return this.members(id);
  }

  /** A clank's model in this project. Null runs it on the project's. */
  setMemberModel(id: string, clankId: string, model: ModelChoice | null): ProjectMember[] {
    if (!this.inCrew(id, clankId))
      throw new ProjectError(`${clankId} isn't in this project's crew`);
    this.options.db
      .update(projectClank)
      .set({ provider: model?.provider ?? null, model: model?.model ?? null })
      .where(member(id, clankId))
      .run();
    this.touch(id);
    return this.members(id);
  }

  /** Takes the number for the project's next ticket. */
  takeNumber(id: string): number {
    const row = this.options.db
      .update(projectTable)
      .set({ nextNumber: sql`${projectTable.nextNumber} + 1` })
      .where(eq(projectTable.id, id))
      .returning({ next: projectTable.nextNumber })
      .get();
    if (!row) throw new ProjectError('That project was deleted');
    return row.next - 1;
  }

  /** Marks a project as changed now, which puts it first in the list. */
  touch(id: string): void {
    this.options.db
      .update(projectTable)
      .set({ updatedAt: this.now() })
      .where(eq(projectTable.id, id))
      .run();
    this.emit('change', id);
  }

  /** Forgets a project. Its folder and branches stay; the board's service removes its runs first. */
  remove(id: string): void {
    this.options.db.delete(projectTable).where(eq(projectTable.id, id)).run();
    this.emit('change', id);
  }

  /** A local folder ready to be a workspace: a repository with at least one commit. */
  private async prepareFolder(path: string): Promise<string> {
    const check = await this.checkFolder(path);
    if (check.status === 'missing') throw new ProjectError(`${check.path} isn't a folder`);
    if (check.status === 'no_git') {
      throw new ProjectError(
        "git isn't installed, and the crew needs it to work on copies of the folder",
      );
    }
    try {
      if (check.status === 'not_repo') {
        await initRepo(check.path);
      } else if (check.status === 'no_commits') {
        await git(['add', '-A'], { cwd: check.root! });
        await git(['commit', '--allow-empty', '-m', 'Initial commit'], {
          cwd: check.root!,
          env: { GIT_AUTHOR_NAME: 'clanks', GIT_AUTHOR_EMAIL: 'clanks@localhost' },
        });
      }
    } catch (error) {
      throw new ProjectError(
        `Couldn't set up git in ${check.path}: ${error instanceof GitError ? error.stderr || error.message : String(error)}`,
      );
    }
    return check.path;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** A budget with no limits set is no budget at all. */
function cleanBudget(budget: Budget | null): Budget | null {
  if (!budget) return null;
  return budget.tokens === null && budget.minutes === null && budget.dollars === null
    ? null
    : budget;
}
