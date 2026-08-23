// The schema evolves on the user's machine, not ours. Once ant-bot ships, a `CREATE TABLE IF NOT
// EXISTS` blob is silently wrong: the statement succeeds against an old database and the new column
// is simply absent, so the first query that reads it fails at runtime, far from the cause. This
// module is the ordered ledger that makes a change actually reach an existing `~/.ant-bot/antbot.db`.
//
// Shape follows the rest of the codebase: `planMigrations` is the pure decision, `migrate` is the
// I/O wrapper (see `detectBlockFromSignals` / `computeBackupItems` / `runDoctor(deps)`).
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { SCHEMA_SQL } from './schema.js';

export class MigrationError extends Error {
  constructor(
    public code: 'MIGRATION_ORDER' | 'MIGRATION_DOWNGRADE' | 'MIGRATION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface Migration {
  /** Strictly increasing, starting at 1. Never renumber a released migration. */
  version: number;
  /** Short slug, recorded in the ledger so a support log says what ran. */
  name: string;
  /** Executed with `db.exec` inside a transaction. Must be idempotent-safe to re-read, not re-run. */
  up: string;
}

/**
 * Migration 1 is the schema as it stood when the runner was introduced. Every database in
 * existence at that point already has it, which is why `detectBaselineAdoption` exists — such a
 * database is adopted at this version rather than being mistaken for an empty one.
 */
export const BASELINE_VERSION = 1;

/**
 * A table that only the baseline creates. Used to tell "existing database, no ledger yet" from
 * "brand new file"; `bots` has been in the schema since the first commit and is never dropped.
 */
const BASELINE_SENTINEL_TABLE = 'bots';

export const MIGRATIONS: Migration[] = [
  { version: BASELINE_VERSION, name: 'baseline', up: SCHEMA_SQL },
];

export const SCHEMA_VERSION_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
);
`;

/* ------------------------------- pure core ------------------------------- */

/**
 * A database created before the migration runner has the baseline schema but no ledger rows.
 * Recognising that is the difference between adopting it and re-running history over it.
 */
export function detectBaselineAdoption(hasLedgerRows: boolean, hasBaselineTable: boolean): boolean {
  return !hasLedgerRows && hasBaselineTable;
}

/**
 * Decides what to run. Throws rather than guessing: an out-of-order list is an authoring bug, and
 * a database numbered past the code is an older ant-bot opening a newer install's data — running
 * nothing there would let it write rows the newer schema forbids.
 */
export function planMigrations(currentVersion: number, migrations: Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  let prev = 0;
  for (const m of sorted) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new MigrationError('MIGRATION_ORDER', `migration "${m.name}" has invalid version ${m.version}`);
    }
    if (m.version === prev) {
      throw new MigrationError('MIGRATION_ORDER', `duplicate migration version ${m.version}`);
    }
    prev = m.version;
  }

  const latest = sorted.length ? sorted[sorted.length - 1]!.version : 0;
  if (currentVersion > latest) {
    throw new MigrationError(
      'MIGRATION_DOWNGRADE',
      `database is at schema version ${currentVersion} but this build only knows up to ${latest}. ` +
        `Upgrade ant-bot (npm i -g ant-bot) rather than downgrading the database.`,
    );
  }

  return sorted.filter((m) => m.version > currentVersion);
}

/* ------------------------------- I/O wrapper ------------------------------- */

export interface MigrateResult {
  from: number;
  to: number;
  applied: { version: number; name: string }[];
  /** Path of the pre-migration snapshot, when one was taken. */
  backupPath?: string;
}

export interface MigrateOptions {
  /** Where a pre-migration snapshot is written. Omit to skip the snapshot (in-memory databases). */
  backupsDir?: string;
  migrations?: Migration[];
  now?: () => number;
}

function readCurrentVersion(db: DB): { version: number; adopted: boolean } {
  db.exec(SCHEMA_VERSION_SQL);
  const row = db.prepare(`SELECT MAX(version) v FROM schema_version`).get() as { v: number | null };
  if (row.v !== null) return { version: row.v, adopted: false };

  const sentinel = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(BASELINE_SENTINEL_TABLE) as { name: string } | undefined;
  const adopted = detectBaselineAdoption(false, Boolean(sentinel));
  return { version: adopted ? BASELINE_VERSION : 0, adopted };
}

/**
 * Snapshots the database file before a migration touches it. `VACUUM INTO` is used rather than a
 * file copy because it checkpoints WAL content into the snapshot — copying `antbot.db` alone would
 * silently lose whatever is still sitting in `antbot.db-wal`.
 */
function snapshot(db: DB, backupsDir: string, toVersion: number, now: () => number): string {
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `antbot-pre-v${toVersion}-${stamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(dest);
  return dest;
}

/**
 * Brings `db` up to the latest schema version, snapshotting first if there is anything to lose.
 * Each migration commits on its own so a failure halfway through a list leaves the ledger honest
 * about how far it got.
 */
export function migrate(db: DB, opts: MigrateOptions = {}): MigrateResult {
  const migrations = opts.migrations ?? MIGRATIONS;
  const now = opts.now ?? Date.now;
  const { version: from, adopted } = readCurrentVersion(db);

  // OR IGNORE guards only the adoption row below; `planMigrations` already guarantees the loop
  // never re-inserts a version the ledger holds.
  const record = db.prepare(
    `INSERT OR IGNORE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  // Write the adoption down the first time we see a pre-runner database. Without this the ledger
  // stays empty until some *later* migration runs, and then reads as though the baseline never
  // did — which is exactly the question a support log gets asked.
  if (adopted) {
    const baseline = migrations.find((m) => m.version === BASELINE_VERSION);
    record.run(BASELINE_VERSION, baseline?.name ?? 'baseline', now());
  }

  const pending = planMigrations(from, migrations);
  if (pending.length === 0) return { from, to: from, applied: [] };

  const target = pending[pending.length - 1]!.version;

  // A brand-new database (version 0) has nothing to lose, and snapshotting it would litter
  // `backups/` with an empty file on every first run.
  let backupPath: string | undefined;
  if (opts.backupsDir && from > 0) {
    backupPath = snapshot(db, opts.backupsDir, target, now);
  }

  const applied: { version: number; name: string }[] = [];
  for (const m of pending) {
    const run = db.transaction(() => {
      db.exec(m.up);
      record.run(m.version, m.name, now());
    });
    try {
      run();
    } catch (err) {
      throw new MigrationError(
        'MIGRATION_FAILED',
        `migration ${m.version} (${m.name}) failed: ${(err as Error).message}` +
          (backupPath ? `. The pre-migration database was saved to ${backupPath}` : ''),
      );
    }
    applied.push({ version: m.version, name: m.name });
  }

  return { from, to: target, applied, backupPath };
}
