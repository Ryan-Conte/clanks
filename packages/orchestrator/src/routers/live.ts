/**
 * Yields a snapshot now, then again whenever something changes, at most every `intervalMs`
 * however busy it gets, until the window stops listening.
 */
export async function* snapshots<T>(options: {
  signal: AbortSignal | undefined;
  /** Calls `onChange` when the snapshot may be out of date. Returns how to stop. */
  subscribe: (onChange: () => void) => () => void;
  snapshot: () => T | Promise<T>;
  intervalMs: number;
}): AsyncGenerator<T> {
  const { signal } = options;
  let dirty = true;
  let wake: (() => void) | undefined;
  const onChange = () => {
    dirty = true;
    wake?.();
  };
  const unsubscribe = options.subscribe(onChange);
  signal?.addEventListener('abort', onChange, { once: true });
  try {
    while (!signal?.aborted) {
      if (!dirty) {
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        if (signal?.aborted) break;
      }
      dirty = false;
      yield await options.snapshot();
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', onChange);
  }
}

/**
 * Yields events as they're pushed, queued while the window catches up. `start` runs after
 * listening has begun, in the same tick, so nothing falls between a catch-up and the first event.
 */
export async function* stream<T>(options: {
  signal: AbortSignal | undefined;
  subscribe: (push: (event: T) => void) => () => void;
  start?: () => T[];
  /** Merges an event into the last queued one, so a slow window catches up in fewer steps. */
  merge?: (last: T, next: T) => boolean;
}): AsyncGenerator<T> {
  const { signal } = options;
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  const unsubscribe = options.subscribe((event) => {
    const last = queue.at(-1);
    if (last === undefined || !options.merge?.(last, event)) queue.push(event);
    wake?.();
  });
  const onAbort = () => wake?.();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    queue.unshift(...(options.start?.() ?? []));
    while (!signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
  }
}
