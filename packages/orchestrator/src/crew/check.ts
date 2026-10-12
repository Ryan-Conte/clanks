import { ALWAYS_AVAILABLE_TOOLS, estimateTokens, looksSecret, toolsMatching } from '@clanks/core';
import { type ClankDoc, CrewDocError } from './docs';

/** The most a custom clank's prompt may come to with the crew rules, in tokens. */
const MAX_CUSTOM_TOKENS = 6000;
/** What the shipped docs stay under, so they fit small local models. */
export const DOC_TOKEN_BUDGET = 2500;

/**
 * What a clank's doc must get right before it joins a library or a marketplace: every tool it
 * names is real, it can make its finishing call and says so, nothing in it looks like a secret,
 * and its prompt fits. `rules` is CREW.md, which every prompt starts with.
 */
export function checkCustomDoc(doc: ClankDoc, rules: string): void {
  const { tools, workflow } = doc.frontmatter;
  const listed = [...tools.allow, ...tools.ask, ...tools.deny];
  const unknown = listed.filter(
    (entry) => toolsMatching(entry).length === 0 && !/^(mcp|int)_[a-z0-9_]+\*?$/.test(entry),
  );
  if (unknown.length > 0) {
    throw new CrewDocError(
      `${unknown.join(', ')} ${unknown.length === 1 ? "isn't a tool" : "aren't tools"}. Use names from the tool list, or a group such as browser_*.`,
    );
  }
  const given = new Set<string>([
    ...ALWAYS_AVAILABLE_TOOLS,
    ...[...tools.allow, ...tools.ask].flatMap(toolsMatching),
  ]);
  const finish = workflow.kind === 'maker' ? 'submit_output' : 'review_pass';
  if (!given.has(finish)) {
    throw new CrewDocError(
      'A checker passes tickets with review_pass, so its tools must allow it. Add review_pass to its tools.',
    );
  }
  if (!doc.body.includes(finish)) {
    throw new CrewDocError(
      `The prompt never says how to finish. Tell it to call \`${finish}\` when ${workflow.kind === 'maker' ? 'its work is done, and what to put in it' : 'the ticket passes, and `ticket_bounce` when it does not'}.`,
    );
  }
  if (looksSecret(doc.body)) {
    throw new CrewDocError(
      'The prompt has something that looks like a password or key in it. Take it out: prompts go to the model, and to anyone you share the clank with.',
    );
  }
  const tokens = estimateTokens(rules) + estimateTokens(doc.body);
  if (tokens > MAX_CUSTOM_TOKENS) {
    throw new CrewDocError(
      `With the crew rules the prompt comes to about ${tokens} tokens. Keep it under ${MAX_CUSTOM_TOKENS}; under ${DOC_TOKEN_BUDGET} fits small local models.`,
    );
  }
}
