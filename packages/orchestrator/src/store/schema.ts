import type { GgufFacts, ModelCapabilities, ModelFile, ModelTag } from '@clanks/core';
import type { PullRecord } from '@clanks/models';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
  source: text('source', { enum: ['catalog', 'huggingface'] }).notNull(),
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
