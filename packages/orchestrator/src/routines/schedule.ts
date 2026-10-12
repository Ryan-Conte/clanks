import type { ChatRequest, ModelChoice } from '@clanks/core';
import type { ProviderRegistry } from '@clanks/providers';
import { localStamp } from '@clanks/routines';

const SYSTEM = `You turn a schedule written in plain words into one line a scheduler can read. Reply with that line only, nothing before or after it.

For something that repeats, reply with a five-field cron expression: minute hour day-of-month month day-of-week. Days of the week are 0 to 6 with Sunday as 0. \`L\` in the day of the month is the month's last day. \`2#2\` in the day of the week is the second Tuesday, and \`5L\` the last Friday.

For something that happens once, reply with its date and time as YYYY-MM-DDTHH:MM, in the time zone you are given.

If the words name no time of day, use 09:00. If they are not a schedule at all, reply with the one word: none.`;

/** The most a reading may take, thinking included. */
const READ_TOKENS = 4000;

/**
 * Has a model read a schedule the app's own reader doesn't know, such as "every other Tuesday
 * afternoon". Resolves with a cron expression or a date and time, which the app then checks and
 * shows back in words before anything is saved, or null when the model can't say.
 */
export async function readScheduleWithModel(
  providers: ProviderRegistry,
  choice: ModelChoice,
  input: { words: string; zone: string; now: Date },
  signal: AbortSignal,
): Promise<string | null> {
  const request: ChatRequest = {
    model: choice.model,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `It is ${localStamp(input.now, input.zone)} in ${input.zone}, a ${new Intl.DateTimeFormat('en-GB', { timeZone: input.zone, weekday: 'long' }).format(input.now)}.\n\nThe schedule: ${input.words.trim()}`,
      },
    ],
    temperature: 0,
    maxTokens: READ_TOKENS,
  };
  let text = '';
  for await (const event of providers.stream(choice.provider, request, signal)) {
    if (event.type === 'text') text += event.text;
  }
  // The line itself, whatever it was wrapped in.
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[`*"']/g, '').trim())
    .filter(Boolean)
    .at(-1);
  if (!line || /^none\b/i.test(line)) return null;
  return line.slice(0, 120);
}
