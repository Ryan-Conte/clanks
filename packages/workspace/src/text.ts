import { createHash } from 'node:crypto';

/** Colours and cursor movement, which a terminal draws and a model only stumbles over. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Terminal output as plain text: no escape codes, and a carriage return keeps only what it left. */
export function plainOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      // A progress bar redraws its line with \r; only the last drawing counts.
      const drawn = line.split('\r');
      return drawn.at(-1) || drawn.findLast((d) => d !== '') || '';
    })
    .join('\n');
}

/**
 * Text cut to about `max` characters, keeping the start and the end, which is where the command,
 * the errors and the summary usually are. Says how much was cut.
 */
export function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  const cutLines = text.slice(head, text.length - tail).split('\n').length - 1;
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters${cutLines ? `, about ${cutLines} lines,` : ''} cut from the middle …]\n\n${text.slice(text.length - tail)}`;
}

/** Text cut at a line break before `max` characters, saying it was. */
export function headOnly(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return `${text.slice(0, cut > max / 2 ? cut : max)}\n\n[${note}]`;
}

/** Text files don't have NUL bytes; nearly every binary format does, early on. */
export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
