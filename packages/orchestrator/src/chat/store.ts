import type { Conversation, MessagePart, MessageRecord } from '@clanks/core';
import { and, asc, desc, eq, gt, max } from 'drizzle-orm';
import { conversation, message } from '../store/schema';
import type { Db } from '../store/store';

type MessageRow = typeof message.$inferSelect;

/** Parts come back from JSON with their times as strings. */
function reviveParts(parts: MessagePart[]): MessagePart[] {
  return parts.map((part) =>
    part.type === 'tool'
      ? {
          ...part,
          startedAt: part.startedAt ? new Date(part.startedAt) : null,
          endedAt: part.endedAt ? new Date(part.endedAt) : null,
        }
      : part,
  );
}

function toRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    ...(row.author ? { author: row.author } : {}),
    content: row.content,
    // Messages saved before tools are their text.
    parts: row.parts
      ? reviveParts(row.parts)
      : row.content
        ? [{ type: 'text', round: 0, text: row.content }]
        : [],
    reasoning: row.reasoning,
    status: row.status,
    error: row.error,
    model: row.provider && row.model ? { provider: row.provider, model: row.model } : null,
    usage: row.usage ?? null,
    finishReason: row.finishReason ?? null,
    createdAt: row.createdAt,
  };
}

/** Conversations and their messages, in SQLite. */
export class ChatStore {
  constructor(private readonly db: Db) {}

  conversations(): Conversation[] {
    return this.db.select().from(conversation).orderBy(desc(conversation.updatedAt)).all();
  }

  /** A project's chats and runs, newest first. */
  inProject(projectId: string): Conversation[] {
    return this.db
      .select()
      .from(conversation)
      .where(eq(conversation.projectId, projectId))
      .orderBy(desc(conversation.updatedAt))
      .all();
  }

  /** The runs on a ticket, oldest first. */
  forTicket(ticketId: string): Conversation[] {
    return this.db
      .select()
      .from(conversation)
      .where(eq(conversation.ticketId, ticketId))
      .orderBy(asc(conversation.createdAt))
      .all();
  }

  conversation(id: string): Conversation | undefined {
    return this.db.select().from(conversation).where(eq(conversation.id, id)).get();
  }

  insertConversation(value: Conversation): void {
    this.db.insert(conversation).values(value).run();
  }

  updateConversation(
    id: string,
    patch: Partial<Pick<Conversation, 'title' | 'folder' | 'updatedAt'>>,
  ): Conversation | undefined {
    this.db.update(conversation).set(patch).where(eq(conversation.id, id)).run();
    return this.conversation(id);
  }

  deleteConversation(id: string): void {
    // Messages, runs and events go with it: the foreign keys cascade.
    this.db.delete(conversation).where(eq(conversation.id, id)).run();
  }

  messages(conversationId: string): MessageRecord[] {
    return this.db
      .select()
      .from(message)
      .where(eq(message.conversationId, conversationId))
      .orderBy(asc(message.position))
      .all()
      .map(toRecord);
  }

  message(id: string): MessageRecord | undefined {
    const row = this.db.select().from(message).where(eq(message.id, id)).get();
    return row ? toRecord(row) : undefined;
  }

  lastMessage(conversationId: string): MessageRecord | undefined {
    const row = this.db
      .select()
      .from(message)
      .where(eq(message.conversationId, conversationId))
      .orderBy(desc(message.position))
      .limit(1)
      .get();
    return row ? toRecord(row) : undefined;
  }

  /** Adds a message after the conversation's last one. */
  appendMessage(record: MessageRecord): void {
    const position =
      (this.db
        .select({ last: max(message.position) })
        .from(message)
        .where(eq(message.conversationId, record.conversationId))
        .get()?.last ?? -1) + 1;
    this.db
      .insert(message)
      .values({
        id: record.id,
        conversationId: record.conversationId,
        position,
        role: record.role,
        author: record.author ?? null,
        content: record.content,
        parts: record.parts,
        reasoning: record.reasoning,
        status: record.status,
        error: record.error,
        provider: record.model?.provider ?? null,
        model: record.model?.model ?? null,
        usage: record.usage,
        finishReason: record.finishReason,
        createdAt: record.createdAt,
      })
      .run();
  }

  updateMessage(record: MessageRecord): void {
    this.db
      .update(message)
      .set({
        content: record.content,
        parts: record.parts,
        reasoning: record.reasoning,
        status: record.status,
        error: record.error,
        usage: record.usage,
        finishReason: record.finishReason,
      })
      .where(and(eq(message.id, record.id), eq(message.conversationId, record.conversationId)))
      .run();
  }

  deleteMessage(id: string): void {
    this.db.delete(message).where(eq(message.id, id)).run();
  }

  /** Deletes every message after one, for a rewind. Returns their ids. */
  deleteAfter(conversationId: string, messageId: string): string[] {
    const row = this.db.select().from(message).where(eq(message.id, messageId)).get();
    if (!row) return [];
    const later = this.db
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), gt(message.position, row.position)))
      .all()
      .map((r) => r.id);
    this.db
      .delete(message)
      .where(and(eq(message.conversationId, conversationId), gt(message.position, row.position)))
      .run();
    return later;
  }

  /** Replies a crash or quit cut off. Their text so far stays. */
  interrupted(): MessageRecord[] {
    return this.db
      .select()
      .from(message)
      .where(eq(message.status, 'streaming'))
      .all()
      .map(toRecord);
  }
}
