import { z } from 'zod';
import type { RunRole } from './board';
import type { ChatUsage, FinishReason } from './chat';
import { type ClankId, clankIdSchema } from './crew';
import type { IntegrationApproval } from './integrations';
import type { ModelChoice } from './providers';

/**
 * A chat with one clank. A chat in a project is about the project's workspace and can use its
 * board. A run is the conversation a clank works a ticket in, which the app starts.
 */
export interface Conversation {
  id: string;
  clankId: ClankId;
  title: string;
  /**
   * A folder the chat is about. The clank follows its `CLANKS.md`, or `AGENTS.md`, as project
   * instructions, and works on a copy of it. In a project, it's the project's workspace.
   */
  folder: string | null;
  projectId: string | null;
  /** For a run: the ticket it works, or the spec ticket it plans from. */
  ticketId: string | null;
  /** For a run: what the clank is doing in it. Null for a chat. */
  role: RunRole | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationSummary extends Conversation {
  /** A reply is being written right now. */
  replying: boolean;
  /** The reply is waiting for the user to approve a tool call. */
  asking: boolean;
}

export type MessageStatus = 'streaming' | 'done' | 'cancelled' | 'failed';

export type ToolCallStatus =
  'pending' | 'asking' | 'running' | 'done' | 'failed' | 'denied' | 'cancelled';

/** What an approval prompt shows, and what "always allow" would cover. */
export interface ToolApproval {
  /** What the call would do, as the user reads it: a command, a URL or a path. */
  subject: string;
  kind: 'command' | 'url' | 'path' | 'tool';
  /** What "always allow" would match, which the user can widen with `*`. */
  pattern: string;
  /** The project an "always allow" applies to. Null when there's none to remember it in. */
  scope: string | null;
  /** Why it asks: what makes this call risky. Missing for a tool that always asks. */
  reason?: string | null;
  /** For a call to a connected service: which account, and whether it's a test or the real one. */
  integration?: IntegrationApproval;
}

/** Text the model wrote. `round` counts the model's turns within one reply. */
export interface TextPart {
  type: 'text';
  round: number;
  text: string;
}

/** A tool call and what came of it. */
export interface ToolPart {
  type: 'tool';
  round: number;
  /** The call's id, from the model. */
  id: string;
  name: string;
  /** As the model wrote them. */
  arguments: string;
  /** One line for the chat and the board: "Running `npm test`". */
  label: string;
  status: ToolCallStatus;
  /** Set when the call needed the user's approval. */
  approval: ToolApproval | null;
  /**
   * What let it run, or stopped it: the clank's policy, an "always allow" rule, the user, or its
   * being an everyday call that didn't need asking about.
   */
  decidedBy: 'policy' | 'rule' | 'user' | 'risk' | null;
  /** Why the user said no, if they said. */
  reason: string | null;
  /** What the model got back. */
  result: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The checkpoint taken after it changed files. */
  checkpointId: string | null;
  /** The terminal session it ran in, for commands. */
  sessionId: string | null;
  /**
   * A picture of what it saw, such as the page after a browser step, in the chat's artifacts.
   * Missing on calls saved before pictures were kept.
   */
  image?: string | null;
}

/** Something the app says in a reply, which the model never sees: "Rewound here." */
export interface NotePart {
  type: 'note';
  round: number;
  text: string;
}

/**
 * Feedback the user gave in the diff editor while the reply was being written. The clank got it,
 * as a message from the user, after this round's tool calls.
 */
export interface FeedbackPart {
  type: 'feedback';
  round: number;
  text: string;
}

/** A picture the user put in their message: a screenshot they pasted, or a photo. */
export interface ImagePart {
  type: 'image';
  round: number;
  /** Where it's kept, in the chat's artifacts, as a tool call's picture is. */
  image: string;
  /** Its file's name when it had one, to tell pictures apart. */
  name: string;
}

export type MessagePart = TextPart | ToolPart | NotePart | FeedbackPart | ImagePart;

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  /**
   * `app` for a user turn the app wrote for the clank, such as a ticket brief or a bounce, rather
   * than the user. Missing on the user's own messages.
   */
  author?: 'app';
  /** All of the message's text, for copying and for the model. */
  content: string;
  /** The text, tool calls and notes in order. A user message is one text part. */
  parts: MessagePart[];
  /** What a thinking model thought before it answered. Shown folded, never sent back to it. */
  reasoning: string;
  status: MessageStatus;
  error: string | null;
  /** For replies: the model that wrote it. */
  model: ModelChoice | null;
  /** For replies: every model call in it, added up. */
  usage: ChatUsage | null;
  finishReason: FinishReason | null;
  createdAt: Date;
}

/** What a chat's live subscription sends as a reply is written. */
export type ChatLiveEvent =
  /** A message was added or changed. Sent whole. */
  | { type: 'message'; message: MessageRecord }
  /** More of a reply arrived. Text goes on the reply's last text part for its round. */
  | { type: 'delta'; messageId: string; round: number; text: string; reasoning: string }
  /** A tool call was added or changed. `index` is its place in the reply's parts. */
  | { type: 'part'; messageId: string; index: number; part: MessagePart }
  | { type: 'removed'; messageId: string }
  | { type: 'conversation'; conversation: Conversation };

/** A message's text: its text parts, joined. */
export function textOf(parts: MessagePart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

export const conversationIdSchema = z.uuid();

/** How many pictures one message carries. Each costs a model about a page of text. */
export const MAX_MESSAGE_IMAGES = 4;

/**
 * The most pixels a picture is sent with. The window scales a bigger one down before it sends it:
 * a local model takes about a megapixel, and more than that has taken its server down.
 */
export const MESSAGE_IMAGE_PIXELS = 1_000_000;

/** A picture as the window sends it with a message. */
export const messageImageSchema = z.object({
  name: z.string().trim().max(200).default(''),
  mediaType: z.enum(['image/jpeg', 'image/png']),
  /** Base64, already scaled down. */
  data: z
    .string()
    .min(1)
    .max(8_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "That isn't a picture"),
});

export type MessageImage = z.infer<typeof messageImageSchema>;

const messageImagesSchema = z.array(messageImageSchema).max(MAX_MESSAGE_IMAGES).default([]);

/** A message says something or shows something: its words can be empty when it has a picture. */
const said = (message: { text: string; images: MessageImage[] }) =>
  message.text !== '' || message.images.length > 0;

export const newConversationSchema = z
  .object({
    clankId: clankIdSchema,
    /** The first message, so a chat is only saved once there's something in it. */
    text: z.string().trim().max(200_000),
    /** Pictures that go with it. */
    images: messageImagesSchema,
    /** A folder for the chat to be about from the start. */
    folder: z.string().min(1).max(4096).nullable().optional(),
    /** A project for the chat to be in, whose workspace it's about. */
    projectId: z.uuid().nullable().optional(),
  })
  .refine(said, 'Write something, or add a picture');

export const sendMessageSchema = z
  .object({
    conversationId: conversationIdSchema,
    text: z.string().trim().max(200_000),
    images: messageImagesSchema,
  })
  .refine(said, 'Write something, or add a picture');

export const approvalDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow') }),
  /** Allow it, and every call matching `pattern` in this project from now on. */
  z.object({ decision: z.literal('always'), pattern: z.string().trim().min(1).max(2000) }),
  z.object({ decision: z.literal('deny'), reason: z.string().trim().max(2000).optional() }),
]);

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
