import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema.js';

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  return db;
}
