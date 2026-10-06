import {
  type ApprovalDecision,
  type ChatImage,
  type ChatLiveEvent,
  type ChatMessage,
  type ChatUsage,
  type Conversation,
  type ConversationSummary,
  type FinishReason,
  type GgufFacts,
  type MessagePart,
  type MessageRecord,
  type ModelChoice,
  type ReviewNote,
  type RunInfo,
  type RunRole,
  type Settings,
  type ToolCall,
  type ToolPart,
  estimateTokens,
  textOf,
} from '@clanks/core';
import { BUILTIN_PROVIDER, ProviderError, type ProviderRegistry } from '@clanks/providers';
import { type ToolContext, ToolArgumentsError, ToolFailure, type ToolResult } from '@clanks/tools';
import { commandShell } from '@clanks/workspace';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ActivityService } from '../activity/service';
import type { ChatScope, ReplyOutcome } from '../board/service';
import type { BrowserService } from '../browser/service';
import type { CrewService } from '../crew/crew';
import { readProjectInstructions } from '../crew/instructions';
import { type AssembledPrompt, type RunContext, assemblePrompt } from '../crew/prompt';
import type { TerminalService } from '../terminal/service';
import type { Toolset, ToolService } from '../tools/service';
import type { WorkspaceService } from '../workspace/service';
import type { ChatStore } from './store';

/** A chat problem worded for the user, such as no model to run on. */
export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

/** What chats need from the board: projects, their runs, and what each run is for. */
export interface ChatBoard {
  /** What a chat or run in a project knows. Null outside one. */
  scope(conversation: Conversation): ChatScope | null;
  /** A project's workspace, for a chat with a clank in its crew. Throws for anyone else. */
  chatFolder(projectId: string, clankId: string): string;
  /** A clank's model in a project, if the project picks one. */
  modelFor(projectId: string, clankId: string): ModelChoice | null;
  replyStarted(conversation: Conversation): void;
  replyEnded(conversation: Conversation, outcome: ReplyOutcome): void;
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
  /**
   * Pulled models, for the crew's model, how much context each gets, and whether it calls tools
   * and sees pictures.
   */
  library: () => {
    id: string;
    facts: GgufFacts;
    missing: boolean;
    capabilities: { tools: boolean; vision: boolean };
  }[];
  /** Whether a cloud model or a server's model sees pictures, as its provider says. */
  vision?: (choice: ModelChoice) => boolean;
  workspace: WorkspaceService;
  terminal: TerminalService;
  activity: ActivityService;
  tools: ToolService;
  browser: BrowserService;
  /** Projects' boards. Without one, chats can't be in projects. */
  board?: ChatBoard;
  /** Pictures tools took, one folder per chat. */
  artifactsDir: string;
  now?: () => Date;
  platform?: NodeJS.Platform;
  /** How often a reply being written is saved, so a crash keeps most of it. */
  flushMs?: number;
}

interface Run {
  controller: AbortController;
  message: MessageRecord;
  done: Promise<void>;
  /** Tool calls waiting for the user, by call id. */
  approvals: Map<string, (decision: ApprovalDecision) => void>;
  /** A finishing call handed the ticket on, so the run is over. */
  finished: boolean;
}

/** The longest reply a local model is asked for: room enough for thinking and a long answer. */
const LOCAL_MAX_REPLY = 16_384;
/** History gets this share of the context window; the rest is for the reply. */
const HISTORY_SHARE = 0.75;
/** Context to assume when a provider doesn't say. */
const DEFAULT_CLOUD_CONTEXT = 128_000;
const DEFAULT_SERVER_CONTEXT = 32_768;
/** One reply makes at most this many rounds of tool calls before it stops to check in. */
const MAX_ROUNDS = 40;
/** Earlier replies' tool results are cut to this in the history, to save room. */
const OLD_RESULT_CHARS = 3000;
/** Roughly what a picture costs a model that sees it, in tokens. */
const IMAGE_TOKENS = 1000;
/** A run that stops with a plain reply is reminded this often to end with a finishing call. */
const MAX_NUDGES = 2;

/**
 * Chats with clanks. Replies are written here in the orchestrator, not in the window, so closing
 * or reloading the window never cuts one off. A reply is a loop: the model answers, calls tools,
 * reads their results and goes on until it answers without calling any. Emits `live` with each
 * conversation's events and `list` when the list of conversations changes.
 */
export class ChatService extends EventEmitter<{
  live: [conversationId: string, event: ChatLiveEvent];
  list: [];
}> {
  private readonly runs = new Map<string, Run>();
  /** What the app wrote to a run while it was replying, waiting its turn. */
  private readonly queued = new Map<string, string[]>();
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
        parts: message.parts.map((part) =>
          part.type === 'tool' && !isSettled(part)
            ? {
                ...part,
                status: 'cancelled',
                result: part.result ?? 'clanks closed before this ran.',
              }
            : part,
        ),
        status: 'failed',
        error: 'clanks closed before this reply finished.',
      });
    }
  }

  list(): ConversationSummary[] {
    return this.store.conversations().map((c) => this.summary(c));
  }

  get(id: string): { conversation: ConversationSummary; messages: MessageRecord[] } {
    const conversation = this.require(id);
    // A reply being written is ahead of what's saved.
    const live = this.runs.get(id)?.message;
    const messages = this.store
      .messages(id)
      .map((m) => (live?.id === m.id ? structuredClone(live) : m));
    return { conversation: this.summary(conversation), messages };
  }

  /** The reply being written in a conversation right now, as far as it's got. */
  inFlight(id: string): MessageRecord | null {
    const run = this.runs.get(id);
    return run ? structuredClone(run.message) : null;
  }

  /**
   * Starts a chat with its first message, so empty chats never pile up. It can be about a folder
   * from the start, or in a project, which makes it about the project's workspace.
   */
  start(
    clankId: string,
    text: string,
    folder: string | null = null,
    projectId: string | null = null,
  ): { conversation: Conversation; reply: MessageRecord } {
    const clank = this.options.crew.get(clankId);
    const where = projectId ? this.board().chatFolder(projectId, clank.id) : folder;
    const choice = this.modelFor(clank.id, projectId);
    const now = this.now();
    const conversation: Conversation = {
      id: randomUUID(),
      clankId: clank.id,
      title: titleFrom(text),
      folder: where === null ? null : checkFolder(where),
      projectId,
      ticketId: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertConversation(conversation);
    this.appendUser(conversation.id, text);
    const reply = this.reply(conversation, choice);
    this.emit('list');
    return { conversation, reply };
  }

  /** Starts a run: the conversation a clank works a ticket in, which the app writes to. */
  createRun(input: {
    clankId: string;
    projectId: string;
    ticketId: string;
    role: RunRole;
    title: string;
  }): Conversation {
    const clank = this.options.crew.get(input.clankId);
    const now = this.now();
    const conversation: Conversation = {
      id: randomUUID(),
      clankId: clank.id,
      title: input.title,
      folder: checkFolder(this.board().chatFolder(input.projectId, clank.id)),
      projectId: input.projectId,
      ticketId: input.ticketId,
      role: input.role,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertConversation(conversation);
    this.emit('list');
    return conversation;
  }

  /**
   * Writes to a run as the app, such as a ticket brief or a bounce, and starts a reply. While one
   * is being written, it waits its turn. Throws when the clank has no model to run on.
   */
  post(conversationId: string, text: string): void {
    const conversation = this.require(conversationId);
    if (this.runs.has(conversationId)) {
      this.queued.set(conversationId, [...(this.queued.get(conversationId) ?? []), text]);
      return;
    }
    const choice = this.modelFor(conversation.clankId, conversation.projectId);
    this.appendUser(conversationId, text, 'app');
    const updated = this.store.updateConversation(conversationId, { updatedAt: this.now() })!;
    this.reply(updated, choice);
    this.emit('list');
  }

  /** Whether a reply is being written in a conversation. */
  replying(conversationId: string): boolean {
    return this.runs.has(conversationId);
  }

  /**
   * Sends a message. Notes the user left in the diff editor since the clank last heard from them
   * go with it, so they're never lost.
   */
  send(conversationId: string, text: string): MessageRecord {
    const conversation = this.require(conversationId);
    this.assertIdle(conversationId);
    const choice = this.modelFor(conversation.clankId, conversation.projectId);
    const notes = this.options.workspace.pendingNotes(conversationId);
    const content = notes.length > 0 ? `${text.trim()}\n\n${formatNotes(notes)}` : text;
    this.appendUser(conversationId, content);
    this.options.workspace.markSent(
      conversationId,
      notes.map((n) => n.id),
    );
    const updated = this.store.updateConversation(conversationId, { updatedAt: this.now() })!;
    const reply = this.reply(updated, choice);
    this.emit('list');
    return reply;
  }

  /** Sends just the notes from the diff editor, as the user's next message. */
  sendReview(conversationId: string): MessageRecord {
    const notes = this.options.workspace.pendingNotes(conversationId);
    if (notes.length === 0) throw new ChatError('There are no notes to send');
    const conversation = this.require(conversationId);
    this.assertIdle(conversationId);
    const choice = this.modelFor(conversation.clankId, conversation.projectId);
    this.appendUser(conversationId, formatNotes(notes));
    this.options.workspace.markSent(
      conversationId,
      notes.map((n) => n.id),
    );
    const updated = this.store.updateConversation(conversationId, { updatedAt: this.now() })!;
    const reply = this.reply(updated, choice);
    this.emit('list');
    return reply;
  }

  /** Writes the last reply again, or a reply to a message that never got one. */
  retry(conversationId: string): MessageRecord {
    const conversation = this.require(conversationId);
    this.assertIdle(conversationId);
    const choice = this.modelFor(conversation.clankId, conversation.projectId);
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

  /** The user's answer to a tool call waiting for approval. */
  decide(conversationId: string, toolCallId: string, decision: ApprovalDecision): void {
    const resolve = this.runs.get(conversationId)?.approvals.get(toolCallId);
    if (!resolve) throw new ChatError("That call isn't waiting for you any more");
    resolve(decision);
  }

  rename(conversationId: string, title: string): Conversation {
    this.require(conversationId);
    const updated = this.store.updateConversation(conversationId, { title: title.trim() })!;
    this.emit('live', conversationId, { type: 'conversation', conversation: updated });
    this.emit('list');
    return updated;
  }

  /**
   * Points the chat at a folder, whose CLANKS.md or AGENTS.md the clank then follows. The clank
   * gets its own worktree of it, made in the background; the workbench shows how that went.
   */
  setFolder(conversationId: string, folder: string | null): Conversation {
    const current = this.require(conversationId);
    this.assertIdle(conversationId);
    if (current.projectId) {
      throw new ChatError("A chat in a project is about the project's workspace");
    }
    const path = folder === null ? null : checkFolder(folder);
    const updated = this.store.updateConversation(conversationId, { folder: path })!;
    if (current.folder !== path) {
      this.options.terminal.closeConversation(conversationId);
      const work = path
        ? this.options.workspace.ensure(conversationId)
        : this.options.workspace.remove(conversationId);
      void work.catch((error: unknown) => console.error('Preparing a workspace failed', error));
    }
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
    this.options.terminal.closeConversation(conversationId);
    this.options.browser.closeConversation(conversationId);
    await this.options.workspace.remove(conversationId);
    this.queued.delete(conversationId);
    this.store.deleteConversation(conversationId);
    rmSync(join(this.options.artifactsDir, conversationId), { recursive: true, force: true });
    this.emit('list');
  }

  /**
   * Puts the files back as they were at a checkpoint and cuts the chat back to that moment, so the
   * clank forgets what it did after it.
   */
  async rewind(conversationId: string, checkpointId: string): Promise<void> {
    this.require(conversationId);
    this.assertIdle(conversationId);
    const target = await this.options.workspace.rewind(conversationId, checkpointId);
    const user = this.userName();
    const message = target.messageId ? this.store.message(target.messageId) : undefined;
    let keep: string | null = target.afterMessageId;
    if (message && target.toolCallId) {
      const index = message.parts.findIndex((p) => p.type === 'tool' && p.id === target.toolCallId);
      if (index !== -1) {
        const round = message.parts[index]!.round;
        // Calls the model made alongside it need results, or the history won't parse.
        const parts: MessagePart[] = message.parts
          .filter((p, i) => i <= index || (p.type === 'tool' && p.round === round))
          .map((p, i) =>
            i > index && p.type === 'tool'
              ? {
                  ...p,
                  status: 'cancelled',
                  result: `${user} rewound the files to before this call, so it was undone.`,
                }
              : p,
          );
        parts.push({ type: 'note', round, text: 'Rewound to here.' });
        const cut: MessageRecord = {
          ...message,
          parts,
          content: textOf(parts),
          status: 'done',
          error: null,
          finishReason: 'stop',
        };
        this.store.updateMessage(cut);
        this.emit('live', conversationId, { type: 'message', message: cut });
        keep = message.id;
      }
    }
    if (keep) {
      for (const id of this.store.deleteAfter(conversationId, keep)) {
        this.emit('live', conversationId, { type: 'removed', messageId: id });
      }
    }
    this.options.activity.append({
      conversationId,
      messageId: null,
      kind: 'rewind',
      title: `Rewound to: ${target.label}`,
      input: null,
      output: null,
      status: 'ok',
      toolCallId: null,
      checkpointId: target.id,
      sessionId: null,
      startedAt: this.now(),
      durationMs: null,
    });
    this.store.updateConversation(conversationId, { updatedAt: this.now() });
    this.emit('list');
  }

  /** What the clank in a conversation would be told right now: its assembled system prompt. */
  async preview(clankId: string, conversationId: string | null): Promise<AssembledPrompt> {
    const conversation = conversationId ? this.require(conversationId) : null;
    const clank = this.options.crew.get(clankId);
    const scope = conversation ? (this.options.board?.scope(conversation) ?? null) : null;
    const run = conversation ? this.options.workspace.run(conversation.id) : null;
    const status = conversation
      ? (await this.options.workspace.state(conversation.id)).status
      : null;
    let choice: ModelChoice | null = null;
    try {
      choice = this.modelFor(clank.id, conversation?.projectId ?? null);
    } catch {
      // No model yet: show what it would be told on one that calls tools.
    }
    const toolset = await this.options.tools.forChat(clank, {
      workspace: run !== null || status === 'ready',
      browser: this.options.browser.available,
      vision: choice !== null && this.seesImages(choice),
      project: scope !== null,
      role: scope?.run?.role ?? null,
    });
    return this.prompt(
      clank.id,
      conversation?.folder ?? null,
      {
        run,
        status,
        tools: choice && !this.callsTools(choice) ? [] : [...toolset.specs.keys()],
        shell: null,
        toolsUnsupported: choice !== null && !this.callsTools(choice) && toolset.specs.size > 0,
        problems: toolset.problems,
      },
      scope,
    );
  }

  /**
   * Stops every reply at once, for quitting, and saves each as far as it got: the database closes
   * straight after, so nothing can wait.
   */
  close(): void {
    this.closed = true;
    for (const run of this.runs.values()) {
      run.controller.abort();
      run.message.parts = run.message.parts.map((part) =>
        part.type === 'tool' && !isSettled(part) ? { ...part, status: 'cancelled' } : part,
      );
      this.store.updateMessage({
        ...run.message,
        content: textOf(run.message.parts),
        status: 'cancelled',
        finishReason: 'cancelled',
      });
    }
  }

  /** The model a clank runs on: the project's pick for it, its own, or the crew's. */
  modelFor(clankId: string, projectId: string | null = null): ModelChoice {
    const clank = this.options.crew.get(clankId);
    const own =
      (projectId ? this.options.board?.modelFor(projectId, clank.id) : null) ??
      clank.overrides.model;
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

  private summary(conversation: Conversation): ConversationSummary {
    const run = this.runs.get(conversation.id);
    return {
      ...conversation,
      replying: run !== undefined,
      asking: run?.message.parts.some((p) => p.type === 'tool' && p.status === 'asking') ?? false,
    };
  }

  private requirePulled(model: string, who: string): void {
    const found = this.options.library().find((m) => m.id === model);
    if (!found || found.missing) {
      throw new ChatError(
        `${model} isn't pulled any more. Pull it again, or pick another model for ${who}.`,
      );
    }
  }

  private appendUser(conversationId: string, text: string, author?: 'app'): MessageRecord {
    const content = text.trim();
    const message: MessageRecord = {
      id: randomUUID(),
      conversationId,
      role: 'user',
      ...(author ? { author } : {}),
      content,
      parts: [{ type: 'text', round: 0, text: content }],
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
      parts: [],
      reasoning: '',
      status: 'streaming',
      error: null,
      model: choice,
      usage: null,
      finishReason: null,
      createdAt: this.now(),
    };
    this.store.appendMessage(message);
    this.emit('live', conversation.id, { type: 'message', message: structuredClone(message) });

    const controller = new AbortController();
    const run: Run = {
      controller,
      message,
      done: Promise.resolve(),
      approvals: new Map(),
      finished: false,
    };
    this.runs.set(conversation.id, run);
    this.options.board?.replyStarted(conversation);
    run.done = this.write(conversation, choice, history, run)
      // Only saving can fail here, such as when the app quits mid-reply.
      .catch((error: unknown) => console.error('Saving a chat reply failed', error))
      .finally(() => {
        this.runs.delete(conversation.id);
        if (!this.closed && this.store.conversation(conversation.id)) this.ended(conversation, run);
        this.emit('list');
      });
    return structuredClone(message);
  }

  /** Tells the board how a reply ended, then starts what the app wrote meanwhile. */
  private ended(conversation: Conversation, run: Run): void {
    try {
      this.options.board?.replyEnded(conversation, {
        status: run.message.status,
        finished: run.finished,
        error: run.message.error,
      });
    } catch (error) {
      console.error('The board missed the end of a reply', error);
    }
    const queue = this.queued.get(conversation.id);
    const next = queue?.shift();
    if (queue?.length === 0) this.queued.delete(conversation.id);
    if (next === undefined) return;
    try {
      this.post(conversation.id, next);
    } catch (error) {
      console.error('Writing to a run failed', error);
    }
  }

  private async write(
    conversation: Conversation,
    choice: ModelChoice,
    history: MessageRecord[],
    run: Run,
  ): Promise<void> {
    const { message, controller } = run;
    const { signal } = controller;
    const flushMs = this.options.flushMs ?? 1000;
    let flushed = Date.now();
    const flush = (force = false) => {
      if (force || Date.now() - flushed >= flushMs) {
        this.store.updateMessage(message);
        flushed = Date.now();
      }
    };
    try {
      const clank = this.options.crew.get(conversation.clankId);
      const scope = this.options.board?.scope(conversation) ?? null;
      const role = scope?.run?.role ?? null;
      const { run: workspace, problem, status } = await this.prepareWorkspace(conversation);
      const vision = this.seesImages(choice);
      const toolset = await this.options.tools.forChat(clank, {
        workspace: workspace !== null,
        browser: this.options.browser.available,
        vision,
        project: scope !== null,
        role,
      });
      const callsTools = this.callsTools(choice);
      const offered: Toolset = callsTools
        ? toolset
        : { specs: new Map(), levels: new Map(), definitions: [], problems: [] };
      const shellName =
        offered.specs.has('shell_exec') || offered.specs.has('shell_start')
          ? (await commandShell()).name
          : null;
      const prompt = this.prompt(
        clank.id,
        conversation.folder,
        {
          run: workspace,
          status,
          tools: [...offered.specs.keys()],
          shell: shellName,
          toolsUnsupported: !callsTools && toolset.specs.size > 0,
          problems: [...toolset.problems, ...(problem ? [problem] : [])],
        },
        scope,
      );
      const window = this.contextWindow(choice);
      const toolTokens = estimateTokens(JSON.stringify(offered.definitions));
      const maxChars = Math.max(4000, Math.min(40_000, Math.floor(window * 4 * 0.12)));
      const turns = fitHistory(
        toTurns(history),
        window * HISTORY_SHARE - prompt.tokens - toolTokens,
      );
      const messages: ChatMessage[] = [{ role: 'system', content: prompt.system }, ...turns];
      const local = choice.provider === BUILTIN_PROVIDER;
      // A run on a ticket must end by handing it on, not with a plain reply.
      const mustFinish = (role === 'maker' || role === 'checker') && callsTools;
      let malformed = 0;
      let nudges = 0;
      const totals = {
        prompt: 0,
        completion: 0,
        duration: 0,
        speed: null as number | null,
        promptSpeed: null as number | null,
      };

      for (let round = 0; ; round++) {
        // Stopped while the workspace or tools were being got ready.
        if (signal.aborted) {
          message.status = 'cancelled';
          message.finishReason = 'cancelled';
          break;
        }
        compactTurns(messages, window * 0.85 - toolTokens);
        const used = toolTokens + messages.reduce((sum, m) => sum + tokensOf(m), 0);
        const started = this.now();
        const calls: ToolCall[] = [];
        let text = '';
        let finish: FinishReason = 'stop';
        let usage: ChatUsage | null = null;
        const events = this.options.providers.stream(
          choice.provider,
          {
            model: choice.model,
            messages,
            ...(offered.definitions.length > 0 ? { tools: offered.definitions } : {}),
            temperature: clank.frontmatter.model.temperature,
            // A local model's reply shares its slot with the prompt, so it gets what's left.
            ...(local
              ? { maxTokens: Math.max(512, Math.min(LOCAL_MAX_REPLY, Math.floor(window - used))) }
              : {}),
          },
          signal,
        );
        for await (const event of events) {
          switch (event.type) {
            case 'text':
            case 'reasoning': {
              const delta = event.type === 'text' ? event.text : '';
              const reasoning = event.type === 'reasoning' ? event.text : '';
              if (delta) {
                text += delta;
                appendText(message, round, delta);
              }
              message.reasoning += reasoning;
              this.emit('live', conversation.id, {
                type: 'delta',
                messageId: message.id,
                round,
                text: delta,
                reasoning,
              });
              flush();
              break;
            }
            case 'tool_call':
              calls.push(event.call);
              break;
            case 'usage':
              usage = event.usage;
              break;
            case 'done':
              finish = event.finishReason;
              break;
          }
        }
        if (usage) {
          totals.prompt += usage.promptTokens;
          totals.completion += usage.completionTokens;
          totals.duration += usage.durationMs;
          totals.speed = usage.tokensPerSecond ?? totals.speed;
          totals.promptSpeed = usage.promptTokensPerSecond ?? totals.promptSpeed;
          message.usage = {
            promptTokens: totals.prompt,
            completionTokens: totals.completion,
            tokensPerSecond: totals.speed,
            promptTokensPerSecond: totals.promptSpeed,
            durationMs: totals.duration,
          };
        }
        message.content = textOf(message.parts);
        this.options.activity.append({
          conversationId: conversation.id,
          messageId: message.id,
          kind: 'model',
          title:
            calls.length > 0
              ? `${choice.model} called ${calls.map((c) => c.name).join(', ')}`
              : `${choice.model} ${finish === 'cancelled' ? 'was stopped' : 'answered'}`,
          input: `${messages.length} messages, about ${used} tokens${round > 0 ? `, round ${round + 1}` : ''}`,
          output:
            [text.trim(), ...calls.map((c) => `${c.name}(${c.arguments})`)]
              .filter(Boolean)
              .join('\n\n') || null,
          status: finish === 'cancelled' ? 'cancelled' : 'ok',
          toolCallId: null,
          checkpointId: null,
          sessionId: null,
          startedAt: started,
          durationMs: usage?.durationMs ?? this.now().getTime() - started.getTime(),
        });
        if (finish === 'cancelled' || signal.aborted) {
          message.status = 'cancelled';
          message.finishReason = 'cancelled';
          break;
        }
        if (calls.length === 0) {
          if (mustFinish && nudges < MAX_NUDGES && finish !== 'length') {
            nudges++;
            messages.push(
              { role: 'assistant', content: text.trim() || '…' },
              { role: 'user', content: nudgeText(role) },
            );
            this.addPart(conversation.id, message, {
              type: 'note',
              round,
              text: `Reminded ${clank.name} to end the run by handing the ticket on.`,
            });
            continue;
          }
          message.finishReason = finish;
          message.status = 'done';
          break;
        }

        messages.push({ role: 'assistant', content: text, toolCalls: calls });
        for (const call of calls) {
          const outcome = signal.aborted
            ? this.skipCall(conversation, message, call, round)
            : run.finished
              ? this.skipCall(
                  conversation,
                  message,
                  call,
                  round,
                  "The ticket was already handed on, so this didn't run.",
                )
              : await this.callTool({
                  conversation,
                  message,
                  run,
                  call,
                  round,
                  toolset: offered,
                  workspace,
                  clank,
                  maxChars,
                  scope,
                });
          if (outcome.malformed) malformed++;
          if (outcome.image && vision) {
            // Only the newest picture stays: each one costs as much as a page of text.
            for (const earlier of messages) {
              if (earlier.role === 'tool' && earlier.images) {
                delete earlier.images;
                earlier.content += '\n\n[A picture was here; it was dropped to save room.]';
              }
            }
            messages.push({
              role: 'tool',
              toolCallId: outcome.id,
              content: outcome.result,
              images: [outcome.image],
            });
          } else {
            messages.push({ role: 'tool', toolCallId: outcome.id, content: outcome.result });
          }
          flush(true);
        }
        if (run.finished) {
          message.status = 'done';
          message.finishReason = 'stop';
          break;
        }
        if (malformed >= 2) {
          throw new ChatError(
            `${choice.model} wrote tool calls that don't fit their tools twice, so the reply stopped. A bigger model, or one made for tool use, may do better.`,
          );
        }
        // Notes the user left in the diff editor meanwhile go to the clank before it goes on.
        const notes = this.options.workspace.pendingNotes(conversation.id);
        if (notes.length > 0 && !signal.aborted) {
          const feedback = formatNotes(notes);
          messages.push({ role: 'user', content: feedback });
          this.addPart(conversation.id, message, { type: 'feedback', round, text: feedback });
          this.options.workspace.markSent(
            conversation.id,
            notes.map((n) => n.id),
          );
        }
        if (signal.aborted) {
          message.status = 'cancelled';
          message.finishReason = 'cancelled';
          break;
        }
        if (round + 1 >= MAX_ROUNDS) {
          this.addPart(conversation.id, message, {
            type: 'note',
            round,
            text: `Stopped after ${MAX_ROUNDS} rounds of tool calls. Say "go on" to let ${clank.name} continue.`,
          });
          message.status = 'done';
          message.finishReason = 'length';
          break;
        }
      }
    } catch (error) {
      if (signal.aborted) {
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
    message.content = textOf(message.parts);
    // Quitting saved it already, and the chat may have been deleted meanwhile.
    if (this.closed || !this.store.conversation(conversation.id)) return;
    this.store.updateMessage(message);
    this.store.updateConversation(conversation.id, { updatedAt: this.now() });
    this.emit('live', conversation.id, { type: 'message', message: structuredClone(message) });
  }

  /** The chat's worktree, made now if it needs one, and why there isn't one if there isn't. */
  private async prepareWorkspace(conversation: Conversation): Promise<{
    run: RunInfo | null;
    status: RunContext['workspaceStatus'];
    problem: string | null;
  }> {
    if (!conversation.folder) return { run: null, status: null, problem: null };
    try {
      const run = await this.options.workspace.ensure(conversation.id);
      if (run) return { run, status: 'ready', problem: null };
      const state = await this.options.workspace.state(conversation.id);
      return { run: null, status: state.status, problem: state.error };
    } catch (error) {
      return {
        run: null,
        status: 'error',
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Runs one tool call: checks it, asks the user if it must, runs it and records what happened. */
  private async callTool(input: {
    conversation: Conversation;
    message: MessageRecord;
    run: Run;
    call: ToolCall;
    round: number;
    toolset: Toolset;
    workspace: RunInfo | null;
    clank: { id: string; name: string };
    maxChars: number;
    scope: ChatScope | null;
  }): Promise<{ id: string; result: string; malformed: boolean; image?: ChatImage }> {
    const { conversation, message, run, call, round, toolset, workspace } = input;
    const signal = run.controller.signal;
    const user = this.userName();
    const part: ToolPart = {
      type: 'tool',
      round,
      id: call.id || `call_${randomUUID()}`,
      name: call.name,
      arguments: call.arguments,
      label: call.name,
      status: 'pending',
      approval: null,
      decidedBy: null,
      reason: null,
      result: null,
      startedAt: this.now(),
      endedAt: null,
      checkpointId: null,
      sessionId: null,
    };
    const index = this.addPart(conversation.id, message, part);
    const update = () =>
      this.emit('live', conversation.id, {
        type: 'part',
        messageId: message.id,
        index,
        part: { ...part },
      });
    const finish = (
      status: ToolPart['status'],
      result: string,
      extra: { output?: string; malformed?: boolean; image?: ChatImage } = {},
    ) => {
      part.status = status;
      part.result = result;
      part.endedAt = this.now();
      update();
      this.options.activity.append({
        conversationId: conversation.id,
        messageId: message.id,
        kind: 'tool',
        title: part.label,
        input: prettyArguments(call.arguments),
        output: extra.output ?? result,
        status:
          status === 'done'
            ? 'ok'
            : status === 'denied'
              ? 'denied'
              : status === 'cancelled'
                ? 'cancelled'
                : 'error',
        toolCallId: part.id,
        checkpointId: part.checkpointId,
        sessionId: part.sessionId,
        image: part.image ?? null,
        startedAt: part.startedAt!,
        durationMs: part.endedAt.getTime() - part.startedAt!.getTime(),
      });
      return {
        id: part.id,
        result,
        malformed: extra.malformed ?? false,
        ...(extra.image ? { image: extra.image } : {}),
      };
    };

    const spec = toolset.specs.get(call.name);
    if (!spec) {
      const names = [...toolset.specs.keys()];
      return finish(
        'failed',
        `There's no tool called ${call.name} here. ${names.length ? `Your tools: ${names.join(', ')}.` : 'You have no tools in this chat.'}`,
        { malformed: true },
      );
    }
    let args: unknown;
    try {
      const raw: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
      args = spec.parse(raw);
      part.label = spec.label(args);
    } catch (error) {
      const detail =
        error instanceof SyntaxError
          ? `they aren't valid JSON (${error.message})`
          : (error as Error).message;
      return finish(
        'failed',
        `The arguments don't fit ${call.name}: ${detail}. Call it again with arguments that do.`,
        {
          malformed: true,
        },
      );
    }

    const level = toolset.levels.get(call.name);
    if (level === 'deny') {
      part.decidedBy = 'policy';
      return finish(
        'denied',
        `${user} doesn't let you use ${call.name}. Don't try again; do without it, or say what you need.`,
      );
    }
    if (level === 'ask') {
      const approval = { ...spec.approval(args), scope: workspace?.repoRoot ?? null };
      const rule = approval.scope
        ? this.options.tools.ruleFor(approval.scope, call.name, approval.subject)
        : undefined;
      if (rule) {
        part.decidedBy = 'rule';
      } else {
        part.status = 'asking';
        part.approval = approval;
        update();
        this.emit('list');
        flushParts(this.store, message);
        const decision = await this.waitFor(run, part.id, signal);
        this.emit('list');
        if (!decision) return finish('cancelled', 'Stopped before it ran.');
        part.decidedBy = 'user';
        if (decision.decision === 'deny') {
          part.reason = decision.reason ?? null;
          return finish(
            'denied',
            `${user} said no${decision.reason ? `: "${decision.reason}"` : '.'} Don't run it again or work around it. Do something else, or ask ${user} what they want.`,
          );
        }
        if (decision.decision === 'always' && approval.scope) {
          this.options.tools.addRule(approval.scope, call.name, decision.pattern);
        }
      }
    } else {
      part.decidedBy = 'policy';
    }

    part.status = 'running';
    part.startedAt = this.now();
    update();
    const ctx: ToolContext = {
      workspace: workspace
        ? {
            root: workspace.worktree,
            cwd: workspace.cwd,
            branch: workspace.branch,
            baseCommit: workspace.baseCommit,
          }
        : null,
      shell:
        workspace && spec.needs.includes('shell')
          ? await this.options.terminal.shellFor({
              conversationId: conversation.id,
              cwd: workspace.cwd,
              toolCallId: part.id,
              maxChars: input.maxChars,
            })
          : null,
      web: this.options.tools.web(),
      browser:
        spec.needs.includes('browser') || spec.needs.includes('search')
          ? this.options.browser.access(conversation.id, input.clank, {
              signal,
              maxChars: input.maxChars,
            })
          : null,
      board: input.scope?.access ?? null,
      signal,
      clank: input.clank,
      maxChars: input.maxChars,
    };
    let result: ToolResult;
    try {
      result = await spec.run(args, ctx);
    } catch (error) {
      if (signal.aborted) result = { content: 'Stopped before it finished.', error: true };
      else if (error instanceof ToolFailure || error instanceof ToolArgumentsError) {
        result = { content: error.message, error: true };
      } else {
        console.error(`${call.name} failed`, error);
        result = {
          content: `It failed: ${error instanceof Error ? error.message : String(error)}`,
          error: true,
        };
      }
    }
    part.sessionId = result.sessionId ?? null;
    if (result.finish && !result.error) run.finished = true;
    if (result.image) part.image = this.saveImage(conversation.id, part.id, result.image);
    if (spec.mutates && workspace) {
      try {
        const made = await this.options.workspace.checkpoint(conversation.id, {
          author: 'clank',
          label: part.label,
          messageId: message.id,
          toolCallId: part.id,
        });
        part.checkpointId = made?.id ?? null;
      } catch (error) {
        console.error('Taking a checkpoint failed', error);
      }
    }
    if (signal.aborted)
      return finish('cancelled', result.content, {
        ...(result.output ? { output: result.output } : {}),
      });
    return finish(result.error ? 'failed' : 'done', result.content, {
      ...(result.output ? { output: result.output } : {}),
      ...(result.image && result.showModel
        ? {
            image: {
              mediaType: result.image.mediaType,
              data: Buffer.from(result.image.data).toString('base64'),
            },
          }
        : {}),
    });
  }

  /** Keeps a picture a tool took in the chat's artifacts. Returns its path there. */
  private saveImage(
    conversationId: string,
    callId: string,
    image: { data: Uint8Array; mediaType: string },
  ): string | null {
    const base = callId.replace(/[^\w-]/g, '_').slice(0, 80);
    const name = `${base}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`;
    try {
      const dir = join(this.options.artifactsDir, conversationId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), image.data);
      return `${conversationId}/${name}`;
    } catch (error) {
      console.error('Saving a picture failed', error);
      return null;
    }
  }

  /** A call the model made that won't run, because the reply was stopped or the run is over. */
  private skipCall(
    conversation: Conversation,
    message: MessageRecord,
    call: ToolCall,
    round: number,
    why = 'Stopped before it ran.',
  ): { id: string; result: string; malformed: boolean; image?: ChatImage } {
    const id = call.id || `call_${randomUUID()}`;
    this.addPart(conversation.id, message, {
      type: 'tool',
      round,
      id,
      name: call.name,
      arguments: call.arguments,
      label: call.name,
      status: 'cancelled',
      approval: null,
      decidedBy: null,
      reason: null,
      result: why,
      startedAt: null,
      endedAt: null,
      checkpointId: null,
      sessionId: null,
    });
    return { id, result: why, malformed: false };
  }

  private addPart(conversationId: string, message: MessageRecord, part: MessagePart): number {
    const index = message.parts.push(part) - 1;
    this.emit('live', conversationId, {
      type: 'part',
      messageId: message.id,
      index,
      part: { ...part },
    });
    return index;
  }

  private waitFor(run: Run, callId: string, signal: AbortSignal): Promise<ApprovalDecision | null> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      const onAbort = () => {
        run.approvals.delete(callId);
        resolve(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      run.approvals.set(callId, (decision) => {
        signal.removeEventListener('abort', onAbort);
        run.approvals.delete(callId);
        resolve(decision);
      });
    });
  }

  /** Whether the model can call tools. Cloud models and servers are assumed to. */
  private callsTools(choice: ModelChoice): boolean {
    if (choice.provider !== BUILTIN_PROVIDER) return true;
    return this.options.library().find((m) => m.id === choice.model)?.capabilities.tools ?? false;
  }

  /** Whether the model sees pictures, so it can be given screenshots. */
  private seesImages(choice: ModelChoice): boolean {
    if (choice.provider !== BUILTIN_PROVIDER) return this.options.vision?.(choice) ?? false;
    return this.options.library().find((m) => m.id === choice.model)?.capabilities.vision ?? false;
  }

  private prompt(
    clankId: string,
    folder: string | null,
    tools: Omit<
      RunContext,
      'mode' | 'folder' | 'workspace' | 'workspaceStatus' | 'project' | 'brief'
    > & {
      run: RunInfo | null;
      status: RunContext['workspaceStatus'];
    },
    scope: ChatScope | null,
  ): AssembledPrompt {
    const { crew } = this.options;
    const settings = this.options.settings.get();
    const { run, status, ...rest } = tools;
    const mode = scope?.run ? (scope.run.role === 'planner' ? 'plan' : 'ticket') : 'chat';
    return assemblePrompt({
      rules: crew.rules(),
      clank: crew.get(clankId),
      crew: scope?.crew ?? crew.list(),
      profile: settings.profile,
      instructions: folder ? readProjectInstructions(folder) : null,
      context: scope?.context ?? null,
      run: {
        mode,
        project: scope?.project.name ?? null,
        brief: scope?.run?.brief ?? null,
        folder,
        workspace: run
          ? { worktree: run.worktree, cwd: run.cwd, branch: run.branch, baseCommit: run.baseCommit }
          : null,
        workspaceStatus: status,
        ...rest,
      },
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

  private userName(): string {
    return this.options.settings.get().profile.name || 'The user';
  }

  private board(): ChatBoard {
    if (!this.options.board) throw new ChatError("Projects aren't available here");
    return this.options.board;
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

/** A folder's full path, if it is one. */
function checkFolder(folder: string): string {
  const path = resolve(folder);
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    // Missing: reported below.
  }
  if (!isDirectory) throw new ChatError(`${path} isn't a folder`);
  return path;
}

/** What a run that stopped with a plain reply is told, so it hands the ticket on. */
function nudgeText(role: RunRole | null): string {
  const done =
    role === 'checker'
      ? 'If it passes, call `review_pass`. If it needs fixing, call `ticket_bounce` with the issues.'
      : 'If the work is done, call `submit_output`.';
  return `You're working this ticket on your own, so nobody reads a plain reply. ${done} If you can't go on, call \`ask_user\` with your question, or \`fail\` with what went wrong. End with one of these calls.`;
}

function isSettled(part: ToolPart): boolean {
  return ['done', 'failed', 'denied', 'cancelled'].includes(part.status);
}

/**
 * Adds streamed text to the reply: to its last part if that's this round's text, else a new one.
 * `content` keeps up roughly as it streams, and is tidied when the reply ends.
 */
function appendText(message: MessageRecord, round: number, text: string): void {
  const last = message.parts.at(-1);
  if (last?.type === 'text' && last.round === round) {
    last.text += text;
  } else {
    message.parts.push({ type: 'text', round, text });
    if (message.content) message.content += '\n\n';
  }
  message.content += text;
}

/** Saves a reply's parts straight away, so a call waiting for approval survives a crash. */
function flushParts(store: ChatStore, message: MessageRecord): void {
  store.updateMessage({ ...message, content: textOf(message.parts) });
}

function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
  } catch {
    return raw;
  }
}

/** Rough tokens in a turn, tool calls and pictures included. */
export function tokensOf(message: ChatMessage): number {
  const calls =
    message.role === 'assistant'
      ? (message.toolCalls ?? []).reduce((sum, c) => sum + estimateTokens(c.name + c.arguments), 0)
      : 0;
  const images = message.role === 'tool' ? (message.images?.length ?? 0) * IMAGE_TOKENS : 0;
  return estimateTokens(message.content) + calls + images;
}

/**
 * The conversation as a model sees it: what was said and every tool call with its result, without
 * the thinking or the app's notes. Replies that failed before saying anything are left out, and
 * text turns by the same speaker are joined, since some chat templates insist the user and the
 * model take turns. Earlier tool results are cut short to save room.
 */
export function toTurns(history: MessageRecord[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  const say = (role: 'user' | 'assistant', content: string) => {
    const text = content.trim();
    if (!text) return;
    const last = turns.at(-1);
    if (last && last.role === role && !(last.role === 'assistant' && last.toolCalls?.length)) {
      last.content += `\n\n${text}`;
    } else {
      turns.push({ role, content: text });
    }
  };
  for (const message of history) {
    const parts: MessagePart[] =
      message.parts ?? (message.content ? [{ type: 'text', round: 0, text: message.content }] : []);
    if (message.role === 'user') {
      say('user', textOf(parts) || message.content);
      continue;
    }
    const rounds = [...new Set(parts.map((p) => p.round))].sort((a, b) => a - b);
    for (const round of rounds) {
      const inRound = parts.filter((p) => p.round === round);
      const text = textOf(inRound);
      const calls = inRound.filter((p): p is ToolPart => p.type === 'tool');
      if (calls.length > 0) {
        turns.push({
          role: 'assistant',
          content: text,
          toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        });
        for (const call of calls) {
          const result = call.result ?? 'No result: the reply ended before it ran.';
          turns.push({
            role: 'tool',
            toolCallId: call.id,
            content:
              result.length > OLD_RESULT_CHARS
                ? `${result.slice(0, OLD_RESULT_CHARS)}\n\n[Cut short to save room. Call the tool again if you need it.]`
                : result,
          });
        }
      } else {
        say('assistant', text);
      }
      for (const feedback of inRound.filter((p) => p.type === 'feedback'))
        say('user', feedback.text);
    }
  }
  return turns;
}

/**
 * Drops the oldest turns until the rest fit the budget. The latest message always goes, even if
 * it's too big on its own; the model then says so itself. The kept history starts with the user,
 * so it never opens on a tool result whose call was dropped.
 */
export function fitHistory(turns: ChatMessage[], budget: number): ChatMessage[] {
  let start = 0;
  let total = turns.reduce((sum, t) => sum + tokensOf(t), 0);
  while (total > budget && start < turns.length - 1) {
    total -= tokensOf(turns[start]!);
    start++;
  }
  while (start < turns.length - 1 && turns[start]!.role !== 'user') start++;
  return turns.slice(start);
}

/**
 * Makes room in a reply that has grown near the context limit: tool results from all but the last
 * two rounds are cut to their first lines, oldest first, until it fits.
 */
export function compactTurns(messages: ChatMessage[], budget: number): void {
  let total = messages.reduce((sum, m) => sum + tokensOf(m), 0);
  if (total <= budget) return;
  const toolIndexes = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  // Keep the newest results whole: the model is working from them.
  const assistantIndexes = messages.flatMap((m, i) => (m.role === 'assistant' ? [i] : []));
  const protectFrom = assistantIndexes.at(-2) ?? messages.length;
  for (const i of toolIndexes) {
    if (total <= budget || i >= protectFrom) break;
    const message = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
    if (message.content.length <= 400) continue;
    const before = tokensOf(message);
    message.content = `${message.content.slice(0, 300)}\n\n[Cut to make room. Call the tool again if you need it.]`;
    total -= before - tokensOf(message);
  }
}

/**
 * The user's notes from the diff editor as a message to the clank, in their words: what they
 * rejected, commented on or changed themselves.
 */
export function formatNotes(notes: ReviewNote[]): string {
  const lines = (n: ReviewNote) =>
    n.startLine === null
      ? ''
      : n.endLine !== null && n.endLine !== n.startLine
        ? `lines ${n.startLine}–${n.endLine}`
        : `line ${n.startLine}`;
  const quote = (text: string) =>
    text
      .split('\n')
      .map((line) => `       ${line}`)
      .join('\n');
  const items = notes.map((note, i) => {
    const where = `\`${note.path}\``;
    let item: string;
    if (note.kind === 'reject') {
      item = `I rejected your change to ${where} at ${lines(note)}, so it's back as it was.${note.body ? ` ${note.body}` : ''}`;
      if (note.excerpt) item += `\n   You had written:\n${quote(note.excerpt)}`;
    } else if (note.kind === 'comment') {
      item = `About ${where}, ${lines(note)}: ${note.body}`;
      if (note.excerpt) item += `\n${quote(note.excerpt)}`;
    } else {
      const ranges = note.body
        ? `${/[,–]/.test(note.body) ? 'lines' : 'line'} ${note.body}`
        : lines(note);
      item = `I edited ${where} myself (${ranges}). Read it again before you change it.`;
    }
    return `${i + 1}. ${item}`;
  });
  return `My review notes from the diff editor:\n\n${items.join('\n')}`;
}

/** A chat's title from its first message: its opening words, on one line. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}
