import type { ActivityEvent } from '@clanks/core';
import { headTail } from '@clanks/workspace';
import { and, asc, eq, gt } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { event } from '../store/schema';
import type { Db } from '../store/store';

/** What an event may keep of a tool's input or output. Command logs can be long. */
const MAX_FIELD = 256 * 1024;

/**
 * The activity log: every model call, tool call, checkpoint and review in a chat, append-only.
 * Emits `event` with each one as it's added.
 */
export class ActivityService extends EventEmitter<{ event: [ActivityEvent] }> {
  constructor(private readonly db: Db) {
    super();
    this.setMaxListeners(100);
  }

  append(entry: Omit<ActivityEvent, 'id' | 'image'> & { image?: string | null }): ActivityEvent {
    const values = {
      ...entry,
      image: entry.image ?? null,
      input: entry.input === null ? null : headTail(entry.input, MAX_FIELD),
      output: entry.output === null ? null : headTail(entry.output, MAX_FIELD),
    };
    const row = this.db.insert(event).values(values).returning().get();
    const appended = toEvent(row);
    this.emit('event', appended);
    return appended;
  }

  /** A chat's events in order, after `afterId` if given. */
  list(conversationId: string, afterId = 0): ActivityEvent[] {
    return this.db
      .select()
      .from(event)
      .where(and(eq(event.conversationId, conversationId), gt(event.id, afterId)))
      .orderBy(asc(event.id))
      .all()
      .map(toEvent);
  }
}

function toEvent(row: typeof event.$inferSelect): ActivityEvent {
  return { ...row, status: row.status ?? null };
}
