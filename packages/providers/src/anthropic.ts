import Anthropic from '@anthropic-ai/sdk';
import type { ChatEvent, ChatMessage, ChatRequest, FinishReason, ToolCall } from '@clanks/core';
import { type ModelInfo, type Provider, ProviderError, messageOf } from './provider';

const LIST_TTL_MS = 5 * 60_000;

/** A reply's cap when the model's own isn't known. Streaming, so a big cap costs nothing unused. */
const DEFAULT_MAX_TOKENS = 32_000;
const MAX_TOKENS = 64_000;

interface AnthropicModel extends ModelInfo {
  maxOutput: number | null;
  adaptiveThinking: boolean;
}

/** Claude, through Anthropic's official SDK and the user's own key. */
export function createAnthropicProvider(options: {
  apiKey: () => string | undefined;
  baseURL?: string;
  fetch?: typeof fetch;
}): Provider {
  let listed: { key: string; at: number; models: AnthropicModel[] } | null = null;

  const client = (): { client: Anthropic; key: string } => {
    const key = options.apiKey();
    if (!key) throw new ProviderError('Add an Anthropic API key in Settings to use Claude');
    return {
      key,
      client: new Anthropic({
        apiKey: key,
        maxRetries: 2,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    };
  };

  const list = async (signal?: AbortSignal): Promise<AnthropicModel[]> => {
    const { client: anthropic, key } = client();
    if (listed && listed.key === key && Date.now() - listed.at < LIST_TTL_MS) return listed.models;
    const models: AnthropicModel[] = [];
    try {
      for await (const model of anthropic.models.list({}, { ...(signal ? { signal } : {}) })) {
        const caps = model.capabilities;
        models.push({
          id: model.id,
          title: model.display_name,
          capabilities: {
            tools: true,
            vision: caps?.image_input.supported ?? true,
            reasoning: caps?.thinking.supported ?? false,
          },
          contextWindow: model.max_input_tokens ?? 0,
          maxOutput: model.max_tokens,
          adaptiveThinking: caps?.thinking.types.adaptive.supported ?? false,
        });
      }
    } catch (error) {
      throw explain(error, null);
    }
    listed = { key, at: Date.now(), models };
    return models;
  };

  return {
    id: 'anthropic',

    listModels: (signal) => list(signal),

    capabilities(model) {
      const info = listed?.models.find((m) => m.id === model);
      return {
        tools: true,
        vision: info?.capabilities.vision ?? true,
        contextWindow: info?.contextWindow ?? 0,
      };
    },

    async *stream(request, signal) {
      const { client: anthropic } = client();
      // What the model can take decides the request's shape. A listing that fails here isn't
      // fatal: the request goes without the extras.
      const info = await list(signal)
        .then((models) => models.find((m) => m.id === request.model))
        .catch(() => undefined);
      yield* streamMessage(anthropic, request, info, signal);
    },
  };
}

async function* streamMessage(
  client: Anthropic,
  request: ChatRequest,
  info: AnthropicModel | undefined,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const started = Date.now();
  const { system, messages } = toAnthropic(request.messages);
  const maxTokens =
    request.maxTokens ?? Math.min(MAX_TOKENS, info?.maxOutput ?? DEFAULT_MAX_TOKENS);
  const params: Anthropic.MessageStreamParams = {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
    // Current models think adaptively and hide it unless asked; a summary shows the user what
    // the clank is weighing up. Older models without adaptive thinking answer straight away.
    ...(info?.adaptiveThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    // No temperature: current models only take their default, and refuse any other value.
    // The system prompt and history repeat every turn, so cache them.
    cache_control: { type: 'ephemeral' },
  };

  let firstToken: number | null = null;
  let message: Anthropic.Message;
  try {
    const stream = client.messages.stream(params, { signal });
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        firstToken ??= Date.now();
        yield { type: 'text', text: event.delta.text };
      } else if (event.delta.type === 'thinking_delta') {
        firstToken ??= Date.now();
        yield { type: 'reasoning', text: event.delta.thinking };
      }
    }
    message = await stream.finalMessage();
  } catch (error) {
    if (signal.aborted || error instanceof Anthropic.APIUserAbortError) {
      yield { type: 'done', finishReason: 'cancelled' };
      return;
    }
    throw explain(error, request.model);
  }

  const calls: ToolCall[] = message.content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }));
  for (const call of calls) yield { type: 'tool_call', call };

  const { usage } = message;
  const ended = Date.now();
  yield {
    type: 'usage',
    usage: {
      promptTokens:
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      completionTokens: usage.output_tokens,
      tokensPerSecond:
        firstToken !== null && ended > firstToken
          ? usage.output_tokens / ((ended - firstToken) / 1000)
          : null,
      promptTokensPerSecond: null,
      durationMs: ended - started,
    },
  };
  yield { type: 'done', finishReason: finishReason(message.stop_reason, calls.length > 0) };
}

/**
 * The conversation as the Messages API takes it: system text apart, tool results as user turns.
 * Earlier replies go back as text only. Their thinking isn't kept, which the API accepts: a
 * history with no thinking blocks has none to check.
 */
function toAnthropic(history: ChatMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const system: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  for (const message of history) {
    switch (message.role) {
      case 'system':
        system.push(message.content);
        break;
      case 'user': {
        // Feedback that follows tool results joins their turn, since turns must alternate.
        const last = messages.at(-1);
        if (last?.role === 'user' && Array.isArray(last.content)) {
          last.content.push({ type: 'text', text: message.content });
        } else {
          messages.push({ role: 'user', content: message.content });
        }
        break;
      }
      case 'assistant': {
        const content: Anthropic.ContentBlockParam[] = [];
        // Empty text blocks are refused.
        if (message.content) content.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseInput(call) });
        }
        if (content.length > 0) messages.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        const result: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        };
        // Every result of one round goes back in a single user turn.
        const last = messages.at(-1);
        if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(result);
        else messages.push({ role: 'user', content: [result] });
        break;
      }
    }
  }
  return { system: system.join('\n\n'), messages };
}

function parseInput(call: ToolCall): unknown {
  try {
    return JSON.parse(call.arguments || '{}');
  } catch {
    return {};
  }
}

function finishReason(reason: Anthropic.StopReason | null, calledTools: boolean): FinishReason {
  if (calledTools || reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'refusal') return 'refusal';
  return 'stop';
}

/** An SDK error, worded for the user. */
function explain(error: unknown, model: string | null): ProviderError {
  if (error instanceof ProviderError) return error;
  const detail =
    error instanceof Anthropic.APIError
      ? ((error.error as { error?: { message?: string } } | undefined)?.error?.message ??
        error.message)
      : messageOf(error);
  let text: string;
  if (error instanceof Anthropic.AuthenticationError) {
    text = 'Anthropic rejected the API key. Check it in Settings.';
  } else if (error instanceof Anthropic.PermissionDeniedError) {
    text = `This Anthropic key can't do that: ${detail}`;
  } else if (error instanceof Anthropic.NotFoundError && model) {
    text = `Anthropic has no model called ${model}.`;
  } else if (error instanceof Anthropic.RateLimitError) {
    text = 'Anthropic is rate limiting this key. Try again in a minute.';
  } else if (error instanceof Anthropic.APIConnectionError) {
    text = `Couldn't reach Anthropic: ${detail}`;
  } else if (error instanceof Anthropic.APIError) {
    text = `Anthropic answered HTTP ${error.status ?? '?'}: ${detail}`;
  } else {
    text = `The reply was cut off: ${detail}`;
  }
  return new ProviderError(text, { cause: error });
}
