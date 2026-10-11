import { type Ticket, type WorkflowMember, makersOf } from '@clanks/core';
import { DESIGN_DIR } from '@clanks/design';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Names } from './text';

/** What's in a project's folder that a plan depends on. */
export interface FolderState {
  /** Nothing has been built in it yet: at most notes, a licence and a design. */
  unstarted: boolean;
  /** It has a design in `design/`. */
  designed: boolean;
}

/** Files that say what a project is, without being any of it. */
const NOT_CODE =
  /^(readme|licen[cs]e|changelog|contributing|clanks|notice|authors)(\.|$)|\.(md|txt)$/i;

/** Looks at a project's folder as it is now. A folder that can't be read counts as started. */
export function folderState(folder: string): FolderState {
  try {
    const built = readdirSync(folder).filter(
      (name) =>
        !name.startsWith('.') && name !== DESIGN_DIR && name !== 'docs' && !NOT_CODE.test(name),
    );
    const design = join(folder, DESIGN_DIR);
    return {
      unstarted: built.length === 0,
      designed: existsSync(design) && readdirSync(design).some((name) => name.endsWith('.design')),
    };
  } catch {
    return { unstarted: false, designed: true };
  }
}

/** Whether a project's folder has a `package.json` with a build script, so its build can be run. */
export function hasBuildScript(folder: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof manifest.scripts?.build === 'string';
  } catch {
    return false;
  }
}

/**
 * The code tickets that would start first: those not done that wait, through whatever they wait
 * on, for no other code ticket. In backlog order.
 */
export function firstBuilds(all: Ticket[]): Ticket[] {
  const open = new Map(all.filter((t) => !t.doneAt).map((t) => [t.id, t]));
  const waitsOnCode = (ticket: Ticket): boolean => {
    const seen = new Set<string>();
    const stack = [...ticket.dependsOn];
    while (stack.length > 0) {
      const next = open.get(stack.pop()!);
      if (!next || seen.has(next.id)) continue;
      if (next.type === 'pr') return true;
      seen.add(next.id);
      stack.push(...next.dependsOn);
    }
    return false;
  };
  return [...open.values()]
    .filter((t) => t.type === 'pr' && !waitsOnCode(t))
    .sort((a, b) => a.number - b.number);
}

export interface PlanProblem {
  id: 'no-maker' | 'empty-folder' | 'no-design';
  /** It stops the plan working, so it's raised again while it's there. Otherwise once. */
  firm: boolean;
  /** For the planner: what's wrong and how to fix it. */
  text: string;
}

/**
 * What would stop a plan working as it stands. Small models write one ticket per story and stop,
 * so the board checks what the planner's instructions ask for before anything starts.
 */
export function planProblems(input: {
  /** The tickets this planning run made. */
  planned: Ticket[];
  /** Every ticket on the board. */
  all: Ticket[];
  crew: WorkflowMember[];
  folder: FolderState;
  names: Names;
}): PlanProblem[] {
  const { planned, all, crew, folder, names } = input;
  const problems: PlanProblem[] = [];
  const keys = (tickets: Ticket[]) => listOf(tickets.map((t) => t.key));

  const orphans = planned.filter((t) => !t.doneAt && makersOf(t.type, crew).length === 0);
  for (const type of new Set(orphans.map((t) => t.type))) {
    const of = orphans.filter((t) => t.type === type);
    problems.push({
      id: 'no-maker',
      firm: true,
      text: `Nobody in the crew makes \`${type}\` tickets, so ${keys(of)} would wait for ever. Fold ${of.length === 1 ? 'its' : 'their'} work into a ticket of a type the crew makes, with \`board_update_ticket\`, and say in your summary which clank ${names.user} could add to the crew for it.`,
    });
  }

  const code = planned.filter((t) => t.type === 'pr' && !t.doneAt);
  if (code.length > 0 && folder.unstarted) {
    const first = firstBuilds(all);
    if (first.length > 1) {
      problems.push({
        id: 'empty-folder',
        firm: true,
        text: `The project's folder has no code yet, so one ticket has to set the app up before anything else is built. ${keys(first)} would all start at once on an empty folder, each setting up an app of its own. Create a setup ticket first (type \`pr\`, no stories, criteria of its own such as "\`npm run build\` succeeds and the home page renders"), then make each of them wait on it, or on a ticket that does, with \`board_link_dependency\`. Tickets that change the same files wait on each other too.`,
      });
    }
  }

  const designer = makersOf('design', crew)[0];
  if (designer && code.length > 0 && !folder.designed && !all.some((t) => t.type === 'design')) {
    problems.push({
      id: 'no-design',
      firm: false,
      text: `${designer.name} is in the crew and nothing is designed yet, but no ticket asks for a design. Screens are designed before they're built: create a \`design\` ticket for ${designer.name}, for the design language and the screens these stories need, and make each ticket that builds a screen wait on it with \`board_link_dependency\`. If none of these tickets has a UI, leave it and say so in your summary.`,
    });
  }
  return problems;
}

/** What the planner is told when its plan is sent back. */
export function planCheckText(problems: PlanProblem[], names: Names): string {
  return [
    `The plan can't run as it stands, so nothing has started. Fix ${problems.length === 1 ? 'this' : 'these'} on the board, then reply to ${names.user} with the summary again.`,
    '',
    ...problems.map((p, i) => `${i + 1}. ${p.text}`),
  ].join('\n');
}

/** Names as a sentence lists them: "SURF-2, SURF-3 and SURF-4". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}
