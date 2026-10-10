import { type UserProfile, type WorkspaceStatus, estimateTokens, orderStages } from '@clanks/core';
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

/**
 * What one run of a clank is for: a chat with the user, a ticket it works on its own, or planning
 * the board from a spec the user approved.
 */
export interface RunContext {
  mode: 'chat' | 'ticket' | 'plan';
  /** The project the chat or run is in, by name. */
  project: string | null;
  /** A ticket or planning run's own part of the run context, written by the board. */
  brief: string | null;
  /** The folder the chat is about, if any. */
  folder: string | null;
  /** The clank's own copy of the folder's repository, when it has one. */
  workspace: { worktree: string; cwd: string; branch: string; baseCommit: string } | null;
  /** Why a chat about a folder has no workspace. Null when it isn't about one. */
  workspaceStatus: WorkspaceStatus | null;
  /** The tools offered in this chat. */
  tools: string[];
  /** The shell commands run in, when the clank can run them. */
  shell: string | null;
  /** The port servers a ticket's run starts should use, so parallel runs don't collide. */
  port?: number | null;
  /** The model can't call tools, so none were offered. */
  toolsUnsupported: boolean;
  /** Tools that should be there and aren't, such as an MCP server that didn't start. */
  problems: string[];
}

export interface PromptInput {
  /** CREW.md. */
  rules: string;
  clank: Clank;
  /** Everyone in the crew, the clank included, in roster order. */
  crew: Clank[];
  profile: UserProfile;
  instructions: ProjectInstructions | null;
  /** The project context layer, for a chat or run in a project. */
  context: string | null;
  /** The clank's memory layer: its own entries for this project that matter here. */
  memory?: string | null;
  /** The model's context window, which the layers' budgets scale to. */
  window?: number;
  run: RunContext;
  now: Date;
  platform: NodeJS.Platform;
}

/** Layer budgets for a 32k-token model, from docs/CONTEXT.md. */
export const BUDGETS = { profile: 300, instructions: 1500, context: 2000, memory: 1000 } as const;

/**
 * Layer budgets for a model's context window. Project context and clank memory scale with it,
 * so a 16k model gets half; the user's own words keep theirs, and say so when they don't fit.
 */
export function layerBudgets(window = 32_768): Record<keyof typeof BUDGETS, number> {
  const scale = Math.max(0.25, Math.min(1, window / 32_768));
  return {
    profile: BUDGETS.profile,
    instructions: BUDGETS.instructions,
    context: Math.round(BUDGETS.context * scale),
    memory: Math.round(BUDGETS.memory * scale),
  };
}

/**
 * Builds a clank's system prompt. Stable layers come first, so llama.cpp's prompt cache and
 * providers' prompt caching reuse them from one turn to the next.
 */
export function assemblePrompt(input: PromptInput): AssembledPrompt {
  const variables = promptVariables(input);
  // Only the app's own text is templated. What the user wrote goes in as it is.
  const fill = (text: string) => fillVariables(text, variables);

  const budgets = layerBudgets(input.window);
  const layers: PromptLayer[] = [
    layer('crew', 'Crew rules', fill(input.rules)),
    layer('clank', `${input.clank.name}'s priming doc`, fill(input.clank.body)),
    // Integration guides arrive with integrations.
    layer('profile', 'Your profile', profileText(input.profile, fill), budgets.profile),
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
      layers.push(layer('instructions', file, `${intro}\n\n${own}`, budgets.instructions));
    }
  }

  // The board writes the project context and a run's brief from what's on it: not templated.
  if (input.context) {
    layers.push(layer('context', 'Project context', input.context, budgets.context));
  }
  if (input.memory) {
    layers.push(layer('memory', `${input.clank.name}'s memory`, input.memory, budgets.memory));
  }
  layers.push(layer('run', 'Run context', runText(input.run, fill)));

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
  return orderStages(crew.map((c) => c.frontmatter.workflow))
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

const NO_FOLDER_REASONS: Partial<Record<WorkspaceStatus, string>> = {
  not_repo:
    "It isn't a git repository yet, so you can't work on its files. {{user.name}} can set up git for it in the workbench.",
  no_commits:
    "Its git repository has no commits yet, so you can't work on its files. {{user.name}} can commit once, or set it up in the workbench.",
  no_git: "git isn't installed on this computer, so you can't work on its files.",
  error: "Its workspace couldn't be made, so you can't work on its files.",
};

function runText(run: RunContext, fill: (text: string) => string): string {
  const lines = ['## Run context', ''];
  if (run.mode !== 'chat' && run.brief) {
    // The board's words, which may quote the user's: added as they are, after the rest is filled.
    lines.push('{{brief}}');
  } else {
    lines.push(
      run.project
        ? `Mode: chat. You are talking with {{user.name}} directly, in the project ${run.project}.`
        : 'Mode: chat. You are talking with {{user.name}} directly.',
    );
  }
  const ws = run.workspace;
  if (run.folder && ws) {
    const sub = ws.cwd !== ws.worktree;
    const about = run.project ? "the project's workspace," : 'the folder';
    lines.push(
      `This ${run.mode === 'chat' ? 'chat' : 'run'} is about ${about} \`${run.folder}\`. You work in your own copy of it: a git worktree on the branch \`${ws.branch}\`, made from commit \`${ws.baseCommit.slice(0, 7)}\`. Paths in tools are relative to ${sub ? 'that folder in your copy' : 'your copy'}. Changes {{user.name}} hasn't committed aren't in it, and nothing you do touches their own checkout.`,
    );
  } else if (run.folder) {
    lines.push(`This chat is about the folder \`${run.folder}\`.`);
    const reason = run.workspaceStatus ? NO_FOLDER_REASONS[run.workspaceStatus] : undefined;
    if (reason) lines.push(reason);
  }

  lines.push('');
  if (run.toolsUnsupported) {
    lines.push(
      "The model you run on can't call tools, so no tools are connected to this chat: you can't read files, run commands, browse or save notes. Never say you did. When an ask needs a tool, say so plainly, and help as far as you can in your reply.",
    );
  } else if (run.tools.length === 0) {
    lines.push(
      "No tools are connected to this chat: you can't read files, run commands, browse, use the board or save notes. Never say you did. When an ask needs a tool, say so plainly, and help as far as you can in your reply.",
    );
  } else {
    lines.push(`Your tools here: ${run.tools.map((t) => `\`${t}\``).join(', ')}.`);
    lines.push(
      "A tool call that fails didn't happen. Fix it and call again, or tell {{user.name}} it failed; never say you did what a failed call didn't do.",
    );
    if (run.shell) lines.push(`Commands run in ${run.shell}.`);
    if (run.shell && run.port) {
      lines.push(
        `Other clanks may be running servers at the same time, so any server you start listens on port ${run.port}, which is in $PORT. Servers you leave running stop when your run ends.`,
      );
    }
    if (ws) {
      lines.push(
        '{{user.name}} watches your file changes in the diff editor and your commands in the terminal, and approves the calls that need it. They may reject a change with a note; fix what the note says.',
      );
    }
    if (run.tools.some((t) => t.startsWith('browser_'))) {
      lines.push(
        "Pages you open show in {{user.name}}'s browser pane as you work. browser_read gives a page as text with refs such as [12], which browser_click and browser_type take. If a page needs a login or shows a CAPTCHA, don't try to get past it: say so, and {{user.name}} can take over the browser. While they have it, your browser tools wait until they hand it back.",
      );
    }
    if (run.mode === 'chat') {
      lines.push(
        run.project
          ? "This is a chat, not a ticket: when you're done, reply to {{user.name}} with what you did and what you found. Board and spec tools work on this project's board; progress and output tools aren't available here."
          : "This is a chat, not a ticket: when you're done, reply to {{user.name}} with what you did and what you found. Board, spec, progress and output tools aren't available here, since the chat isn't in a project.",
      );
    }
  }
  if (run.problems.length > 0) {
    lines.push('', `These tools aren't working right now: ${run.problems.join('; ')}.`);
  }
  return fill(lines.join('\n')).replace('{{brief}}', () => run.brief ?? '');
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
