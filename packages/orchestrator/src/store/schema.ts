import type {
  ActivityEvent,
  ArtifactKind,
  Avatar,
  BoardEventKind,
  Budget,
  ChangedFile,
  ClankBrowser,
  ChatUsage,
  Criterion,
  FinishReason,
  GgufFacts,
  MessagePart,
  MessageStatus,
  ModelCapabilities,
  ModelFile,
  MemoryKind,
  ModelTag,
  NoteKind,
  NoteStatus,
  OutputType,
  ProjectRepo,
  RepoHost,
  NoteAnchor,
  ReviewNoteKind,
  RouteStep,
  RunRole,
  Sandbox,
  SkippedCheck,
  SpecStatus,
  TicketDelivery,
  TicketDetour,
  TicketOrigin,
  TicketOutcome,
  TicketProgress,
  TicketReview,
  TicketSend,
  TicketState,
  ToolOverrides,
} from '@clanks/core';
import type { PullRecord } from '@clanks/models';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * App settings, one row per key. Values are JSON, validated against `settingsSchema` on read.
 * SQL NULL stands for a JSON null, which nullable settings such as `crewModel` use.
 */
export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** A model in the local store. Its files live in the models folder, named by sha256. */
export const model = sqliteTable('model', {
  /** `name:tag`, or `hf.co/<owner>/<repo>:<quant>`. */
  id: text('id').primaryKey(),
  source: text('source', { enum: ['catalog', 'huggingface', 'ollama'] }).notNull(),
  title: text('title').notNull(),
  repo: text('repo').notNull(),
  revision: text('revision').notNull(),
  quant: text('quant'),
  params: text('params'),
  license: text('license'),
  tags: text('tags', { mode: 'json' }).$type<ModelTag[]>().notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<ModelCapabilities>().notNull(),
  files: text('files', { mode: 'json' }).$type<ModelFile[]>().notNull(),
  facts: text('facts', { mode: 'json' }).$type<GgufFacts>().notNull(),
  size: integer('size').notNull(),
  keepLoaded: integer('keep_loaded', { mode: 'boolean' }).notNull().default(false),
  pulledAt: integer('pulled_at', { mode: 'timestamp_ms' }).notNull(),
});

/** A pull that hasn't finished, kept so it can resume after a restart. */
export const modelPull = sqliteTable('model_pull', {
  id: text('id').primaryKey(),
  ref: text('ref').notNull(),
  state: text('state').$type<PullRecord['state']>().notNull(),
  plan: text('plan', { mode: 'json' }).$type<PullRecord['plan']>(),
  /** Download progress per file, by sha256. */
  chunks: text('chunks', { mode: 'json' }).$type<PullRecord['chunks']>().notNull(),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** What the user changed about a clank in the app. Its priming doc says the rest. */
export const clank = sqliteTable('clank', {
  id: text('id').primaryKey(),
  name: text('name'),
  avatar: text('avatar').$type<Avatar>(),
  /** Its own model, at a provider. Both null runs it on the crew's model. */
  provider: text('provider'),
  model: text('model'),
  /** Tool policies the user set, which win over the doc's. */
  tools: text('tools', { mode: 'json' }).$type<ToolOverrides>(),
  /** Its site lists and whether its browser keeps cookies. Null is the defaults. */
  browser: text('browser', { mode: 'json' }).$type<ClankBrowser>(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** A project: its workspace, its crew's model, and the letters its ticket keys start with. */
export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  brief: text('brief').notNull(),
  key: text('key').notNull(),
  folder: text('folder').notNull(),
  /** Projects made before GitLab arrived have no host: they're on GitHub. */
  repo: text('repo', { mode: 'json' }).$type<Omit<ProjectRepo, 'host'> & { host?: RepoHost }>(),
  /** The branch tickets start from and merge into. Null uses the folder's checked-out branch. */
  baseBranch: text('base_branch'),
  /** The model for the whole crew. Both null leaves each clank on its own. */
  provider: text('provider'),
  model: text('model'),
  /** The number the next ticket gets. */
  nextNumber: integer('next_number').notNull().default(1),
  maxRuns: integer('max_runs').notNull().default(3),
  bounceLimit: integer('bounce_limit').notNull().default(3),
  /** Checks made optional, as `clank:type`. */
  optionalChecks: text('optional_checks', { mode: 'json' }).$type<string[]>().notNull().default([]),
  budget: text('budget', { mode: 'json' }).$type<Budget>(),
  clankBudgets: text('clank_budgets', { mode: 'json' })
    .$type<Record<string, Budget>>()
    .notNull()
    .default({}),
  sandbox: text('sandbox', { mode: 'json' }).$type<Sandbox>(),
  /** The crew finishes what's running and starts nothing new. */
  held: integer('held', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** A clank in a project's crew, and its model there. */
export const projectClank = sqliteTable(
  'project_clank',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    clankId: text('clank_id').notNull(),
    provider: text('provider'),
    model: text('model'),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.clankId] })],
);

/** One version of a project's spec. The draft of the next version is the one not yet approved. */
export const spec = sqliteTable(
  'spec',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<SpecStatus>().notNull(),
    ticketId: text('ticket_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('spec_project_version').on(t.projectId, t.version)],
);

export const ticket = sqliteTable(
  'ticket',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    type: text('type').$type<OutputType>().notNull(),
    stories: text('stories', { mode: 'json' }).$type<string[]>().notNull(),
    criteria: text('criteria', { mode: 'json' }).$type<Criterion[]>().notNull(),
    assignee: text('assignee'),
    route: text('route', { mode: 'json' }).$type<RouteStep[]>().notNull(),
    step: integer('step').notNull(),
    state: text('state').$type<TicketState>().notNull(),
    reason: text('reason'),
    bounces: integer('bounces').notNull().default(0),
    rank: real('rank').notNull(),
    origin: text('origin').$type<TicketOrigin>().notNull(),
    createdBy: text('created_by').notNull(),
    proposed: integer('proposed', { mode: 'boolean' }).notNull().default(false),
    specVersion: integer('spec_version'),
    progress: text('progress', { mode: 'json' }).$type<TicketProgress>(),
    output: text('output', { mode: 'json' }).$type<Record<string, unknown>>(),
    reviews: text('reviews', { mode: 'json' }).$type<TicketReview[]>().notNull(),
    /** The chat it came from. Not a foreign key: deleting the chat keeps the ticket. */
    conversationId: text('conversation_id'),
    skipped: text('skipped', { mode: 'json' }).$type<SkippedCheck[]>().notNull().default([]),
    detour: text('detour', { mode: 'json' }).$type<TicketDetour>(),
    /** What the next run is told when the scheduler starts it. */
    queued: text('queued'),
    delivery: text('delivery', { mode: 'json' }).$type<TicketDelivery>(),
    /** For an email: how sending it went, once the user approved it. */
    sent: text('sent', { mode: 'json' }).$type<TicketSend>(),
    outcome: text('outcome').$type<TicketOutcome>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    doneAt: integer('done_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('ticket_project_number').on(t.projectId, t.number)],
);

/**
 * A project note: something the whole crew on a project should know. Searched through
 * `context_note_fts`, a full-text index the migration keeps in step with triggers.
 */
export const contextNote = sqliteTable(
  'context_note',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NoteKind>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    why: text('why').notNull(),
    author: text('author').notNull(),
    /** Not a foreign key: a deleted ticket's notes stay, as the crew learned them. */
    ticketId: text('ticket_id'),
    status: text('status').$type<NoteStatus>().notNull(),
    supersedes: text('supersedes'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('context_note_project').on(t.projectId, t.status)],
);

/** One entry in a clank's memory of a project. Searched through `memory_fts`. */
export const memory = sqliteTable(
  'memory',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    clankId: text('clank_id').notNull(),
    kind: text('kind').$type<MemoryKind>().notNull(),
    body: text('body').notNull(),
    ticketId: text('ticket_id'),
    conversationId: text('conversation_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('memory_project_clank').on(t.projectId, t.clankId)],
);

/**
 * Something the crew made that isn't in the repository: a hand-in as a document, a clank's working
 * notes, a picture of a page. The file is in the artifacts folder; saving under a name that's taken
 * adds a version.
 */
export const artifact = sqliteTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => project.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id').references(() => ticket.id, { onDelete: 'cascade' }),
    /** Not a foreign key: a ticket's artifacts outlive the run that saved them. */
    conversationId: text('conversation_id'),
    /** `user`, or the clank that saved it. */
    author: text('author').notNull(),
    kind: text('kind').$type<ArtifactKind>().notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    mediaType: text('media_type').notNull(),
    size: integer('size').notNull(),
    /** Relative to the artifacts folder. */
    path: text('path').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('artifact_ticket').on(t.ticketId, t.name, t.version),
    index('artifact_conversation').on(t.conversationId),
  ],
);

/** A ticket waiting on another. */
export const ticketDependency = sqliteTable(
  'ticket_dependency',
  {
    ticketId: text('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'cascade' }),
    dependsOn: text('depends_on')
      .notNull()
      .references(() => ticket.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.dependsOn] })],
);

export const bounce = sqliteTable(
  'bounce',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => ticket.id, { onDelete: 'cascade' }),
    from: text('from').notNull(),
    to: text('to').notNull(),
    reason: text('reason').notNull(),
    issues: text('issues', { mode: 'json' }).$type<string[]>().notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('bounce_ticket').on(t.ticketId)],
);

/** Append-only: a project's activity feed. Lines outlive the tickets they're about. */
export const boardEvent = sqliteTable(
  'board_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id'),
    actor: text('actor').notNull(),
    kind: text('kind').$type<BoardEventKind>().notNull(),
    text: text('text').notNull(),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('board_event_project').on(t.projectId, t.id)],
);

/** A chat with one clank, or a clank's run on a ticket. */
export const conversation = sqliteTable(
  'conversation',
  {
    id: text('id').primaryKey(),
    clankId: text('clank_id').notNull(),
    title: text('title').notNull(),
    /** A folder whose CLANKS.md or AGENTS.md the clank follows. */
    folder: text('folder'),
    projectId: text('project_id').references(() => project.id, { onDelete: 'cascade' }),
    ticketId: text('ticket_id').references(() => ticket.id, { onDelete: 'cascade' }),
    role: text('role').$type<RunRole>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('conversation_updated_at').on(t.updatedAt),
    index('conversation_ticket').on(t.ticketId),
  ],
);

export const message = sqliteTable(
  'message',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    /** Order within the conversation. */
    position: integer('position').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    /** `app` for a turn the app wrote for the clank, such as a ticket brief. */
    author: text('author').$type<'app'>(),
    content: text('content').notNull(),
    /** Text, tool calls and notes in order. Null for messages saved before tools, which are text. */
    parts: text('parts', { mode: 'json' }).$type<MessagePart[]>(),
    reasoning: text('reasoning').notNull().default(''),
    status: text('status').$type<MessageStatus>().notNull(),
    error: text('error'),
    provider: text('provider'),
    model: text('model'),
    usage: text('usage', { mode: 'json' }).$type<ChatUsage>(),
    finishReason: text('finish_reason').$type<FinishReason>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('message_conversation_position').on(t.conversationId, t.position)],
);

/**
 * Model servers the user added, such as LM Studio, vLLM or Ollama: anything that speaks the
 * OpenAI API. Cloud providers aren't listed; a saved key is what turns one on.
 */
export const provider = sqliteTable('provider', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['openai_compatible'] }).notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  /** The keychain entry for its API key, if it needs one. */
  secretRef: text('secret_ref'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * A clank's run on a copy of a repository: for now, one per chat about a folder in one. Tickets get
 * runs of their own when the board arrives.
 */
export const run = sqliteTable('run', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .unique()
    .references(() => conversation.id, { onDelete: 'cascade' }),
  clankId: text('clank_id').notNull(),
  folder: text('folder').notNull(),
  repoRoot: text('repo_root').notNull(),
  worktree: text('worktree').notNull(),
  branch: text('branch').notNull(),
  baseCommit: text('base_commit').notNull(),
  /** The shadow git folder its checkpoints are kept in. */
  checkpointsDir: text('checkpoints_dir').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/** The worktree after a tool call or a user edit that changed files. */
export const checkpoint = sqliteTable(
  'checkpoint',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    commit: text('commit').notNull(),
    author: text('author', { enum: ['base', 'clank', 'user'] }).notNull(),
    label: text('label').notNull(),
    messageId: text('message_id'),
    toolCallId: text('tool_call_id'),
    afterMessageId: text('after_message_id'),
    files: text('files', { mode: 'json' }).$type<ChangedFile[]>().notNull(),
    head: text('head'),
    rewound: integer('rewound', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('checkpoint_run_seq').on(t.runId, t.seq)],
);

/** Feedback from the diff editor, for the clank. */
export const reviewNote = sqliteTable(
  'review_note',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ReviewNoteKind>().notNull(),
    path: text('path').notNull(),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    body: text('body').notNull(),
    excerpt: text('excerpt').notNull(),
    /** A note from Studio: the layer and place it's pinned to, or the edits it sums up. */
    anchor: text('anchor', { mode: 'json' }).$type<NoteAnchor | null>(),
    checkpointId: text('checkpoint_id'),
    status: text('status', { enum: ['pending', 'sent'] }).notNull(),
    /** When it went to the clank, so a rewind to before then can take it back. */
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('review_note_run').on(t.runId)],
);

/** Append-only: what happened in a chat, step by step. The activity timeline is built from it. */
export const event = sqliteTable(
  'event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    messageId: text('message_id'),
    kind: text('kind').$type<ActivityEvent['kind']>().notNull(),
    title: text('title').notNull(),
    input: text('input'),
    output: text('output'),
    status: text('status').$type<NonNullable<ActivityEvent['status']>>(),
    toolCallId: text('tool_call_id'),
    checkpointId: text('checkpoint_id'),
    sessionId: text('session_id'),
    /** A picture of the step, relative to the artifacts folder. */
    image: text('image'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    durationMs: integer('duration_ms'),
  },
  (t) => [index('event_conversation').on(t.conversationId, t.id)],
);

/** "Always allow" rules from approval prompts, per project. */
export const toolRule = sqliteTable(
  'tool_rule',
  {
    id: text('id').primaryKey(),
    scope: text('scope').notNull(),
    tool: text('tool').notNull(),
    pattern: text('pattern').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('tool_rule_scope_tool_pattern').on(t.scope, t.tool, t.pattern)],
);

/** MCP servers the user added. Their environment variables or headers are in the keychain. */
export const mcpServer = sqliteTable('mcp_server', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  transport: text('transport', { enum: ['stdio', 'http'] }).notNull(),
  command: text('command').notNull(),
  args: text('args', { mode: 'json' }).$type<string[]>().notNull(),
  url: text('url').notNull(),
  /** The names of its secrets, so Settings can show them without reading the keychain. */
  secretNames: text('secret_names', { mode: 'json' }).$type<string[]>().notNull(),
  clanks: text('clanks', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
