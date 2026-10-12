import {
  BUILTIN_TEMPLATES,
  DEFAULT_PROJECT_CREW,
  LEAD_CLANK,
  type MessageImage,
  type NewProject,
  type Project,
  type ProjectTemplate,
  SAMPLE_TEMPLATE,
  fillTemplate,
  suggestFolder,
  suggestKey,
  suggestName,
} from '@clanks/core';
import { existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratorContext } from '../trpc';
import { ProjectError } from './service';

/** A project made from a template, and how its first steps went. */
export interface StartedProject {
  project: Project;
  /** The chat Atlas was told what to do in, to open. Null when the template starts none. */
  conversationId: string | null;
  /** How many tickets went on the board straight away. */
  tickets: number;
  /** What couldn't be done, worded for the user: the project is there either way. */
  notes: string[];
}

/** Every template a new project can start from: the app's own, then those installed. */
export function projectTemplates(ctx: OrchestratorContext): ProjectTemplate[] {
  const installed = ctx.marketplace
    .projectTemplates()
    .filter((t) => !BUILTIN_TEMPLATES.some((b) => b.id === t.id));
  return [...BUILTIN_TEMPLATES, ...installed];
}

/**
 * Makes a project from a template: its tickets go on the board as they're written, and Atlas is
 * told what the template asks, in a chat the user can read and carry on. The crew is whoever the
 * user picked, which the template only suggested.
 */
export async function createFromTemplate(
  ctx: OrchestratorContext,
  input: NewProject,
  templateId: string,
  /** Pictures the user sent with what they want, which go to Atlas with it. */
  images: MessageImage[] = [],
): Promise<StartedProject> {
  const template = projectTemplates(ctx).find((t) => t.id === templateId);
  if (!template) throw new ProjectError("That template isn't installed any more");
  const project = await ctx.projects.create(input);
  const values = { brief: input.brief, name: input.name };
  const notes: string[] = [];
  const crew = ctx.projects.members(project.id).map((m) => m.clankId);

  const made = ctx.board.addMany(
    project.id,
    template.tickets.map((ticket) => ({
      title: fillTemplate(ticket.title, values),
      type: ticket.type,
      description: fillTemplate(ticket.description, values),
      criteria: ticket.criteria.map((c) => fillTemplate(c, values)),
      // A clank left out of the crew leaves its tickets open for whoever makes their type.
      clank: ticket.clank && crew.includes(ticket.clank) ? ticket.clank : null,
      dependsOn: ticket.dependsOn,
    })),
  );
  notes.push(...made.notes);

  let conversationId: string | null = null;
  if (template.kickoff) {
    try {
      const started = ctx.chat.start(
        LEAD_CLANK,
        fillTemplate(template.kickoff, values),
        null,
        project.id,
        images,
      );
      conversationId = started.conversation.id;
    } catch (error) {
      notes.push(
        `Atlas couldn't be started on it: ${error instanceof Error ? error.message : String(error)} Open a chat with Atlas in the project once that's sorted.`,
      );
    }
  }
  return { project, conversationId, tickets: made.tickets.length, notes };
}

/**
 * Where projects the app makes a folder for go, unless the user picks one: `~/clanks`, or
 * `CLANKS_PROJECTS_DIR` when it's set.
 */
export function projectsRoot(): string {
  return process.env.CLANKS_PROJECTS_DIR || join(homedir(), 'clanks');
}

/** A folder that isn't there yet: `surf-shop`, then `surf-shop-2`. */
function freeFolder(root: string, name: string): string {
  const base = join(root, name);
  let path = base;
  for (let i = 2; existsSync(path); i++) path = `${base}-${i}`;
  return path;
}

/** Ticket key letters no other project has: `SURF`, then `SURF2`. */
function freeKey(ctx: OrchestratorContext, wanted: string): string {
  const taken = new Set(ctx.projects.list().map((p) => p.key));
  const stem = wanted.slice(0, 5);
  let key = wanted;
  for (let i = 2; taken.has(key); i++) key = `${stem}${i}`.slice(0, 6);
  return key;
}

/** Makes a new folder for a project, named for it, and says where it is. */
export function newProjectFolder(name: string, root = projectsRoot()): string {
  const path = freeFolder(root, suggestFolder(name));
  mkdirSync(path, { recursive: true });
  return path;
}

/** Runs what makes a project in a folder made for it, and takes the folder away if it fails. */
async function keepingFolder<T>(path: string, make: () => Promise<T>): Promise<T> {
  try {
    return await make();
  } catch (error) {
    try {
      // Only ever an empty folder: one with anything in it stays.
      rmdirSync(path);
    } catch {
      // It stays, then.
    }
    throw error;
  }
}

/**
 * A project from one sentence, with nothing else asked: it's named from the idea, gets a folder of
 * its own and the crew its template wants (or the usual one), and Atlas is told the idea in a chat
 * the user lands in. Everything it picks can be changed afterwards.
 */
export async function quickStart(
  ctx: OrchestratorContext,
  input: {
    idea: string;
    templateId?: string | null | undefined;
    images?: MessageImage[] | undefined;
  },
  root = projectsRoot(),
): Promise<StartedProject> {
  const idea = input.idea.trim();
  const template = input.templateId
    ? projectTemplates(ctx).find((t) => t.id === input.templateId)
    : undefined;
  if (input.templateId && !template) {
    throw new ProjectError("That template isn't installed any more");
  }
  const name = suggestName(idea);
  const path = newProjectFolder(name, root);
  const project: NewProject = {
    name,
    brief: idea.split(/\s+/).join(' ').slice(0, 500),
    key: freeKey(ctx, suggestKey(name)),
    workspace: { kind: 'folder', path },
    crew: [...(template?.crew ?? DEFAULT_PROJECT_CREW)],
    model: null,
    models: {},
  };
  if (template) {
    return keepingFolder(path, () => createFromTemplate(ctx, project, template.id, input.images));
  }
  const made = await keepingFolder(path, () => ctx.projects.create(project));
  const notes: string[] = [];
  let conversationId: string | null = null;
  try {
    conversationId = ctx.chat.start(LEAD_CLANK, idea, null, made.id, input.images).conversation.id;
  } catch (error) {
    notes.push(
      `Atlas couldn't be started on it: ${error instanceof Error ? error.message : String(error)} Open a chat with Atlas in the project once that's sorted.`,
    );
  }
  return { project: made, conversationId, tickets: 0, notes };
}

/**
 * The first-run tour's sample: a small project in a folder of its own, with two tickets the crew
 * can finish while the user watches.
 */
export async function createSample(
  ctx: OrchestratorContext,
  folder?: string,
): Promise<StartedProject> {
  const template = BUILTIN_TEMPLATES.find((t) => t.id === SAMPLE_TEMPLATE)!;
  const path = folder ?? freeFolder(projectsRoot(), 'coffee-cart');
  mkdirSync(path, { recursive: true });
  const key = freeKey(ctx, 'CART');
  return createFromTemplate(
    ctx,
    {
      name: 'Coffee cart',
      brief: template.example,
      key,
      workspace: { kind: 'folder', path },
      crew: template.crew,
      model: null,
      models: {},
    },
    SAMPLE_TEMPLATE,
  );
}
