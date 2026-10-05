import {
  type ChatLiveEvent,
  type ChatMessage,
  type Conversation,
  type ConversationSummary,
  type GgufFacts,
  type MessageRecord,
  type ModelChoice,
  type Settings,
  estimateTokens,
} from '@clanks/core';
import { BUILTIN_PROVIDER, ProviderError, type ProviderRegistry } from '@clanks/providers';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CrewService } from '../crew/crew';
import { readProjectInstructions } from '../crew/instructions';
import { type AssembledPrompt, assemblePrompt } from '../crew/prompt';
import type { ChatStore } from './store';

/** A chat problem worded for the user, such as no model to run on. */
export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface ChatServiceOptions {
  store: ChatStore;
  crew: CrewService;
  providers: ProviderRegistry;
  /** Which providers are set up, and what they report about their models. */
  providerInfo: {
    isConfigured(provider: string): boolean;
    name(provider: string): string;
    contextWindow(choice: ModelChoice): number;
  };
  settings: { get(): Settings };
  /** Pulled models, for the crew's model and how much context each gets. */
  library: () => { id: string; facts: GgufFacts; missing: boolean }[];
  now?: () => Date;
  platform?: NodeJS.Platform;
  /** How often a reply being written is saved, so a crash keeps most of it. */
  flushMs?: number;
}

interface Run {
  controller: AbortController;
  message: MessageRecord;
  done: Promise<void>;
}

/** The longest reply a local model is asked for: room enough for thinking and a long answer. */
const LOCAL_MAX_REPLY = 16_384;
/** History gets this share of the context window; the rest is for the reply. */
const HISTORY_SHARE = 0.75;
/** Context to assume when a provider doesn't say. */
const DEFAULT_CLOUD_CONTEXT = 128_000;
const DEFAULT_SERVER_CONTEXT = 32_768;

/**
 * Chats with clanks. Replies are written here in the orchestrator, not in the window, so closing
 * or reloading the window never cuts one off. Emits `live` with each conversation's events and
 * `list` when the list of conversations changes.
 */
export class ChatService extends EventEmitter<{
  live: [conversationId: string, event: ChatLiveEvent];
  list: [];
}> {
  private readonly runs = new Map<string, Run>();
  private readonly store: ChatStore;
  private closed = false;

  constructor(private readonly options: ChatServiceOptions) {
    super();
    this.store = options.store;
    this.setMaxListeners(100);
  }

  /** Replies a quit or crash cut off are marked as such, with what they'd written kept. */
  recover(): void {
    for (const message of this.store.interrupted()) {
      this.store.updateMessage({
        ...message,
        status: 'failed',
        error: 'clanks closed before this reply finished.',
      });
    }
  }

  list(): ConversationSummary[] {
    return this.store.conversations().map((c) => ({ ...c, replying: this.runs.has(c.id) }));
  }

  get(id: string): { conversation: ConversationSummary; messages: MessageRecord[] } {
    const conversation = this.require(id);
    // A reply being written is ahead of what's saved.
    const live = this.runs.get(id)?.message;
    const messages = this.store.messages(id).map((m) => (live?.id === m.id ? { ...live } : m));
    return { conversation: { ...conversation, replying: live !== undefined }, messages };
  }

  /** The reply being written in a conversation right now, as far as it's got. */
  inFlight(id: string): MessageRecord | null {
    const run = this.runs.get(id);
    return run ? { ...run.message } : null;
  }

  /** Starts a chat with its first message, so empty chats never pile up. */
  start(clankId: string, text: string): { conversation: Conversation; reply: MessageRecord } {
    const clank = this.options.crew.get(clankId);
    const choice = this.modelFor(clank.id);
    const now = this.now();
    const conversation: Conversation = {
      id: randomUUID(),
      clankId: clank.id,
      title: titleFrom(text),
      folder: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertConversation(conversation);
    this.appendUser(conversation.id, text);
    const reply = this.reply(conversation, choice);
    this.emit('list');
    return { conversation, reply };
  }

  send(conversationId: string, text: string): MessageRecord {
    const conversation = this.require(conversationId);
    this.assertIdle(conversationId);
    const choice = this.modelFor(conversation.clankId);
    this.appendUser(conversationId, text);
    const updated = this.store.updateConversation(conversationId, { updatedAt: this.now() })!;
    const reply = this.reply(updated, choice);
    this.emit('list');
    return reply;
  }

  /** Writes the last reply again, or a reply to a message that never got one. */
  retry(conversationId: string): MessageRecord {
    const conversation = this.require(conversationId);
    this.assertIdle(conversationId);
    const choice = this.modelFor(conversation.clankId);
    const last = this.store.lastMessage(conversationId);
    if (!last) throw new ChatError('There is nothing to answer yet');
    if (last.role === 'assistant') {
      this.store.deleteMessage(last.id);
      this.emit('live', conversationId, { type: 'removed', messageId: last.id });
    }
    const reply = this.reply(conversation, choice);
    this.emit('list');
    return reply;
  }

  stop(conversationId: string): void {
    this.runs.get(conversationId)?.controller.abort();
  }

  rename(conversationId: string, title: string): Conversation {
    this.require(conversationId);
    const updated = this.store.updateConversation(conversationId, { title: title.trim() })!;
    this.emit('live', conversationId, { type: 'conversation', conversation: updated });
    this.emit('list');
    return updated;
  }

  /** Points the chat at a folder, whose CLANKS.md or AGENTS.md the clank then follows. */
  setFolder(conversationId: string, folder: string | null): Conversation {
    this.require(conversationId);
    let path: string | null = null;
    if (folder !== null) {
      path = resolve(folder);
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        // Missing: reported below.
      }
      if (!isDirectory) throw new ChatError(`${path} isn't a folder`);
    }
    const updated = this.store.updateConversation(conversationId, { folder: path })!;
    this.emit('live', conversationId, { type: 'conversation', conversation: updated });
    this.emit('list');
    return updated;
  }

  async delete(conversationId: string): Promise<void> {
    const run = this.runs.get(conversationId);
    if (run) {
      run.controller.abort();
      await run.done;
    }
    this.store.deleteConversation(conversationId);
    this.emit('list');
  }

  /** What the clank in a conversation would be told right now: its assembled system prompt. */
  preview(clankId: string, conversationId: string | null): AssembledPrompt {
    const folder = conversationId ? this.require(conversationId).folder : null;
    return this.prompt(clankId, folder);
  }

  /**
   * Stops every reply at once, for quitting, and saves each as far as it got: the database closes
   * straight after, so nothing can wait.
   */
  close(): void {
    this.closed = true;
    for (const run of this.runs.values()) {
      run.controller.abort();
      this.store.updateMessage({ ...run.message, status: 'cancelled', finishReason: 'cancelled' });
    }
  }

  /** The model a clank runs on: its own, or the crew's. */
  modelFor(clankId: string): ModelChoice {
    const clank = this.options.crew.get(clankId);
    const own = clank.overrides.model;
    if (own) {
      if (own.provider === BUILTIN_PROVIDER) this.requirePulled(own.model, clank.name);
      else if (!this.options.providerInfo.isConfigured(own.provider)) {
        throw new ChatError(
          `${clank.name} runs on ${own.model} at ${this.options.providerInfo.name(own.provider)}, which isn't set up. Add its key in Settings, or give ${clank.name} another model.`,
        );
      }
      return own;
    }
    const crewModel = this.options.settings.get().crewModel;
    if (!crewModel) {
      throw new ChatError('Pick a model for the crew on the Models screen first.');
    }
    this.requirePulled(crewModel, 'the crew');
    return { provider: BUILTIN_PROVIDER, model: crewModel };
  }

  private requirePulled(model: string, who: string): void {
    const found = this.options.library().find((m) => m.id === model);
    if (!found || found.missing) {
      throw new ChatError(
        `${model} isn't pulled any more. Pull it again, or pick another model for ${who}.`,
      );
    }
  }

  private appendUser(conversationId: string, text: string): MessageRecord {
    const message: MessageRecord = {
      id: randomUUID(),
      conversationId,
      role: 'user',
      content: text.trim(),
      reasoning: '',
      status: 'done',
      error: null,
      model: null,
      usage: null,
      finishReason: null,
      createdAt: this.now(),
    };
    this.store.appendMessage(message);
    this.emit('live', conversationId, { type: 'message', message });
    return message;
  }

  /** Starts writing a reply, and returns it as it starts. */
  private reply(conversation: Conversation, choice: ModelChoice): MessageRecord {
    const history = this.store.messages(conversation.id);
    const message: MessageRecord = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      reasoning: '',
      status: 'streaming',
      error: null,
      model: choice,
      usage: null,
      finishReason: null,
      createdAt: this.now(),
    };
    this.store.appendMessage(message);
    this.emit('live', conversation.id, { type: 'message', message: { ...message } });

    const controller = new AbortController();
    const run: Run = { controller, message, done: Promise.resolve() };
    this.runs.set(conversation.id, run);
    run.done = this.write(conversation, choice, history, run)
      // Only saving can fail here, such as when the app quits mid-reply.
      .catch((error: unknown) => console.error('Saving a chat reply failed', error))
      .finally(() => {
        this.runs.delete(conversation.id);
        this.emit('list');
      });
    return { ...message };
  }

  private async write(
    conversation: Conversation,
    choice: ModelChoice,
    history: MessageRecord[],
    run: Run,
  ): Promise<void> {
    const { message, controller } = run;
    const flushMs = this.options.flushMs ?? 1000;
    let flushed = Date.now();
    try {
      const clank = this.options.crew.get(conversation.clankId);
      const prompt = this.prompt(clank.id, conversation.folder);
      const window = this.contextWindow(choice);
      const turns = fitHistory(toTurns(history), window * HISTORY_SHARE - prompt.tokens);
      const used = prompt.tokens + turns.reduce((sum, t) => sum + estimateTokens(t.content), 0);
      const local = choice.provider === BUILTIN_PROVIDER;
      const events = this.options.providers.stream(
        choice.provider,
        {
          model: choice.model,
          messages: [{ role: 'system', content: prompt.system }, ...turns],
          temperature: clank.frontmatter.model.temperature,
          // A local model's reply shares its slot with the prompt, so it gets what's left.
          ...(local
            ? { maxTokens: Math.max(512, Math.min(LOCAL_MAX_REPLY, Math.floor(window - used))) }
            : {}),
        },
        controller.signal,
      );
      for await (const event of events) {
        switch (event.type) {
          case 'text':
          case 'reasoning': {
            const text = event.type === 'text' ? event.text : '';
            const reasoning = event.type === 'reasoning' ? event.text : '';
            message.content += text;
            message.reasoning += reasoning;
            this.emit('live', conversation.id, {
              type: 'delta',
              messageId: message.id,
              text,
              reasoning,
            });
            if (Date.now() - flushed >= flushMs) {
              this.store.updateMessage(message);
              flushed = Date.now();
            }
            break;
          }
          case 'usage':
            message.usage = event.usage;
            break;
          case 'done':
            message.finishReason = event.finishReason;
            message.status = event.finishReason === 'cancelled' ? 'cancelled' : 'done';
            break;
          case 'tool_call':
            // Chats have no tools yet, so a model that calls one anyway gets nothing back.
            break;
        }
      }
      if (message.status === 'streaming') message.status = 'done';
    } catch (error) {
      if (controller.signal.aborted) {
        message.status = 'cancelled';
        message.finishReason = 'cancelled';
      } else {
        message.status = 'failed';
        message.error =
          error instanceof ProviderError || error instanceof ChatError
            ? error.message
            : `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
        if (!(error instanceof ProviderError || error instanceof ChatError)) {
          console.error('A chat reply failed', error);
        }
      }
    }
    // Quitting saved it already, and the chat may have been deleted meanwhile.
    if (this.closed || !this.store.conversation(conversation.id)) return;
    this.store.updateMessage(message);
    this.store.updateConversation(conversation.id, { updatedAt: this.now() });
    this.emit('live', conversation.id, { type: 'message', message: { ...message } });
  }

  private prompt(clankId: string, folder: string | null): AssembledPrompt {
    const { crew } = this.options;
    const settings = this.options.settings.get();
    return assemblePrompt({
      rules: crew.rules(),
      clank: crew.get(clankId),
      crew: crew.list(),
      profile: settings.profile,
      instructions: folder ? readProjectInstructions(folder) : null,
      run: { mode: 'chat', folder },
      now: this.now(),
      platform: this.options.platform ?? process.platform,
    });
  }

  /** The tokens a model can hold for one conversation. */
  private contextWindow(choice: ModelChoice): number {
    if (choice.provider === BUILTIN_PROVIDER) {
      const model = this.options.library().find((m) => m.id === choice.model);
      const perSlot = this.options.settings.get().contextPerSlot;
      // As the model manager loads it: what's asked for, but no more than it was trained on.
      return Math.max(256, Math.min(perSlot, model?.facts.contextLength ?? perSlot));
    }
    const reported = this.options.providerInfo.contextWindow(choice);
    if (reported > 0) return reported;
    return choice.provider.startsWith('server-') ? DEFAULT_SERVER_CONTEXT : DEFAULT_CLOUD_CONTEXT;
  }

  private require(id: string): Conversation {
    const conversation = this.store.conversation(id);
    if (!conversation) throw new ChatError('That chat was deleted');
    return conversation;
  }

  private assertIdle(conversationId: string): void {
    if (this.runs.has(conversationId)) {
      throw new ChatError('A reply is still being written. Wait for it, or stop it.');
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/**
 * The conversation as a model sees it: what was said, without the thinking. Replies that failed
 * before saying anything are left out, and turns by the same speaker are joined, since some chat
 * templates insist the user and the model take turns.
 */
export function toTurns(history: MessageRecord[]): ChatMessage[] {
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const message of history) {
    const content = message.content.trim();
    if (!content) continue;
    const last = turns.at(-1);
    if (last?.role === message.role) last.content += `\n\n${content}`;
    else turns.push({ role: message.role, content });
  }
  return turns;
}

/**
 * Drops the oldest turns until the rest fit the budget. The latest message always goes, even if
 * it's too big on its own; the model then says so itself. The kept history starts with the user.
 */
export function fitHistory(turns: ChatMessage[], budget: number): ChatMessage[] {
  let start = 0;
  let total = turns.reduce((sum, t) => sum + estimateTokens(t.content), 0);
  while (total > budget && start < turns.length - 1) {
    total -= estimateTokens(turns[start]!.content);
    start++;
  }
  while (start < turns.length - 1 && turns[start]!.role !== 'user') start++;
  return turns.slice(start);
}

/** A chat's title from its first message: its opening words, on one line. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}
