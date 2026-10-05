import type { Conversation, MessageRecord } from '@clanks/core';
import { and, asc, desc, eq, max } from 'drizzle-orm';
import { conversation, message } from '../store/schema';
import type { Db } from '../store/store';

type MessageRow = typeof message.$inferSelect;

function toRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
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
    // Messages go with it: the foreign key cascades.
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
        content: record.content,
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
