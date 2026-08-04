import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { latestSchemaVersion, runMigrations } from '../../src/db/index.js';

describe('database migrations', () => {
  it('are idempotent and reject databases created by a newer application', () => {
    const current = new BetterSqlite3(':memory:');
    runMigrations(current);
    runMigrations(current);
    expect(current.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: latestSchemaVersion,
    });
    current.close();

    const future = new BetterSqlite3(':memory:');
    future.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (${latestSchemaVersion + 1}, '2026-08-04T00:00:00.000Z');
    `);
    expect(() => runMigrations(future)).toThrow(/newer than supported/);
    future.close();
  });
});
