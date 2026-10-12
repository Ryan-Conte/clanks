import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationsFolder, tempDir } from '../test-helpers';
import { openStore } from './store';

describe('store', () => {
  it('applies the migrations to a new database', () => {
    const store = openStore({ file: ':memory:', migrationsFolder });
    const status = store.status();
    expect(status.migrations).toBeGreaterThan(0);
    expect(status.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
    store.close();
  });

  it('applies each migration once across restarts', () => {
    const file = join(tempDir(), 'clanks.db');
    const first = openStore({ file, migrationsFolder });
    const applied = first.status().migrations;
    first.close();

    const second = openStore({ file, migrationsFolder });
    expect(second.status().migrations).toBe(applied);
    second.close();
  });

  it('uses WAL and enforces foreign keys', () => {
    const file = join(tempDir(), 'clanks.db');
    const store = openStore({ file, migrationsFolder });
    const client = store.db.$client;
    expect(client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(client.pragma('foreign_keys', { simple: true })).toBe(1);
    store.close();
  });

  it('has full-text search', () => {
    const store = openStore({ file: ':memory:', migrationsFolder });
    const client = store.db.$client;
    client.exec("create virtual table probe using fts5(body); insert into probe values ('hello')");
    expect(
      client.prepare("select count(*) as n from probe where probe match 'hello'").get(),
    ).toEqual({ n: 1 });
    store.close();
  });

  it('fails loudly when the migrations are missing', () => {
    expect(() =>
      openStore({ file: ':memory:', migrationsFolder: join(tempDir(), 'missing') }),
    ).toThrow();
  });
});
