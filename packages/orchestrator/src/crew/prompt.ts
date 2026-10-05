import { STAGES, type UserProfile, estimateTokens } from '@clanks/core';
import type { Clank } from './crew';
import { type ProjectInstructions, instructionsFor } from './instructions';

/** The layers of a system prompt, in the order they're assembled. See docs/CONTEXT.md. */
export type PromptLayerId =
  'crew' | 'clank' | 'integrations' | 'profile' | 'instructions' | 'context' | 'memory' | 'run';

export interface PromptLayer {
  id: PromptLayerId;
  title: string;
  text: string;
  tokens: number;
  /** The most this layer may take, if it has a budget of its own. */
  budget: number | null;
  /** It was over its budget, so the end was cut. */
  truncated: boolean;
}

export interface AssembledPrompt {
  system: string;
  layers: PromptLayer[];
  tokens: number;
}

/** What one run of a clank is for. Tickets come with the board. */
export interface RunContext {
  mode: 'chat';
  /** The folder the chat is about, if any. */
  folder: string | null;
}

export interface PromptInput {
  /** CREW.md. */
  rules: string;
  clank: Clank;
  /** Everyone in the crew, the clank included, in roster order. */
  crew: Clank[];
  profile: UserProfile;
  instructions: ProjectInstructions | null;
  run: RunContext;
  now: Date;
  platform: NodeJS.Platform;
}

/** Layer budgets for a 32k-token model, from docs/CONTEXT.md. */
export const BUDGETS = { profile: 300, instructions: 1500 } as const;

/**
 * Builds a clank's system prompt. Stable layers come first, so llama.cpp's prompt cache and
 * providers' prompt caching reuse them from one turn to the next.
 */
export function assemblePrompt(input: PromptInput): AssembledPrompt {
  const variables = promptVariables(input);
  // Only the app's own text is templated. What the user wrote goes in as it is.
  const fill = (text: string) => fillVariables(text, variables);

  const layers: PromptLayer[] = [
    layer('crew', 'Crew rules', fill(input.rules)),
    layer('clank', `${input.clank.name}'s priming doc`, fill(input.clank.body)),
    // Integration guides, project context and clank memory arrive with integrations and projects.
    layer('profile', 'Your profile', profileText(input.profile, fill), BUDGETS.profile),
  ];

  if (input.instructions) {
    const own = instructionsFor(input.instructions.text, {
      id: input.clank.id,
      names: [input.clank.name, input.clank.frontmatter.name],
    });
    if (own) {
      const { file } = input.instructions;
      const intro = fill(
        `## Project instructions\n\n{{user.name}} wrote these in \`${file}\` for this project. Follow them.`,
      );
      layers.push(layer('instructions', file, `${intro}\n\n${own}`, BUDGETS.instructions));
    }
  }

  layers.push(layer('run', 'Run context', fill(runText(input.run))));

  const system = layers.map((l) => l.text).join('\n\n');
  return { system, layers, tokens: estimateTokens(system) };
}

function layer(
  id: PromptLayerId,
  title: string,
  text: string,
  budget: number | null = null,
): PromptLayer {
  let body = text.trim();
  let truncated = false;
  if (budget !== null && estimateTokens(body) > budget) {
    // Cut at a line break inside the budget, and say so: the model shouldn't think it saw it all.
    const limit = budget * 4;
    const cut = body.lastIndexOf('\n', limit);
    body = `${body.slice(0, cut > limit / 2 ? cut : limit).trimEnd()}\n\n(The rest was cut to fit.)`;
    truncated = true;
  }
  return { id, title, text: body, tokens: estimateTokens(body), budget, truncated };
}

export interface PromptVariables {
  date: string;
  os: string;
  'clank.name': string;
  'user.name': string;
  crew: string;
  workflow: string;
}

export function promptVariables(
  input: Omit<PromptInput, 'instructions' | 'run' | 'rules'>,
): PromptVariables {
  return {
    date: isoDate(input.now, timeZoneOf(input.profile)),
    os: osName(input.platform),
    'clank.name': input.clank.name,
    'user.name': input.profile.name || 'the user',
    crew: crewRoster(input.crew),
    workflow: workflowStages(input.crew),
  };
}

/**
 * Fills `{{name}}` variables. Nothing else is templated, so anything else in braces is left as it
 * is. With no name set, "the user" starts a sentence with a capital.
 */
export function fillVariables(text: string, variables: PromptVariables): string {
  const filled = text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) =>
    name in variables ? variables[name as keyof PromptVariables] : match,
  );
  return variables['user.name'] === 'the user'
    ? filled.replace(/(^|\n|[.!?]\s+|\n[-*]\s+|\n\d+\.\s+)the user/g, '$1The user')
    : filled;
}

/** `{{crew}}`: one line per clank with its id, name, role, kind, outputs and summary. */
export function crewRoster(crew: Clank[]): string {
  return crew
    .map((clank) => {
      const { workflow, outputs, role, summary } = clank.frontmatter;
      let job: string;
      if (workflow.kind === 'maker') job = `makes ${outputs.map((o) => `\`${o}\``).join(', ')}`;
      else if (workflow.stage === 'signoff') job = 'signs off every ticket';
      else {
        const types = workflow.applies_to ?? [];
        job = types.includes('all')
          ? 'checks every ticket'
          : `checks ${types.map((t) => `\`${t}\``).join(', ')}`;
      }
      return `- ${clank.name} (\`${clank.id}\`), ${role}: ${job}. ${summary}`;
    })
    .join('\n');
}

/** `{{workflow}}`: the stages in order with the clanks in each, custom checkers included. */
export function workflowStages(crew: Clank[]): string {
  const builtin = (stage: string) => (STAGES as readonly string[]).includes(stage);
  const order: string[] = [...STAGES];
  // Custom stages go after the stage they name, in roster order. One may follow another.
  let pending = crew.map((c) => c.frontmatter.workflow).filter((w) => !builtin(w.stage));
  for (;;) {
    const ready = pending.filter((w) => order.includes(w.after ?? ''));
    if (ready.length === 0) break;
    for (const workflow of ready) {
      if (order.includes(workflow.stage)) continue;
      // Behind any custom stage already placed there, so roster order holds.
      let at = order.indexOf(workflow.after!) + 1;
      while (at < order.length && !builtin(order[at]!)) at++;
      order.splice(at, 0, workflow.stage);
    }
    pending = pending.filter((w) => !order.includes(w.stage));
  }
  // One whose stage to follow nobody uses still runs, just before sign-off.
  for (const workflow of pending) {
    if (!order.includes(workflow.stage)) order.splice(order.indexOf('signoff'), 0, workflow.stage);
  }
  return order
    .map((stage) => ({
      stage,
      names: crew.filter((c) => c.frontmatter.workflow.stage === stage).map((c) => c.name),
    }))
    .filter((s) => s.names.length > 0)
    .map((s, i) => `${i + 1}. ${stageLabel(s.stage)}: ${s.names.join(', ')}`)
    .join('\n');
}

function stageLabel(stage: string): string {
  const known: Record<string, string> = { qa: 'QA', signoff: 'Sign-off' };
  return known[stage] ?? stage.charAt(0).toUpperCase() + stage.slice(1).replace(/-/g, ' ');
}

function profileText(profile: UserProfile, fill: (text: string) => string): string {
  const lines = [fill('## About {{user.name}}'), ''];
  if (profile.name) lines.push(`- Name: ${profile.name}`);
  lines.push(`- Time zone: ${timeZoneOf(profile)}`);
  if (profile.language) lines.push(`- Language: ${profile.language}. Write in it.`);
  if (profile.preferences) {
    lines.push('', fill('How {{user.name}} likes to work:'), '', profile.preferences);
  }
  return lines.join('\n');
}

function runText(run: RunContext): string {
  const lines = ['## Run context', '', 'Mode: chat. You are talking with {{user.name}} directly.'];
  if (run.folder) lines.push(`This chat is about the folder \`${run.folder}\`.`);
  lines.push(
    '',
    "No tools are connected to this chat: you can't read files, run commands, browse, use the board or save notes. Never say you did. When an ask needs a tool, say so plainly, and help as far as you can in your reply.",
  );
  return lines.join('\n');
}

/** The user's time zone, or this computer's when they haven't set one. */
export function timeZoneOf(profile: UserProfile): string {
  return profile.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isoDate(now: Date, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function osName(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'Linux';
}
