/** A request a stand-in service received. */
export interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export type Handler = (request: Seen) => Response | Promise<Response>;

/**
 * Stands in for the services integrations call: a `fetch` that answers from handlers by host, and
 * keeps every request it was sent. A host with no handler fails the way an unreachable one does.
 */
export function fakeApi(handlers: Record<string, Handler>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const request: Seen = {
      method: init?.method ?? 'GET',
      url,
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    };
    seen.push(request);
    const handler = handlers[url.host];
    if (!handler)
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') });
    return handler(request);
  };
  return { fetch: fake, seen };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
