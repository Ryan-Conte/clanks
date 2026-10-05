import { z } from 'zod';
import type { ChatUsage, FinishReason } from './chat';
import { type ClankId, clankIdSchema } from './crew';
import type { ModelChoice } from './providers';

/** A chat with one clank. */
export interface Conversation {
  id: string;
  clankId: ClankId;
  title: string;
  /**
   * A folder the chat is about. The clank follows its `CLANKS.md`, or `AGENTS.md`, as project
   * instructions. Projects take this over when they arrive.
   */
  folder: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationSummary extends Conversation {
  /** A reply is being written right now. */
  replying: boolean;
}

export type MessageStatus = 'streaming' | 'done' | 'cancelled' | 'failed';

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  /** What a thinking model thought before it answered. Shown folded, never sent back to it. */
  reasoning: string;
  status: MessageStatus;
  error: string | null;
  /** For replies: the model that wrote it. */
  model: ModelChoice | null;
  usage: ChatUsage | null;
  finishReason: FinishReason | null;
  createdAt: Date;
}

/** What a chat's live subscription sends as a reply is written. */
export type ChatLiveEvent =
  /** A message was added or changed. Sent whole. */
  | { type: 'message'; message: MessageRecord }
  /** More of a reply arrived. */
  | { type: 'delta'; messageId: string; text: string; reasoning: string }
  | { type: 'removed'; messageId: string }
  | { type: 'conversation'; conversation: Conversation };

export const conversationIdSchema = z.uuid();

export const newConversationSchema = z.object({
  clankId: clankIdSchema,
  /** The first message, so a chat is only saved once there's something in it. */
  text: z.string().trim().min(1).max(200_000),
});

export const sendMessageSchema = z.object({
  conversationId: conversationIdSchema,
  text: z.string().trim().min(1).max(200_000),
});
