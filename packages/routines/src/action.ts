/**
 * What an approved action is frozen as, and the checks made before it goes out. Pure, so the same
 * code words what the user approves and decides what the orchestrator may send.
 */

/** A file in a payload: `{ "$media": "<sha256>" }`, sent as its bytes in base64. */
export interface MediaMarker {
  $media: string;
}

export function isMediaMarker(value: unknown): value is MediaMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as MediaMarker).$media === 'string'
  );
}

/** Every file a payload names, by its sha256. */
export function mediaIn(payload: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (isMediaMarker(value)) found.push(value.$media);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
  };
  walk(payload);
  return [...new Set(found)];
}

/** A payload with each file marker replaced by what `read` gives for it. */
export function withMedia(payload: unknown, read: (sha256: string) => unknown): unknown {
  if (isMediaMarker(payload)) return read(payload.$media);
  if (Array.isArray(payload)) return payload.map((item) => withMedia(item, read));
  if (typeof payload === 'object' && payload !== null) {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, withMedia(value, read)]),
    );
  }
  return payload;
}

/** JSON with every object's keys in order, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Everything about an action that approving it freezes: what, where, as whom, and when. */
export interface FrozenAction {
  integrationId: string;
  operationId: string;
  connectionId: string | null;
  payload: Record<string, unknown> | null;
  /** The instant it goes out, in milliseconds. */
  executeAt: number;
  delivery: string;
}

/** What's hashed when an action is approved, and again before it's sent. */
export function frozenText(action: FrozenAction): string {
  return canonicalJson({
    integration: action.integrationId,
    operation: action.operationId,
    connection: action.connectionId,
    payload: action.payload,
    at: action.executeAt,
    delivery: action.delivery,
  });
}

/** How an attempt to send an action came out, as the service or the network said. */
export type AttemptOutcome =
  | { kind: 'sent' }
  /** The service turned it down for good: a 4xx. */
  | { kind: 'refused'; message: string }
  /** It may work if tried again: a 5xx, a rate limit, or no answer at all. */
  | { kind: 'transient'; message: string; reached: boolean };

/** Whether a status the service answered with is worth another try. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** How long to wait before the nth try, in milliseconds: 5s, 15s, 45s, then every two minutes. */
export function retryDelay(attempt: number): number {
  return Math.min(120_000, 5_000 * 3 ** Math.max(0, attempt - 1));
}

/**
 * What to do with an action whose time has come, given now. It goes out only inside its window:
 * from its time until the grace runs out. After that it's missed, whatever the policy, so a post
 * meant for the morning never goes out in the afternoon on its own.
 */
export function actionDue(
  action: { executeAt: number; graceMs: number },
  now: number,
): 'early' | 'due' | 'late' {
  if (now < action.executeAt) return 'early';
  return now <= action.executeAt + action.graceMs ? 'due' : 'late';
}

/**
 * Looks for a sent action in what a service's `verify` operation answered: something that lists
 * recent posts holds the words of one that went out. Only a distinctive string counts, so a
 * one-word post isn't "found" in an unrelated one.
 */
export function foundIn(payload: Record<string, unknown> | null, answer: unknown): boolean {
  if (!payload) return false;
  const haystack = typeof answer === 'string' ? answer : JSON.stringify(answer ?? '');
  const needles = Object.values(payload).filter(
    (value): value is string => typeof value === 'string' && value.trim().length >= 12,
  );
  if (needles.length === 0) return false;
  // What a service echoes back is JSON, where a line break or a quote is escaped.
  return needles.some(
    (needle) => haystack.includes(needle) || haystack.includes(JSON.stringify(needle).slice(1, -1)),
  );
}
