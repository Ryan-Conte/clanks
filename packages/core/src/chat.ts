import { z } from 'zod';

/** A tool the model may call, described by a JSON schema for its arguments. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them: JSON text, not yet validated. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export const chatMessageSchema: z.ZodType<ChatMessage> = z.union([
  z.object({ role: z.enum(['system', 'user']), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z
      .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
      .optional(),
  }),
  z.object({ role: z.literal('tool'), toolCallId: z.string(), content: z.string() }),
]);

export interface ChatRequest {
  /** The model's id at its provider. For the built-in runtime, a pulled model's id. */
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** Generation speed, when the provider reports it. */
  tokensPerSecond: number | null;
  promptTokensPerSecond: number | null;
  durationMs: number;
}

/** `refusal`: the provider's safety checks declined to answer. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'cancelled' | 'refusal';

/** What a provider streams back. Exactly one `done` ends a successful stream. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'done'; finishReason: FinishReason };
