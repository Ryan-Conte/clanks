import {
  type BoardEvent,
  type BoardEventKind,
  type BoardSnapshot,
  type Bounce,
  type Conversation,
  LEAD_CLANK,
  type MessageRecord,
  type MessageStatus,
  type ModelChoice,
  type NeedsYouItem,
  type NewTicket,
  type OutputType,
  type Project,
  type ProjectSummary,
  type RunRole,
  type SpecStory,
  type SpecVersion,
  type SpecVersionInfo,
  TICKET_COLUMNS,
  type Ticket,
  type TicketCard,
  type TicketColumn,
  type TicketLive,
  type TicketPatch,
  type TicketRun,
  type WorkflowMember,
  bounceTargets,
  changedStories,
  columnOf,
  criteriaOf,
  currentClank,
  makersOf,
  moveRefusal,
  normalizeStoryId,
  outputTypeSchema,
  parseCriterion,
  parseSpec,
  routeFor,
} from '@clanks/core';
import { type BoardAccess, type TicketDraft, ToolFailure } from '@clanks/tools';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Clank, CrewService } from '../crew/crew';
import type { ProjectService } from '../projects/service';
import { BoardStore } from './store';
import {
  type Names,
  projectContext,
  routeText,
  specSummary,
  specText,
  ticketDetail,
  ticketLine,
} from './text';

/** A board problem worded for the user, or for the clank whose tool call caused it. */
export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardError';
  }
}

/** A ticket that bounces more often than this stops looping and comes to the user. */
export const LOOP_LIMIT = 3;
/** How many feed lines the board shows. */
const FEED_LINES = 120;

/** What a run is for, as its prompt and tools need it. */
export interface RunScope {
  role: RunRole;
  ticket: Ticket;
  /** The run context's own part: the mode, the ticket, and how to finish. */
  brief: string;
}

/** What a chat or run in a project knows, for its prompt and its tools. */
export interface ChatScope {
  project: Project;
  /** The project's crew, for `{{crew}}` and `{{workflow}}`. */
  crew: Clank[];
  /** The project context layer. */
  context: string;
  /** Set while a run's ticket is with its clank, or for planning. */
  run: RunScope | null;
  access: BoardAccess;
}

/** How a reply in a run ended. */
export interface ReplyOutcome {
  status: MessageStatus;
  /** A finishing call handed the ticket on, or paused it on a question. */
  finished: boolean;
  error: string | null;
}

/** What the board needs from chats: to start and write to runs, and to see what's happening. */
export interface RunHost {
  createRun(input: {
    clankId: string;
    projectId: string;
    ticketId: string;
    role: RunRole;
    title: string;
  }): Conversation;
  /** Writes to a run as the app and starts a reply. Throws when the clank has no model. */
  post(conversationId: string, text: string): void;
  delete(conversationId: string): Promise<void>;
  inFlight(conversationId: string): MessageRecord | null;
  replying(conversationId: string): boolean;
  conversation(id: string): Conversation | undefined;
  inProject(projectId: string): Conversation[];
  forTicket(ticketId: string): Conversation[];
}

export interface BoardServiceOptions {
  db: ConstructorParameters<typeof BoardStore>[0];
  projects: ProjectService;
  crew: CrewService;
  userName: () => string;
  now?: () => Date;
}

/**
 * Each project's board: its tickets, the spec, and the activity feed. Tickets move only through
 * here, as the workflow allows. So far only spec tickets run on their own: Scribe writes, Atlas
 * signs off, the user approves, and Atlas plans the board from it. The crew's other tickets wait in
 * the backlog. Emits `change` with a project's id whenever its board changes.
 */
export class BoardService extends EventEmitter<{ change: [projectId: string] }> {
  private readonly store: BoardStore;
  private host: RunHost | null = null;
  /** Which project each conversation is in, so live events find their board cheaply. */
  private readonly projectOf = new Map<string, string | null>();

  constructor(private readonly options: BoardServiceOptions) {
    super();
    this.setMaxListeners(100);
    this.store = new BoardStore(options.db);
    options.projects.on('change', (id) => this.emit('change', id));
  }

  /** Chats start runs and say how they went; the orchestrator wires the two together. */
  attach(host: RunHost): void {
    this.host = host;
  }

  // Reading

  tickets(projectId: string): Ticket[] {
    return this.store.tickets(projectId);
  }

  ticket(id: string): Ticket {
    const found = this.store.ticket(id);
    if (!found) throw new BoardError('That ticket was deleted');
    return found;
  }

  specs(projectId: string): SpecVersion[] {
    return this.store.specs(projectId);
  }

  spec(projectId: string, version: number): SpecVersion {
    const found = this.store.spec(projectId, version);
    if (!found) throw new BoardError(`There's no spec v${version}`);
    return found;
  }

  ticketEvents(ticketId: string): BoardEvent[] {
    return this.store.ticketEvents(ticketId);
  }

  /** Every project with its column counts and what's going on, most recently changed first. */
  summaries(): ProjectSummary[] {
    return this.options.projects.list().map((p) => this.summarize(p, this.store.tickets(p.id)));
  }

  /** Everything the board shows. */
  snapshot(projectId: string): BoardSnapshot {
    const project = this.options.projects.get(projectId);
    const tickets = this.store.tickets(projectId);
    const bounces = this.store.bounces(tickets.map((t) => t.id));
    const conversations = this.host?.inProject(projectId) ?? [];
    const cards = tickets.map((ticket) => this.card(ticket, conversations, bounces));
    const specs: SpecVersionInfo[] = this.store.specs(projectId).map((s) => ({
      version: s.version,
      status: s.status,
      ticketId: s.ticketId,
      stories: parseSpec(s.body).stories.filter((story) => !story.removed).length,
      updatedAt: s.updatedAt,
      approvedAt: s.approvedAt,
    }));
    const needsYou = needsYouOf(cards, specs);
    return {
      project: this.summarize(project, tickets, cards, needsYou.length),
      tickets: cards,
      specs,
      events: this.store.events(projectId, FEED_LINES),
      needsYou,
    };
  }

  private summarize(
    project: Project,
    tickets: Ticket[],
    cards?: TicketCard[],
    needsYou?: number,
  ): ProjectSummary {
    const counts = Object.fromEntries(TICKET_COLUMNS.map((c) => [c, 0])) as Record<
      TicketColumn,
      number
    >;
    for (const t of tickets) counts[columnOf(t)]++;
    const conversations = this.host?.inProject(project.id) ?? [];
    const working = new Set(
      conversations.filter((c) => this.host?.replying(c.id)).map((c) => c.clankId),
    ).size;
    const items =
      needsYou ??
      needsYouOf(cards ?? tickets.map((t) => this.card(t, conversations, [])), []).length;
    return {
      ...project,
      crew: this.options.projects.members(project.id),
      counts,
      working,
      needsYou: items,
    };
  }

  private card(ticket: Ticket, conversations: Conversation[], bounces: Bounce[]): TicketCard {
    const runs: TicketRun[] = conversations
      .filter((c) => c.ticketId === ticket.id && c.role)
      .sort((a, b) => +a.createdAt - +b.createdAt)
      .map((c) => ({
        conversationId: c.id,
        clankId: c.clankId,
        role: c.role!,
        title: c.title,
        replying: this.host?.replying(c.id) ?? false,
      }));
    let live: TicketLive | null = null;
    const clank = currentClank(ticket);
    const run = runs.find((r) => r.clankId === clank && r.role !== 'planner' && r.replying);
    if (run) {
      const message = this.host?.inFlight(run.conversationId) ?? null;
      live = { conversationId: run.conversationId, clankId: run.clankId, ...liveOf(message) };
    }
    return {
      ...ticket,
      column: columnOf(ticket),
      live,
      runs,
      bounceHistory: bounces.filter((b) => b.ticketId === ticket.id),
    };
  }

  // What the user does on the board

  /** A card the user adds. It waits in the backlog; a spec ticket starts straight away. */
  addTicket(input: NewTicket): Ticket {
    const project = this.options.projects.get(input.projectId);
    const { ticket } = this.create(project, {
      title: input.title,
      type: input.type,
      description: input.description,
      stories: input.stories,
      criteria: input.criteria,
      assignee: input.assignee,
      dependsOn: [],
      actor: 'user',
      origin: 'board',
      conversationId: null,
      specVersion: null,
      proposed: false,
    });
    this.kick(project.id);
    return this.ticket(ticket.id);
  }

  editTicket(id: string, patch: TicketPatch): Ticket {
    const ticket = this.ticket(id);
    this.applyPatch(ticket, patch, 'user');
    return this.ticket(id);
  }

  assignTicket(id: string, clankId: string | null): Ticket {
    this.assign(this.ticket(id), clankId, 'user');
    return this.ticket(id);
  }

  linkTickets(id: string, dependsOnId: string, remove: boolean): void {
    const ticket = this.ticket(id);
    this.link(ticket, this.ticket(dependsOnId), remove, 'user');
  }

  /** Puts a backlog ticket before another, or at the end when `beforeId` is null. */
  reorder(id: string, beforeId: string | null): void {
    const ticket = this.ticket(id);
    const refusal = moveRefusal(ticket, 'backlog');
    if (refusal) throw new BoardError(refusal);
    const backlog = this.store
      .tickets(ticket.projectId)
      .filter((t) => columnOf(t) === 'backlog' && t.id !== id);
    const at = beforeId === null ? backlog.length : backlog.findIndex((t) => t.id === beforeId);
    if (at === -1) throw new BoardError("That ticket isn't in the backlog any more");
    const before = backlog[at - 1]?.rank;
    const after = backlog[at]?.rank;
    const rank =
      before === undefined && after === undefined
        ? 1
        : before === undefined
          ? after! - 1
          : after === undefined
            ? before + 1
            : (before + after) / 2;
    this.store.updateTicket(id, { rank, updatedAt: this.now() });
    const where =
      at === 0
        ? 'to the top'
        : at === backlog.length
          ? 'to the bottom'
          : `after ${backlog[at - 1]!.key}`;
    this.event(ticket.projectId, ticket.id, 'user', 'moved', `moved ${ticket.key} ${where}`);
  }

  /** A drag to another column. The workflow decides; a drag never approves anything. */
  move(id: string, column: TicketColumn): void {
    const ticket = this.ticket(id);
    const refusal = moveRefusal(ticket, column);
    if (refusal) throw new BoardError(refusal);
  }

  /** Deletes a ticket and its runs. Work on their branches stays. */
  async removeTicket(id: string): Promise<void> {
    const ticket = this.ticket(id);
    for (const conversation of this.host?.forTicket(id) ?? []) {
      await this.host!.delete(conversation.id);
    }
    const draft = this.store.specs(ticket.projectId).find((s) => s.ticketId === id);
    if (draft && draft.status !== 'approved') {
      this.store.updateSpec(draft.id, { ticketId: null, status: 'draft', updatedAt: this.now() });
    }
    this.store.deleteTicket(id);
    this.event(ticket.projectId, null, 'user', 'deleted', `deleted ${ticket.key}: ${ticket.title}`);
  }

  /** Takes a clank's proposal onto the board. */
  accept(id: string): Ticket {
    const ticket = this.ticket(id);
    if (!ticket.proposed) throw new BoardError(`${ticket.key} isn't a proposal`);
    this.store.updateTicket(id, { proposed: false, updatedAt: this.now() });
    this.event(ticket.projectId, id, 'user', 'accepted', `accepted ${ticket.key}`);
    this.kick(ticket.projectId);
    return this.ticket(id);
  }

  /**
   * Approves a ticket that's ready for the user. For a spec, its draft becomes the project's spec,
   * and Atlas plans the board from it.
   */
  approve(id: string): Ticket {
    const ticket = this.ticket(id);
    if (columnOf(ticket) !== 'ready') throw new BoardError(`${ticket.key} isn't ready for you yet`);
    const now = this.now();
    let approved: SpecVersion | null = null;
    if (ticket.type === 'spec') {
      const draft = this.draftOf(ticket);
      if (!draft) throw new BoardError(`${ticket.key} has no draft of the spec to approve`);
      if (parseSpec(draft.body).stories.length === 0) {
        throw new BoardError("The draft has no stories yet, so there's nothing to approve");
      }
      this.store.updateSpec(draft.id, { status: 'approved', approvedAt: now, updatedAt: now });
      approved = { ...draft, status: 'approved', approvedAt: now };
    }
    this.store.updateTicket(id, { doneAt: now, state: 'idle', reason: null, updatedAt: now });
    this.event(
      ticket.projectId,
      id,
      'user',
      'approved',
      approved ? `approved spec v${approved.version} (${ticket.key})` : `approved ${ticket.key}`,
    );
    if (approved) this.plan(ticket, approved);
    this.kick(ticket.projectId);
    return this.ticket(id);
  }

  /** Sends a ticket that's ready for the user back to its maker, with what to change. */
  requestChanges(id: string, comment: string): Ticket {
    const ticket = this.ticket(id);
    if (columnOf(ticket) !== 'ready') throw new BoardError(`${ticket.key} isn't ready for you yet`);
    const maker = ticket.route[0]?.clankId;
    if (!maker) throw new BoardError(`${ticket.key} has no maker to send it back to`);
    this.sendBack(ticket, 'user', maker, comment, [], false);
    return this.ticket(id);
  }

  /** Starts a paused or failed run again, with a note from the user if they give one. */
  retry(id: string, note = ''): Ticket {
    const ticket = this.ticket(id);
    if (!['failed', 'paused'].includes(ticket.state)) {
      throw new BoardError(`${ticket.key} isn't stopped`);
    }
    const clank = currentClank(ticket);
    if (!clank) throw new BoardError(`${ticket.key} isn't with a clank`);
    this.store.updateTicket(id, { state: 'working', reason: null, updatedAt: this.now() });
    this.run(
      this.ticket(id),
      `Carry on with ${ticket.key}.${note.trim() ? `\n\n${note.trim()}` : ''}`,
    );
    return this.ticket(id);
  }

  /** Deletes a project's chats and runs, then the project. Its folder and branches stay. */
  async deleteProject(id: string): Promise<void> {
    this.options.projects.get(id);
    for (const conversation of this.host?.inProject(id) ?? []) {
      await this.host!.delete(conversation.id);
    }
    this.options.projects.remove(id);
  }

  // What chats and runs need

  /** A project's workspace, for a chat with a clank in its crew. */
  chatFolder(projectId: string, clankId: string): string {
    const project = this.options.projects.get(projectId);
    if (!this.options.projects.inCrew(projectId, clankId)) {
      throw new BoardError(
        `${this.names().clank(clankId)} isn't in ${project.name}'s crew. Add it in the project's settings.`,
      );
    }
    return project.folder;
  }

  /** A clank's model in a project, if the project picks one. */
  modelFor(projectId: string, clankId: string): ModelChoice | null {
    return this.options.projects.modelFor(projectId, clankId);
  }

  /** What a chat or run in a project knows. Null for a chat outside one. */
  scope(conversation: Conversation): ChatScope | null {
    if (!conversation.projectId) return null;
    const project = this.options.projects.find(conversation.projectId);
    if (!project) return null;
    const crew = this.options.projects.clanks(project.id);
    const tickets = this.store.tickets(project.id);
    const names = this.names();
    let run: RunScope | null = null;
    if (conversation.ticketId && conversation.role) {
      const ticket = tickets.find((t) => t.id === conversation.ticketId);
      if (ticket && conversation.role === 'planner') {
        run = { role: 'planner', ticket, brief: this.planBrief(project, ticket, tickets, names) };
      } else if (ticket && !ticket.doneAt && currentClank(ticket) === conversation.clankId) {
        const role = ticket.route[ticket.step]!.role;
        run = {
          role,
          ticket,
          brief: this.ticketBrief(ticket, tickets, conversation.clankId, names),
        };
      }
    }
    const specs = this.store.specs(project.id);
    const approved = specs.filter((s) => s.status === 'approved').at(-1) ?? null;
    const draft = specs.find((s) => s.status !== 'approved') ?? null;
    return {
      project,
      crew,
      context: projectContext({
        project,
        approved,
        draft,
        draftTicket: draft?.ticketId
          ? (tickets.find((t) => t.id === draft.ticketId) ?? null)
          : null,
        tickets,
        names,
      }),
      run,
      access: this.access(project, conversation),
    };
  }

  /** The worktree and branch name for a run: the ticket's key for its maker. */
  workName(conversation: Pick<Conversation, 'ticketId' | 'role' | 'clankId'>): string | null {
    if (!conversation.ticketId || !conversation.role || conversation.role === 'planner')
      return null;
    const ticket = this.store.ticket(conversation.ticketId);
    if (!ticket) return null;
    return conversation.role === 'maker' ? ticket.key : `${ticket.key}-${conversation.clankId}`;
  }

  /** A reply began in a run: the user answered its question, or carried it on. */
  replyStarted(conversation: Conversation): void {
    this.remember(conversation);
    const ticket = this.runTicket(conversation);
    if (!ticket || ticket.state === 'working') return;
    if (['question', 'paused', 'failed', 'idle'].includes(ticket.state)) {
      this.store.updateTicket(ticket.id, { state: 'working', reason: null, updatedAt: this.now() });
      this.emit('change', ticket.projectId);
    }
  }

  /** A reply in a run ended. One that didn't hand the ticket on leaves it stopped. */
  replyEnded(conversation: Conversation, outcome: ReplyOutcome): void {
    if (!conversation.projectId) return;
    if (conversation.role === 'planner' && conversation.ticketId) {
      const created = this.store
        .tickets(conversation.projectId)
        .filter((t) => t.conversationId === conversation.id);
      if (created.length > 0) {
        this.event(
          conversation.projectId,
          null,
          conversation.clankId,
          'planned',
          `${conversation.title.replace(/^Plan /, '')}: created ${created.length} ${created.length === 1 ? 'ticket' : 'tickets'}`,
        );
      }
      this.emit('change', conversation.projectId);
      return;
    }
    const ticket = this.runTicket(conversation);
    if (!ticket || outcome.finished || ticket.state !== 'working') {
      this.emit('change', conversation.projectId);
      return;
    }
    const name = this.names().clank(conversation.clankId);
    let state: Ticket['state'];
    let reason: string;
    if (outcome.status === 'cancelled') {
      state = 'paused';
      reason = `${cap(this.options.userName())} stopped ${name}.`;
    } else if (outcome.status === 'failed') {
      state = 'failed';
      reason = outcome.error ?? `${name}'s reply failed.`;
    } else {
      state = 'failed';
      reason = `${name} stopped without handing the ticket on.`;
    }
    this.store.updateTicket(ticket.id, { state, reason, updatedAt: this.now() });
    this.event(
      ticket.projectId,
      ticket.id,
      conversation.clankId,
      'failed',
      state === 'paused' ? `paused on ${ticket.key}` : `stopped on ${ticket.key}: ${reason}`,
    );
  }

  /** A run's ticket, while it's with the run's clank. */
  private runTicket(conversation: Conversation): Ticket | null {
    if (!conversation.ticketId || !conversation.role || conversation.role === 'planner')
      return null;
    const ticket = this.store.ticket(conversation.ticketId);
    if (!ticket || ticket.doneAt || currentClank(ticket) !== conversation.clankId) return null;
    return ticket;
  }

  /** Something happened in a conversation, which may show on a board. */
  touchConversation(conversationId: string): void {
    let projectId = this.projectOf.get(conversationId);
    if (projectId === undefined) {
      projectId = this.host?.conversation(conversationId)?.projectId ?? null;
      this.projectOf.set(conversationId, projectId);
    }
    if (projectId) this.emit('change', projectId);
  }

  private remember(conversation: Conversation): void {
    this.projectOf.set(conversation.id, conversation.projectId);
  }

  /** After a restart, runs that were working are paused, so the user can carry them on. */
  recover(): void {
    for (const project of this.options.projects.list()) {
      for (const ticket of this.store.tickets(project.id)) {
        if (ticket.state !== 'working') continue;
        const clank = currentClank(ticket);
        this.store.updateTicket(ticket.id, {
          state: 'paused',
          reason: `clanks closed while ${clank ? this.names().clank(clank) : 'the crew'} worked on it.`,
        });
      }
    }
  }

  // Tickets

  private create(
    project: Project,
    input: {
      title: string;
      type: string;
      description: string;
      stories: string[];
      criteria: string[];
      assignee: string | null;
      dependsOn: string[];
      actor: string;
      origin: Ticket['origin'];
      conversationId: string | null;
      specVersion: number | null;
      proposed: boolean;
    },
  ): { ticket: Ticket; notes: string[] } {
    const type = outputTypeSchema.safeParse(input.type);
    if (!type.success) {
      throw new BoardError(
        `"${input.type}" isn't a ticket type. Use one of: ${outputTypeSchema.options.join(', ')}.`,
      );
    }
    const crew = this.members(project.id);
    const tickets = this.store.tickets(project.id);
    let assignee = this.makerFor(type.data, input.assignee, crew);
    if (type.data === 'spec') {
      const active = tickets.find((t) => t.type === 'spec' && !t.doneAt);
      if (active) {
        throw new BoardError(
          `${active.key} is already writing the spec. Change it with board_update_ticket, or wait until it's approved.`,
        );
      }
      assignee ??= makersOf('spec', crew)[0]!.id;
    }
    // A story that isn't in the spec costs the ticket its reference, never the ticket itself.
    const notes: string[] = [];
    let description = input.description.trim();
    const specStories = this.specStories(project.id);
    let stories = [...new Set(input.stories.map(normalizeStoryId))];
    if (type.data === 'spec' && input.stories.length > 0) {
      // A spec ticket writes the stories; any it's given are a start for its writer.
      const start = input.stories.map((s) => `- ${s.trim()}`).join('\n');
      description = `${description}\n\nStories to start from:\n${start}`.trim();
      stories = [];
      notes.push(
        'A spec ticket writes the stories, so the ones you gave are in its description to start from.',
      );
    } else {
      const unknown = stories.filter((id) => !specStories.some((s) => s.id === id));
      if (unknown.length > 0) {
        stories = stories.filter((id) => !unknown.includes(id));
        notes.push(
          specStories.length === 0
            ? `There's no spec with stories yet, so it doesn't reference ${unknown.join(', ')}.`
            : `${unknown.join(', ')} ${unknown.length === 1 ? "isn't" : "aren't"} in the spec, so it doesn't reference ${unknown.length === 1 ? 'it' : 'them'}. The spec's stories: ${specStories.map((s) => s.id).join(', ')}.`,
        );
      }
    }
    const criteria =
      input.criteria.length > 0
        ? input.criteria.map(parseCriterion)
        : criteriaOf(stories, specStories);
    const dependsOn = input.dependsOn.map((key) => this.byKey(project, key).id);
    const number = this.options.projects.takeNumber(project.id);
    const now = this.now();
    const ticket: Ticket = {
      id: randomUUID(),
      projectId: project.id,
      number,
      key: `${project.key}-${number}`,
      title: input.title.trim(),
      description,
      type: type.data,
      stories,
      criteria,
      assignee,
      route: routeFor(type.data, assignee, crew),
      step: -1,
      state: 'idle',
      reason: null,
      bounces: 0,
      rank: (this.store.rankBounds(project.id)?.max ?? 0) + 1,
      origin: input.origin,
      createdBy: input.actor,
      proposed: input.proposed,
      specVersion:
        type.data === 'spec'
          ? this.store.latestVersion(project.id) + (this.draft(project.id) ? 0 : 1)
          : input.specVersion,
      progress: null,
      output: null,
      reviews: [],
      conversationId: input.conversationId,
      dependsOn: [...new Set(dependsOn)],
      createdAt: now,
      updatedAt: now,
      doneAt: null,
    };
    this.store.insertTicket(ticket);
    const names = this.names();
    this.event(
      project.id,
      ticket.id,
      input.actor,
      input.proposed ? 'proposed' : 'created',
      `${input.proposed ? 'proposed' : 'created'} ${ticket.key}: ${ticket.title}${assignee ? ` for ${names.clank(assignee)}` : ''}`,
    );
    return { ticket, notes };
  }

  /** The maker a ticket gets: the one asked for, if it makes the type, or none for open. */
  private makerFor(type: OutputType, wanted: string | null, crew: WorkflowMember[]): string | null {
    const makers = makersOf(type, crew);
    if (makers.length === 0) {
      throw new BoardError(
        `Nobody in this project's crew makes ${type} tickets. ${this.options.userName()} can add a clank that does in the project's settings.`,
      );
    }
    const asked = wanted?.trim();
    if (!asked || /^(open|none|null|any)$/i.test(asked)) return null;
    const found = crew.find(
      (c) => c.id === asked.toLowerCase() || c.name.toLowerCase() === asked.toLowerCase(),
    );
    if (!found) {
      throw new BoardError(
        `There's no ${asked} in this crew. ${makers.map((m) => `${m.name} (${m.id})`).join(', ')} ${makers.length === 1 ? 'makes' : 'make'} ${type} tickets, or leave it open.`,
      );
    }
    if (!makers.includes(found)) {
      throw new BoardError(
        `${found.name} doesn't make ${type} tickets. ${makers.map((m) => `${m.name} (${m.id})`).join(', ')} ${makers.length === 1 ? 'does' : 'do'}, or leave it open.`,
      );
    }
    return found.id;
  }

  private applyPatch(ticket: Ticket, patch: TicketPatch, actor: string): void {
    if (ticket.doneAt) throw new BoardError(`${ticket.key} is done, so it can't change`);
    const changes: Parameters<BoardStore['updateTicket']>[1] = { updatedAt: this.now() };
    if (patch.title !== undefined) changes.title = patch.title.trim();
    if (patch.description !== undefined) changes.description = patch.description.trim();
    if (patch.stories !== undefined) {
      const stories = [...new Set(patch.stories.map(normalizeStoryId))];
      const known = this.specStories(ticket.projectId);
      const unknown = stories.filter((id) => !known.some((s) => s.id === id));
      if (unknown.length > 0) throw new BoardError(`${unknown.join(', ')} isn't in the spec`);
      changes.stories = stories;
    }
    if (patch.criteria !== undefined) changes.criteria = patch.criteria.map(parseCriterion);
    this.store.updateTicket(ticket.id, changes);
    this.event(ticket.projectId, ticket.id, actor, 'updated', `updated ${ticket.key}`);
  }

  private assign(ticket: Ticket, clankId: string | null, actor: string): void {
    if (ticket.step >= 0 || ticket.doneAt) {
      throw new BoardError(`${ticket.key} has started, so it can't change hands now`);
    }
    const crew = this.members(ticket.projectId);
    const maker = this.makerFor(ticket.type, clankId, crew);
    if (ticket.type === 'spec' && maker === null) {
      throw new BoardError('A spec ticket needs its writer');
    }
    this.store.updateTicket(ticket.id, {
      assignee: maker,
      route: routeFor(ticket.type, maker, crew),
      updatedAt: this.now(),
    });
    const names = this.names();
    this.event(
      ticket.projectId,
      ticket.id,
      actor,
      'assigned',
      maker ? `assigned ${ticket.key} to ${names.clank(maker)}` : `made ${ticket.key} open`,
    );
    this.kick(ticket.projectId);
  }

  private link(ticket: Ticket, dependsOn: Ticket, remove: boolean, actor: string): void {
    if (ticket.projectId !== dependsOn.projectId)
      throw new BoardError("They're in different projects");
    if (remove) {
      this.store.removeDependency(ticket.id, dependsOn.id);
      this.event(
        ticket.projectId,
        ticket.id,
        actor,
        'linked',
        `${ticket.key} no longer waits on ${dependsOn.key}`,
      );
      this.kick(ticket.projectId);
      return;
    }
    if (ticket.id === dependsOn.id) throw new BoardError("A ticket can't wait on itself");
    if (ticket.step >= 0 || ticket.doneAt) {
      throw new BoardError(`${ticket.key} has started, so it can't wait on anything now`);
    }
    // Would `dependsOn` end up waiting on `ticket`?
    const all = this.store.tickets(ticket.projectId);
    const seen = new Set<string>();
    const stack = [dependsOn.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === ticket.id) {
        throw new BoardError(
          `That would make a loop: ${dependsOn.key} already waits on ${ticket.key}`,
        );
      }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(all.find((t) => t.id === id)?.dependsOn ?? []));
    }
    this.store.addDependency(ticket.id, dependsOn.id);
    this.store.updateTicket(ticket.id, { updatedAt: this.now() });
    this.event(
      ticket.projectId,
      ticket.id,
      actor,
      'linked',
      `${ticket.key} waits on ${dependsOn.key}`,
    );
  }

  /** A ticket by its key, such as SURF-12, in a project. */
  private byKey(project: Project, key: string): Ticket {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)-(\d+)\s*$/.exec(key);
    if (!match)
      throw new BoardError(`"${key}" isn't a ticket key; they look like ${project.key}-12`);
    if (match[1]!.toUpperCase() !== project.key) {
      throw new BoardError(`${key} isn't on this board; its keys start with ${project.key}-`);
    }
    const ticket = this.store.byNumber(project.id, Number(match[2]));
    if (!ticket)
      throw new BoardError(`There's no ${project.key}-${Number(match[2])} on this board`);
    return ticket;
  }

  // The workflow

  /**
   * Starts what's ready to run. So far that's spec tickets: in the backlog, not a proposal, with
   * what they wait on done.
   */
  private kick(projectId: string): void {
    const tickets = this.store.tickets(projectId);
    for (const ticket of tickets) {
      if (ticket.type !== 'spec' || ticket.step >= 0 || ticket.doneAt || ticket.proposed) continue;
      const waiting = ticket.dependsOn.some((id) => !tickets.find((t) => t.id === id)?.doneAt);
      if (!waiting) this.start(ticket);
    }
  }

  private start(ticket: Ticket): void {
    const crew = this.members(ticket.projectId);
    const maker = ticket.assignee ?? makersOf(ticket.type, crew)[0]?.id ?? null;
    if (!maker) return;
    const route = routeFor(ticket.type, maker, crew);
    this.store.updateTicket(ticket.id, {
      assignee: maker,
      route,
      step: 0,
      state: 'working',
      reason: null,
      updatedAt: this.now(),
    });
    if (ticket.type === 'spec') {
      const draft = this.draft(ticket.projectId);
      if (draft) this.store.updateSpec(draft.id, { ticketId: ticket.id, status: 'draft' });
    }
    this.event(ticket.projectId, ticket.id, maker, 'started', `started ${ticket.key}`);
    this.run(this.ticket(ticket.id), `Start on ${ticket.key}: ${ticket.title}.`);
  }

  /** Hands a ticket to the clank whose turn it is, in its run for this ticket. */
  private run(ticket: Ticket, brief: string): void {
    const clank = currentClank(ticket);
    const step = ticket.route[ticket.step];
    if (!clank || !step || !this.host) return;
    const existing = this.host
      .forTicket(ticket.id)
      .find((c) => c.clankId === clank && c.role === step.role);
    const name = this.names().clank(clank);
    try {
      const conversation =
        existing ??
        this.host.createRun({
          clankId: clank,
          projectId: ticket.projectId,
          ticketId: ticket.id,
          role: step.role,
          title: `${ticket.key}: ${ticket.title}`,
        });
      this.remember(conversation);
      this.host.post(conversation.id, brief);
    } catch (error) {
      const reason = `${name} couldn't start: ${error instanceof Error ? error.message : String(error)}`;
      this.store.updateTicket(ticket.id, { state: 'failed', reason, updatedAt: this.now() });
      this.event(ticket.projectId, ticket.id, 'app', 'failed', `${ticket.key}: ${reason}`);
    }
  }

  /** The maker or a checker is done: the ticket goes to the next on its route, or to the user. */
  private forward(ticket: Ticket, actor: string, kind: 'submitted' | 'passed'): void {
    const names = this.names();
    const step = ticket.step + 1;
    const now = this.now();
    this.store.updateTicket(ticket.id, {
      step,
      state: step < ticket.route.length ? 'working' : 'idle',
      reason: null,
      progress: null,
      updatedAt: now,
    });
    const next = this.ticket(ticket.id);
    if (step >= ticket.route.length) {
      if (ticket.type === 'spec') {
        const draft = this.draftOf(ticket);
        if (draft) this.store.updateSpec(draft.id, { status: 'signed_off', updatedAt: now });
      }
      this.event(
        ticket.projectId,
        ticket.id,
        actor,
        kind,
        kind === 'passed'
          ? `signed off ${ticket.key}, ready for you`
          : `submitted ${ticket.key}, ready for you`,
      );
      return;
    }
    this.event(ticket.projectId, ticket.id, actor, kind, `${kind} ${ticket.key}`);
    const maker = ticket.route[0]?.clankId;
    const handedIn = maker ? names.clank(maker) : 'Its maker';
    const what =
      ticket.type === 'spec'
        ? `${handedIn} handed in the spec on ${ticket.key}. Read the draft and check it.`
        : `${handedIn} handed in ${ticket.key}. Check it against its criteria.`;
    this.run(next, what);
  }

  /** Sends a ticket back along its route, with why. The user's requests don't count as bounces. */
  private sendBack(
    ticket: Ticket,
    from: string,
    to: string,
    reason: string,
    issues: string[],
    counts: boolean,
  ): void {
    const names = this.names();
    const now = this.now();
    this.store.addBounce({
      id: randomUUID(),
      ticketId: ticket.id,
      from,
      to,
      reason,
      issues,
      at: now,
    });
    const bounces = ticket.bounces + (counts ? 1 : 0);
    const by = from === 'user' ? cap(this.options.userName()) : names.clank(from);
    if (counts && bounces > LOOP_LIMIT) {
      this.store.updateTicket(ticket.id, {
        bounces,
        step: ticket.route.length,
        state: 'looping',
        reason: `It was sent back ${bounces} times. The last time, ${by} said: ${reason}`,
        updatedAt: now,
      });
      this.event(
        ticket.projectId,
        ticket.id,
        'app',
        'looping',
        `${ticket.key} bounced ${bounces} times and came to you`,
      );
      return;
    }
    const step = ticket.route.findIndex((s) => s.clankId === to);
    this.store.updateTicket(ticket.id, {
      bounces,
      step,
      state: 'working',
      reason: null,
      progress: null,
      updatedAt: now,
    });
    if (ticket.type === 'spec') {
      const draft = this.draftOf(ticket);
      if (draft) this.store.updateSpec(draft.id, { status: 'draft', updatedAt: now });
    }
    this.event(
      ticket.projectId,
      ticket.id,
      from,
      from === 'user' ? 'changes' : 'bounced',
      from === 'user'
        ? `asked for changes on ${ticket.key}: ${short(reason)}`
        : `bounced ${ticket.key} to ${names.clank(to)}: ${short(reason)}`,
    );
    const list = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
    const brief =
      from === 'user'
        ? `${by} asked for changes on ${ticket.key}:\n\n${reason}\n\nMake them, then hand it in again.`
        : `${by} sent ${ticket.key} back to you: ${reason}${list ? `\n\n${list}` : ''}\n\nFix ${issues.length > 1 ? 'these' : 'it'}, then hand it in again.`;
    this.run(this.ticket(ticket.id), brief);
  }

  /** Atlas plans the board from an approved spec, in a run of its own. */
  private plan(specTicket: Ticket, spec: SpecVersion): void {
    if (!this.host) return;
    try {
      const conversation = this.host.createRun({
        clankId: LEAD_CLANK,
        projectId: specTicket.projectId,
        ticketId: specTicket.id,
        role: 'planner',
        title: `Plan spec v${spec.version}`,
      });
      this.remember(conversation);
      this.host.post(
        conversation.id,
        `${cap(this.options.userName())} approved spec v${spec.version}. Turn it into tickets on the board.`,
      );
    } catch (error) {
      this.event(
        specTicket.projectId,
        specTicket.id,
        'app',
        'failed',
        `Atlas couldn't plan spec v${spec.version}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Specs

  /** The draft of the next version, if one is being written. */
  private draft(projectId: string): SpecVersion | null {
    return this.store.specs(projectId).find((s) => s.status !== 'approved') ?? null;
  }

  /** The draft a spec ticket writes. */
  private draftOf(ticket: Ticket): SpecVersion | null {
    const draft = this.draft(ticket.projectId);
    return draft && (draft.ticketId === ticket.id || draft.ticketId === null) ? draft : null;
  }

  private approvedSpec(projectId: string): SpecVersion | null {
    return (
      this.store
        .specs(projectId)
        .filter((s) => s.status === 'approved')
        .at(-1) ?? null
    );
  }

  /** The stories tickets can reference: the approved spec's, or the draft's before there is one. */
  private specStories(projectId: string): SpecStory[] {
    const spec = this.approvedSpec(projectId) ?? this.draft(projectId);
    return spec ? parseSpec(spec.body).stories : [];
  }

  // The tools' side

  /** The board as one clank's tools reach it, in one chat or run. */
  private access(project: Project, conversation: Conversation): BoardAccess {
    const actor = conversation.clankId;
    const names = () => this.names();
    /** The ticket this run works, as it is now, while it's with this clank. */
    const own = (role?: 'maker' | 'checker'): Ticket => {
      const ticket = conversation.role !== 'planner' ? this.runTicket(conversation) : null;
      if (!ticket) {
        const on = conversation.ticketId ? this.store.ticket(conversation.ticketId) : null;
        throw new BoardError(
          on
            ? `${on.key} isn't with you now${currentClank(on) ? `; it's with ${names().clank(currentClank(on)!)}` : ''}.`
            : 'That works only on a ticket run.',
        );
      }
      if (role && ticket.route[ticket.step]?.role !== role) {
        throw new BoardError(
          role === 'maker'
            ? "You're checking this ticket, not making it."
            : "You're making this ticket, not checking it.",
        );
      }
      return ticket;
    };
    /** Small models read "nothing happened" better than a reason alone, so failures say it. */
    const guard =
      <A extends unknown[]>(work: (...args: A) => string, failed = '') =>
      (...args: A): string => {
        try {
          return work(...args);
        } catch (error) {
          if (error instanceof BoardError) {
            throw new ToolFailure(failed ? `${failed} ${error.message}` : error.message);
          }
          throw error;
        }
      };
    const planning = conversation.role === 'planner';
    const lead = actor === LEAD_CLANK;

    return {
      list: guard((filter) => {
        const all = this.store.tickets(project.id);
        const query = filter.query?.toLowerCase().trim();
        const assignee = filter.assignee?.toLowerCase().trim();
        const shown = all.filter(
          (t) =>
            (!filter.column || columnOf(t) === filter.column) &&
            (!assignee || (assignee === 'open' ? t.assignee === null : t.assignee === assignee)) &&
            (!query || t.title.toLowerCase().includes(query)),
        );
        if (all.length === 0) return `The board for ${project.name} is empty.`;
        if (shown.length === 0) return `No tickets match. The board has ${all.length}.`;
        const header =
          shown.length === all.length
            ? `${project.name}: ${all.length} ${all.length === 1 ? 'ticket' : 'tickets'}`
            : `${shown.length} of ${all.length} tickets`;
        return [header, '', ...shown.map((t) => ticketLine(t, all, names()))].join('\n');
      }),

      get: guard((key) => {
        const ticket = this.byKey(project, key);
        return ticketDetail(ticket, {
          all: this.store.tickets(project.id),
          bounces: this.store.bounces([ticket.id]),
          names: names(),
        });
      }),

      create: guard((draft: TicketDraft) => {
        const proposed = !lead;
        const { ticket, notes } = this.create(project, {
          ...draft,
          actor,
          origin: planning ? 'spec' : proposed ? 'proposal' : 'chat',
          conversationId: conversation.id,
          specVersion: planning ? (this.approvedSpec(project.id)?.version ?? null) : null,
          proposed,
        });
        this.kick(project.id);
        const created = this.ticket(ticket.id);
        const n = names();
        const deps = created.dependsOn
          .map((id) => this.store.ticket(id)?.key)
          .filter(Boolean)
          .join(', ');
        return [
          proposed
            ? `Filed ${created.key} as a proposal: Atlas will take it on, merge it or close it.`
            : `Created ${created.key}: ${created.title}.`,
          `Type ${created.type}, ${created.assignee ? `for ${n.clank(created.assignee)}` : 'open'}. Route: ${routeText(created, n)}.`,
          // A spec ticket's criteria are the spec's own.
          created.criteria.length > 0 || created.type === 'spec'
            ? deps
              ? `Waits on ${deps}.`
              : ''
            : `It has no acceptance criteria yet${deps ? `, and waits on ${deps}` : ''}. Add them with board_update_ticket, so its maker knows when it's done.`,
          created.criteria.length > 0 ? `${created.criteria.length} acceptance criteria.` : '',
          ...notes,
          created.step >= 0 ? `${n.clank(currentClank(created)!)} has started on it.` : '',
        ]
          .filter(Boolean)
          .join(' ');
      }, 'No ticket was made.'),

      update: guard((input) => {
        const ticket = this.byKey(project, input.key);
        this.applyPatch(ticket, input, actor);
        return `Updated ${ticket.key}.`;
      }, 'Nothing changed.'),

      link: guard((input) => {
        const ticket = this.byKey(project, input.key);
        const other = this.byKey(project, input.dependsOn);
        this.link(ticket, other, input.remove, actor);
        return input.remove
          ? `${ticket.key} no longer waits on ${other.key}.`
          : `${ticket.key} now waits on ${other.key}.`;
      }, 'Nothing changed.'),

      assign: guard((input) => {
        const ticket = this.byKey(project, input.key);
        this.assign(ticket, input.clank, actor);
        const next = this.ticket(ticket.id);
        return next.assignee
          ? `${ticket.key} is ${names().clank(next.assignee)}'s.`
          : `${ticket.key} is open for the first free ${ticket.type} maker.`;
      }),

      readSpec: guard((version) => {
        const specs = this.store.specs(project.id);
        const n = names();
        if (specs.length === 0) return 'This project has no spec yet.';
        const listed = specs.map(
          (s) => `v${s.version}${s.status === 'approved' ? '' : ' (draft)'}`,
        );
        let spec: SpecVersion | undefined;
        if (typeof version === 'number') {
          spec = specs.find((s) => s.version === version);
          if (!spec)
            throw new BoardError(`There's no spec v${version}. Versions: ${listed.join(', ')}.`);
        } else if (version === 'draft') {
          spec = specs.find((s) => s.status !== 'approved');
          if (!spec) return `There's no draft. The approved spec is v${specs.at(-1)!.version}.`;
        } else {
          const ticket = conversation.ticketId ? this.store.ticket(conversation.ticketId) : null;
          const draft = specs.find((s) => s.status !== 'approved');
          spec =
            ticket?.type === 'spec' && !planning && draft
              ? draft
              : (specs.filter((s) => s.status === 'approved').at(-1) ?? draft);
          if (ticket?.type === 'spec' && !planning && !draft) {
            const approved = specs.filter((s) => s.status === 'approved').at(-1)!;
            return `${specText(approved, n)}\n\n---\n\nThere's no draft of v${approved.version + 1} yet. Write the whole new version with spec_write.`;
          }
        }
        return specText(spec!, n);
      }),

      writeSpec: guard((content) => {
        const ticket = own('maker');
        if (ticket.type !== 'spec') {
          throw new BoardError(
            `Only a spec ticket changes the spec, and ${ticket.key} makes a ${ticket.type}.`,
          );
        }
        const now = this.now();
        let draft = this.draftOf(ticket);
        if (draft) {
          this.store.updateSpec(draft.id, {
            body: content,
            status: 'draft',
            ticketId: ticket.id,
            updatedAt: now,
          });
          draft = { ...draft, body: content, status: 'draft' };
        } else {
          draft = {
            id: randomUUID(),
            projectId: project.id,
            version: this.store.latestVersion(project.id) + 1,
            body: content,
            status: 'draft',
            ticketId: ticket.id,
            createdAt: now,
            updatedAt: now,
            approvedAt: null,
          };
          this.store.insertSpec(draft);
          this.store.updateTicket(ticket.id, { specVersion: draft.version });
        }
        this.emit('change', project.id);
        return specSummary(draft);
      }),

      progress: guard((input) => {
        const ticket = own();
        this.store.updateTicket(ticket.id, {
          progress: { message: input.message, steps: input.steps },
          updatedAt: this.now(),
        });
        this.emit('change', project.id);
        return 'Posted.';
      }),

      submit: guard((output) => {
        const ticket = own('maker');
        if (String(output.type) !== ticket.type) {
          throw new BoardError(
            `${ticket.key} makes a ${ticket.type}; hand it in with type ${ticket.type}.`,
          );
        }
        if (ticket.type === 'spec') {
          const draft = this.draftOf(ticket);
          if (!draft) throw new BoardError('Write the spec with spec_write before you hand it in.');
          const { stories, problems } = parseSpec(draft.body);
          const blocking = problems.filter((p) => !/ is under | without an AC number/.test(p));
          if (stories.length === 0 || blocking.length > 0) {
            throw new BoardError(
              `The draft isn't ready to hand in. Fix these with spec_write first:\n${(stories.length === 0 ? problems : blocking).map((p) => `- ${p}`).join('\n')}`,
            );
          }
          this.store.updateSpec(draft.id, { status: 'review', updatedAt: this.now() });
        }
        this.store.updateTicket(ticket.id, { output, updatedAt: this.now() });
        this.forward(ticket, actor, 'submitted');
        const next = this.ticket(ticket.id);
        const who = currentClank(next);
        return `Handed in. ${ticket.key} goes to ${who ? names().clank(who) : this.options.userName()} next. Your run ends here.`;
      }),

      pass: guard((review) => {
        const ticket = own('checker');
        const reviews = [
          ...ticket.reviews,
          { ...review, clankId: actor, at: this.now().toISOString() },
        ];
        this.store.updateTicket(ticket.id, { reviews, updatedAt: this.now() });
        this.forward(ticket, actor, 'passed');
        const next = this.ticket(ticket.id);
        const who = currentClank(next);
        return `Passed. ${ticket.key} goes to ${who ? names().clank(who) : this.options.userName()} next. Your run ends here.`;
      }),

      bounce: guard((input) => {
        const ticket = own();
        const crew = this.members(project.id);
        const sender = crew.find((c) => c.id === actor);
        const wanted = input.to.trim().toLowerCase();
        const target = crew.find((c) => c.id === wanted || c.name.toLowerCase() === wanted);
        // Back along its route, to a clank who had it before.
        const allowed = sender
          ? bounceTargets(sender, ticket.route, crew).filter((id) =>
              ticket.route.slice(0, ticket.step).some((s) => s.clankId === id),
            )
          : [];
        if (!target || !allowed.includes(target.id)) {
          throw new BoardError(
            allowed.length === 0
              ? `There's nobody on ${ticket.key}'s route you can send it back to. Use ask_user or fail instead.`
              : `You can send ${ticket.key} back to ${allowed.map((id) => `${names().clank(id)} (${id})`).join(', ')}.`,
          );
        }
        this.sendBack(ticket, actor, target.id, input.reason, input.issues, true);
        const next = this.ticket(ticket.id);
        return next.state === 'looping'
          ? `It has bounced too often, so it went to ${this.options.userName()}. Your run ends here.`
          : `Sent back to ${names().clank(target.id)}. Your run ends here.`;
      }),

      fail: guard((input) => {
        const ticket = own();
        const reason = input.tried ? `${input.reason} Tried: ${input.tried}` : input.reason;
        this.store.updateTicket(ticket.id, { state: 'failed', reason, updatedAt: this.now() });
        this.event(
          project.id,
          ticket.id,
          actor,
          'failed',
          `gave up on ${ticket.key}: ${short(input.reason)}`,
        );
        return `Stopped. ${this.options.userName()} will see why. Your run ends here.`;
      }),

      ask: guard((input) => {
        const ticket = own();
        const options =
          input.options.length > 0
            ? `\n\nOptions:\n${input.options.map((o) => `- ${o}`).join('\n')}`
            : '';
        const recommend = input.recommendation ? `\nRecommended: ${input.recommendation}` : '';
        this.store.updateTicket(ticket.id, {
          state: 'question',
          reason: `${input.question}${options}${recommend}`,
          updatedAt: this.now(),
        });
        this.event(
          project.id,
          ticket.id,
          actor,
          'question',
          `asked you about ${ticket.key}: ${short(input.question)}`,
        );
        return `Your question is with ${this.options.userName()}. Your run pauses here; their answer comes as their next message.`;
      }),
    };
  }

  // Run context text

  private ticketBrief(ticket: Ticket, all: Ticket[], clankId: string, names: Names): string {
    const step = ticket.route[ticket.step]!;
    const last = ticket.step === ticket.route.length - 1;
    const as = step.role === 'maker' ? 'its maker' : last ? 'its sign-off' : 'one of its checkers';
    const lines = [
      `Mode: ticket. You are working ${ticket.key} on your own, as ${as}.`,
      '',
      ticketDetail(ticket, { all, bounces: this.store.bounces([ticket.id]), names, you: clankId }),
      '',
    ];
    if (step.role === 'maker') {
      if (ticket.type === 'spec') {
        lines.push(
          `This ticket writes spec v${ticket.specVersion ?? 1}. Save each draft as you go; Atlas reviews the latest one.`,
        );
      }
      lines.push(
        `When it meets its acceptance criteria, hand it in with \`submit_output\`, type \`${ticket.type}\`. If you can't go on, call \`ask_user\` for a decision only ${names.user} can make, \`ticket_bounce\` to send it back to the clank that can fix what you were handed, or \`fail\`. End with exactly one of these calls, never a plain reply.`,
      );
    } else {
      if (ticket.type === 'spec') {
        lines.push(
          `You are checking the draft of spec v${ticket.specVersion ?? 1}: read it with \`spec_read\`. Pass it if it covers everything in the description, every story has acceptance criteria that can be tested, and nothing contradicts. Don't rewrite it yourself.`,
        );
      }
      lines.push(
        `End with exactly one call: \`review_pass\` when it does what its criteria say, or \`ticket_bounce\` to the clank that can fix it, with a numbered list of specific fixes. Never end with a plain reply.`,
      );
    }
    return lines.join('\n');
  }

  private planBrief(project: Project, ticket: Ticket, all: Ticket[], names: Names): string {
    const specs = this.store.specs(project.id).filter((s) => s.status === 'approved');
    const spec = specs.find((s) => s.ticketId === ticket.id) ?? specs.at(-1);
    if (!spec) return 'Mode: planning. There is no approved spec yet.';
    const previous = specs.filter((s) => s.version < spec.version).at(-1);
    const stories = parseSpec(spec.body).stories.filter((s) => !s.removed);
    const changed = previous ? changedStories(parseSpec(previous.body).stories, stories) : null;
    const focus = changed
      ? changed.length > 0
        ? `its new and changed stories: ${changed.join(', ')}`
        : 'what changed, though no story did; check whether any ticket is needed'
      : 'its stories';
    const existing = all.filter((t) => t.id !== ticket.id);
    const lines = [
      `Mode: planning. ${cap(names.user)} approved spec v${spec.version} of ${project.name}. Turn ${focus} into tickets, as your instructions say for breaking a spec into tickets.`,
      '',
      `Stories in v${spec.version}: ${stories.map((s) => `${s.id} ${s.title}`).join('; ')}.`,
      '',
      'Create each ticket with `board_create_ticket`: its story ids (such as "US-2"), an assignee from the crew or null for open, and `depends_on` with the keys of the tickets it waits on. Create a ticket before the ones that depend on it.',
      '',
      'Every ticket needs acceptance criteria. A ticket with stories gets theirs when you leave criteria empty. Give a ticket without stories, such as setup, criteria of its own, such as "`npm run build` succeeds and the home page renders".',
      '',
      existing.length > 0
        ? `Already on the board:\n${existing.map((t) => `- ${ticketLine(t, all, names)}`).join('\n')}`
        : 'The board has no other tickets yet.',
      '',
      `When every ticket is on the board, reply to ${names.user} with a short summary.`,
    ];
    return lines.join('\n');
  }

  // Helpers

  private members(projectId: string): WorkflowMember[] {
    return this.options.projects.clanks(projectId).map((clank) => {
      const { workflow, outputs } = clank.frontmatter;
      return {
        id: clank.id,
        name: clank.name,
        kind: workflow.kind,
        stage: workflow.stage,
        after: workflow.after,
        appliesTo: workflow.applies_to ?? [],
        outputs,
        bounceTo: workflow.bounce_to ?? [],
      };
    });
  }

  private names(): Names {
    const crew = this.options.crew;
    return {
      clank: (id) => (crew.has(id) ? crew.get(id).name : id),
      user: this.options.userName(),
    };
  }

  private event(
    projectId: string,
    ticketId: string | null,
    actor: string,
    kind: BoardEventKind,
    text: string,
  ): void {
    this.store.addEvent({ projectId, ticketId, actor, kind, text, at: this.now() });
    this.options.projects.touch(projectId);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** What a run is doing now, from the reply it's writing. */
function liveOf(message: MessageRecord | null): { label: string; asking: boolean } {
  if (!message) return { label: 'Starting', asking: false };
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]!;
    if (part.type !== 'tool') continue;
    if (part.status === 'asking') return { label: `Waiting for you: ${part.label}`, asking: true };
    if (part.status === 'running' || part.status === 'pending') {
      return { label: part.label, asking: false };
    }
    break;
  }
  const last = message.parts.at(-1);
  return { label: last?.type === 'text' ? 'Writing' : 'Thinking', asking: false };
}

/** Everything on a board waiting on the user, oldest first. */
function needsYouOf(cards: TicketCard[], specs: SpecVersionInfo[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const card of cards) {
    const base = { ticketId: card.id, key: card.key, at: card.updatedAt };
    const run = card.runs.find((r) => r.clankId === currentClank(card) && r.role !== 'planner');
    if (card.proposed) {
      items.push({
        ...base,
        kind: 'proposal',
        text: `Proposal: ${card.title}`,
        conversationId: null,
      });
    }
    if (card.column === 'ready') {
      const spec = specs.find((s) => s.ticketId === card.id && s.status !== 'approved');
      items.push({
        ...base,
        kind: card.state === 'looping' ? 'looping' : 'ready',
        text:
          card.state === 'looping'
            ? `Bounced ${card.bounces} times: ${card.title}`
            : card.type === 'spec' && spec
              ? `Approve spec v${spec.version}`
              : `Ready for you: ${card.title}`,
        conversationId: null,
      });
    } else if (card.live?.asking) {
      items.push({
        ...base,
        kind: 'approval',
        text: card.live.label,
        conversationId: card.live.conversationId,
      });
    } else if (card.state === 'question') {
      items.push({
        ...base,
        kind: 'question',
        text: card.reason?.split('\n')[0] ?? 'A question for you',
        conversationId: run?.conversationId ?? null,
      });
    } else if (card.state === 'failed' || card.state === 'paused') {
      items.push({
        ...base,
        kind: card.state,
        text: card.reason ?? (card.state === 'failed' ? 'Failed' : 'Paused'),
        conversationId: run?.conversationId ?? null,
      });
    }
  }
  return items.sort((a, b) => +a.at - +b.at);
}

/** A name at the start of a sentence: "the user" becomes "The user". */
function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function short(text: string, max = 90): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
