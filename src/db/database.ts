import BetterSqlite3 from 'better-sqlite3';

import { runMigrations } from './migrations.js';

export interface OpenDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeoutMs?: number;
}

export type SqliteDatabase = BetterSqlite3.Database;

export function openDatabase(filename: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const database = new BetterSqlite3(filename, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
    timeout: options.timeoutMs ?? 5_000,
  });

  database.pragma('foreign_keys = ON');
  database.pragma(`busy_timeout = ${options.timeoutMs ?? 5_000}`);

  if (!options.readonly) {
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    runMigrations(database);
  }

  return database;
}
