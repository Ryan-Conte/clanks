import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** App settings, one row per key. Values are JSON, validated against `settingsSchema` on read. */
export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
