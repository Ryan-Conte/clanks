import type {
  Avatar,
  ChatUsage,
  FinishReason,
  GgufFacts,
  MessageStatus,
  ModelCapabilities,
  ModelFile,
  ModelTag,
} from '@clanks/core';
import type { PullRecord } from '@clanks/models';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** A chat with one clank. */
export const conversation = sqliteTable(
  'conversation',
  {
    id: text('id').primaryKey(),
    clankId: text('clank_id').notNull(),
    title: text('title').notNull(),
    /** A folder whose CLANKS.md or AGENTS.md the clank follows. */
    folder: text('folder'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('conversation_updated_at').on(t.updatedAt)],
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
    content: text('content').notNull(),
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
