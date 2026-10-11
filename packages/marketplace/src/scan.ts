import { looksSecret } from '@clanks/core';

/** What a scan of something about to be published found. */
export interface ScanResult {
  /** Things that must come out first. */
  problems: string[];
  /** Things worth a second look: they may be meant. */
  warnings: string[];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** Addresses that are plainly placeholders. */
const EXAMPLE_EMAIL = /@(example\.(com|org|net)|.*\.example|localhost)$/i;
const HOME_PATH = /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)([^\\/\s"'`<>]+)/g;
const PHONE = /(?<![\w.])\+?\d[\d\s().-]{8,16}\d(?!\w|\.\w)/g;

/**
 * Looks through text that's about to be published for anyone to read: a secret must come out, a
 * path into someone's home folder gives away their account's name, and an address, a phone number
 * or the publisher's own name is flagged in case it wasn't meant.
 */
export function scanForPublishing(
  text: string,
  options: { what: string; names?: string[] } = { what: 'It' },
): ScanResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { what } = options;
  if (looksSecret(text)) {
    problems.push(
      `${what} has something that looks like a password, key or token in it. Take it out: once published, anyone can read it.`,
    );
  }
  const homes = new Set<string>();
  for (const match of text.matchAll(HOME_PATH)) {
    const name = match[1]!;
    if (!/^(you|user|username|name|me|<.*>|\{.*\}|\$\w+|%\w+%)$/i.test(name)) homes.add(match[0]);
  }
  if (homes.size > 0) {
    problems.push(
      `${what} has a path into a home folder (${[...homes].slice(0, 3).join(', ')}), which names an account on a computer. Use a path inside the project instead.`,
    );
  }
  const emails = new Set(
    [...text.matchAll(EMAIL)].map((m) => m[0]).filter((email) => !EXAMPLE_EMAIL.test(email)),
  );
  if (emails.size > 0) {
    warnings.push(
      `${what} has ${emails.size === 1 ? 'an email address' : 'email addresses'} in it: ${[...emails].slice(0, 5).join(', ')}.`,
    );
  }
  const phones = new Set(
    [...text.matchAll(PHONE)]
      .map((m) => m[0].trim())
      // Dates, versions and long ids aren't phone numbers.
      .filter((p) => !/^\d{4}-\d{2}-\d{2}/.test(p) && p.replace(/\D/g, '').length <= 15)
      .filter((p) => /[\s().+-]/.test(p)),
  );
  if (phones.size > 0) {
    warnings.push(
      `${what} has what may be ${phones.size === 1 ? 'a phone number' : 'phone numbers'} in it: ${[...phones].slice(0, 3).join(', ')}.`,
    );
  }
  for (const name of options.names ?? []) {
    const trimmed = name.trim();
    if (trimmed.length < 3) continue;
    const pattern = new RegExp(
      `(?<![\\w])${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`,
      'i',
    );
    if (pattern.test(text)) {
      warnings.push(`${what} has your name, "${trimmed}", in it.`);
    }
  }
  return { problems, warnings };
}
