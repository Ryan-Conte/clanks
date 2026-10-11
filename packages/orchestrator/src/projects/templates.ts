import {
  BUILTIN_TEMPLATES,
  LEAD_CLANK,
  type NewProject,
  type Project,
  type ProjectTemplate,
  SAMPLE_TEMPLATE,
  fillTemplate,
} from '@clanks/core';
import { existsSync, mkdirSync } from 'node:fs';
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
 * The first-run tour's sample: a small project in a folder of its own, with two tickets the crew
 * can finish while the user watches.
 */
export async function createSample(
  ctx: OrchestratorContext,
  folder?: string,
): Promise<StartedProject> {
  const template = BUILTIN_TEMPLATES.find((t) => t.id === SAMPLE_TEMPLATE)!;
  const base = join(homedir(), 'clanks', 'coffee-cart');
  let path = folder ?? base;
  for (let i = 2; !folder && existsSync(path); i++) path = `${base}-${i}`;
  mkdirSync(path, { recursive: true });
  const taken = new Set(ctx.projects.list().map((p) => p.key));
  let key = 'CART';
  for (let i = 2; taken.has(key); i++) key = `CART${i}`;
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
