import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface StoreStatus {
  file: string;
  sqliteVersion: string;
  /** Migrations applied to this database. */
  migrations: number;
}

export interface Store {
  db: Db;
  status(): StoreStatus;
  close(): void;
}

export interface OpenStoreOptions {
  /** Path to the database file, or `:memory:`. */
  file: string;
  /** Folder holding the SQL migrations drizzle-kit generated. */
  migrationsFolder: string;
}

/** Opens the database and brings its schema up to date. */
export function openStore({ file, migrationsFolder }: OpenStoreOptions): Store {
  const sqlite = new Database(file);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = NORMAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    const db = drizzle({ client: sqlite, schema });
    migrate(db, { migrationsFolder });

    return {
      db,
      status: () => ({
        file,
        sqliteVersion: (sqlite.prepare('select sqlite_version() as v').get() as { v: string }).v,
        migrations: (
          sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as { n: number }
        ).n,
      }),
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
