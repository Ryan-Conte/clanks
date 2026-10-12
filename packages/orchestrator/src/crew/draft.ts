import type { ChatRequest, ModelChoice } from '@clanks/core';
import type { ProviderRegistry } from '@clanks/providers';
import { CrewDocError, stripComments } from './docs';

/** What a draft is written from: who the clank is, in the user's words. */
export interface DraftInput {
  name: string;
  role: string;
  /** A line or two about what it's for. */
  description: string;
  kind: 'maker' | 'checker';
  /** What a maker makes, or what a checker reviews. */
  types: string[];
  /** The tools it will have, so the prompt names only those. */
  tools: string[];
}

const SYSTEM = `You write priming docs for clanks: AI agents that work as a crew inside a desktop app, each with one job. A priming doc is the system prompt for one clank. It is written to the clank, in the second person, as short imperative sentences that a small local model can follow.

Reply with the doc only, in Markdown, with exactly these sections and nothing before or after them:

# <the clank's name>

One paragraph that starts "You are" and says who the clank is and what it is for.

## How you work

A numbered list of the steps it follows on a ticket, in order. Name the tool to use at a step, in backticks, only from the tools you are given.

## Rules

A short bulleted list of what it must always or never do. Only rules that matter for this role.

## Output

How it finishes, and the fields to fill in.

Keep it under 450 words. Never mention a tool that is not in the list you are given. No secrets, no personal data, no placeholders.`;

/** The most a draft may take, thinking included. */
const DRAFT_TOKENS = 8000;

/** What the model is asked, for one clank. */
export function draftRequest(input: DraftInput): string {
  const maker = input.kind === 'maker';
  const finish = maker
    ? `It is a maker: it works its own tickets and finishes by calling \`submit_output\` with type \`${input.types[0] ?? 'doc'}\`, and \`title\`, \`body\`, \`criteria\` (each acceptance criterion with met or not met) and \`notes\`.`
    : `It is a checker: it reviews other clanks' ${input.types.join(', ') || 'work'} tickets and never fixes them. It finishes by calling \`review_pass\` with \`summary\`, \`criteria\` and \`notes\` when the ticket passes, or \`ticket_bounce\` to the clank that made it, with a numbered list of specific issues, when it does not.`;
  return [
    `Write the priming doc for a clank called ${input.name}, whose role is ${input.role}.`,
    '',
    `What it is for, in the user's words: ${input.description.trim()}`,
    '',
    finish,
    '',
    `Its tools: ${[...input.tools, 'post_progress', 'ask_user', 'ask_clank', 'ticket_bounce', 'fail', 'context_search', 'memory_write'].map((t) => `\`${t}\``).join(', ')}.`,
  ].join('\n');
}

/**
 * Drafts a custom clank's prompt from a line about what it's for, on the model Atlas runs on. The
 * user reads and edits it before anything is saved.
 */
export async function draftClankPrompt(
  providers: ProviderRegistry,
  choice: ModelChoice,
  input: DraftInput,
  signal: AbortSignal,
): Promise<string> {
  const request: ChatRequest = {
    model: choice.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: draftRequest(input) },
    ],
    temperature: 0.4,
    // Room to think first: a model that reasons can spend a couple of thousand tokens before it writes.
    maxTokens: DRAFT_TOKENS,
  };
  let text = '';
  for await (const event of providers.stream(choice.provider, request, signal)) {
    if (event.type === 'text') text += event.text;
  }
  if (!text.trim()) {
    throw new CrewDocError(
      `${choice.model} thought it over and wrote nothing. Try again, or write the prompt yourself from the template.`,
    );
  }
  return tidyDraft(text, input);
}

/** A model's reply as a doc body: without the code fence it may be wrapped in, or any comments. */
export function tidyDraft(reply: string, input: Pick<DraftInput, 'name' | 'kind'>): string {
  let text = stripComments(reply.replace(/\r\n?/g, '\n')).trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  // Frontmatter isn't the model's to write: the form does that.
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  const heading = text.search(/^# /m);
  if (heading > 0) text = text.slice(heading);
  if (!/^# /.test(text)) text = `# ${input.name}\n\n${text}`;
  const finish = input.kind === 'maker' ? 'submit_output' : 'review_pass';
  if (!text.includes(finish)) {
    text += `\n\n## Output\n\n${
      input.kind === 'maker'
        ? 'Call `submit_output` with `title`, `body`, `criteria` (each acceptance criterion with `met` or `not met`) and `notes`.'
        : 'Call `review_pass` with `summary`, `criteria` and `notes` when the ticket passes, or `ticket_bounce` with numbered issues when it does not.'
    }`;
  }
  return text;
}
