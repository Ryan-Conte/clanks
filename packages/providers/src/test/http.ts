import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { onTestFinished } from 'vitest';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
}

type Handler = (request: Recorded, res: ServerResponse) => void;

/** A stand-in for a provider's API on 127.0.0.1, closed after the test. */
export async function fakeApi(handler: Handler) {
  const requests: Recorded[] = [];
  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (data: Buffer) => (raw += data.toString()));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests };
}

export function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Server-sent events: `data` lines, with an `event` name when the API uses them. */
export function sse(
  res: ServerResponse,
  /** Each is sent as `data`, or as a named event when it's `{ event, data }`. */
  events: unknown[],
  { done = false, end = true } = {},
) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const item of events) {
    if (item && typeof item === 'object' && 'event' in item && 'data' in item) {
      res.write(`event: ${item.event as string}\ndata: ${JSON.stringify(item.data)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify(item)}\n\n`);
    }
  }
  if (done) res.write('data: [DONE]\n\n');
  if (end) res.end();
}

export async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}
