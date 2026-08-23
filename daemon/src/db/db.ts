import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrations.js';
import { logger } from '../util/log.js';

export type DB = Database.Database;

const log = logger('db');

export interface OpenDbOptions {
  /**
   * Where a pre-migration snapshot is written. Defaults to a `backups` sibling of the database
   * file, which is `paths.backups` for a real install. Ignored for `:memory:`.
   */
  backupsDir?: string;
}

export function openDb(file: string, opts: OpenDbOptions = {}): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // The schema is applied by the migration runner, not by exec'ing SCHEMA_SQL here — see
  // migrations.ts for why a bare `CREATE TABLE IF NOT EXISTS` blob cannot ship an update to a
  // database that already exists on a user's machine.
  const backupsDir =
    file === ':memory:' ? undefined : (opts.backupsDir ?? path.join(path.dirname(file), 'backups'));
  const result = migrate(db, { backupsDir });
  // Creating the schema in an empty database is not news; upgrading one that already held a
  // user's data is the thing a support log needs to show.
  if (result.from > 0 && result.applied.length) {
    log.info(
      `schema ${result.from} -> ${result.to}: ${result.applied.map((a) => a.name).join(', ')}` +
        (result.backupPath ? ` (snapshot: ${result.backupPath})` : ''),
    );
  }
  return db;
}
