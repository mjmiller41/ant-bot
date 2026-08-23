import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from './db.js';
import { SCHEMA_SQL } from './schema.js';
import {
  MIGRATIONS,
  BASELINE_VERSION,
  MigrationError,
  detectBaselineAdoption,
  planMigrations,
  migrate,
  type Migration,
} from './migrations.js';

const m = (version: number, name: string, up = 'SELECT 1;'): Migration => ({ version, name, up });

describe('planMigrations', () => {
  it('returns everything for an empty database', () => {
    expect(planMigrations(0, [m(1, 'a'), m(2, 'b')]).map((x) => x.version)).toEqual([1, 2]);
  });

  it('returns only what comes after the current version', () => {
    expect(planMigrations(1, [m(1, 'a'), m(2, 'b'), m(3, 'c')]).map((x) => x.version)).toEqual([2, 3]);
  });

  it('returns nothing when the database is current', () => {
    expect(planMigrations(2, [m(1, 'a'), m(2, 'b')])).toEqual([]);
  });

  it('sorts an out-of-order list rather than trusting declaration order', () => {
    expect(planMigrations(0, [m(3, 'c'), m(1, 'a'), m(2, 'b')]).map((x) => x.version)).toEqual([1, 2, 3]);
  });

  it('rejects duplicate versions', () => {
    expect(() => planMigrations(0, [m(1, 'a'), m(1, 'b')])).toThrow(MigrationError);
  });

  it('rejects a version below 1', () => {
    expect(() => planMigrations(0, [m(0, 'zero')])).toThrow(/invalid version/);
  });

  // The dangerous direction: an older build must refuse rather than write rows the
  // newer schema forbids.
  it('refuses a database newer than the code', () => {
    expect(() => planMigrations(5, [m(1, 'a')])).toThrow(/schema version 5/);
    try {
      planMigrations(5, [m(1, 'a')]);
    } catch (err) {
      expect((err as MigrationError).code).toBe('MIGRATION_DOWNGRADE');
    }
  });

  it('treats an empty migration list as nothing to do', () => {
    expect(planMigrations(0, [])).toEqual([]);
  });
});

describe('detectBaselineAdoption', () => {
  it('adopts a pre-runner database', () => {
    expect(detectBaselineAdoption(false, true)).toBe(true);
  });
  it('leaves a brand-new file at version 0', () => {
    expect(detectBaselineAdoption(false, false)).toBe(false);
  });
  it('does not re-adopt a database that already has a ledger', () => {
    expect(detectBaselineAdoption(true, true)).toBe(false);
  });
});

describe('migrate', () => {
  it('applies the baseline to an empty database', () => {
    const db = new Database(':memory:');
    const result = migrate(db);
    expect(result.from).toBe(0);
    expect(result.to).toBe(BASELINE_VERSION);
    expect(result.applied.map((a) => a.name)).toEqual(['baseline']);
    expect(db.prepare(`SELECT COUNT(*) c FROM bots`).get()).toEqual({ c: 0 });
  });

  it('is a no-op on the second open', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(migrate(db).applied).toEqual([]);
  });

  it('records what it applied in schema_version', () => {
    const db = new Database(':memory:');
    migrate(db);
    const rows = db.prepare(`SELECT version, name FROM schema_version ORDER BY version`).all();
    expect(rows).toEqual(MIGRATIONS.map((x) => ({ version: x.version, name: x.name })));
  });

  // The whole reason the runner exists: a database that predates it must be adopted at the
  // baseline, not re-run from zero and not mistaken for empty.
  it('adopts a pre-runner database at the baseline version', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    db.prepare(
      `INSERT INTO bots (id, slug, name, created_at) VALUES ('b1', 'ada', 'Ada', 1)`,
    ).run();

    const result = migrate(db);
    expect(result.from).toBe(BASELINE_VERSION);
    expect(result.applied).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) c FROM bots`).get()).toEqual({ c: 1 });
  });

  // Without this the ledger stays empty until some later migration runs, and then reads as
  // though the baseline never did.
  it('records the baseline in the ledger when it adopts', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    migrate(db, { now: () => 1_700_000_000_000 });
    expect(db.prepare(`SELECT * FROM schema_version`).all()).toEqual([
      { version: BASELINE_VERSION, name: 'baseline', applied_at: 1_700_000_000_000 },
    ]);
  });

  it('does not re-record the baseline on a later open', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    migrate(db);
    migrate(db);
    expect(db.prepare(`SELECT COUNT(*) c FROM schema_version`).get()).toEqual({ c: 1 });
  });

  it('applies a later migration to an adopted pre-runner database', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const extra = [...MIGRATIONS, m(BASELINE_VERSION + 1, 'add-nickname', `ALTER TABLE bots ADD COLUMN nickname TEXT;`)];

    const result = migrate(db, { migrations: extra });
    expect(result.from).toBe(BASELINE_VERSION);
    expect(result.applied.map((a) => a.name)).toEqual(['add-nickname']);
    const cols = (db.prepare(`PRAGMA table_info(bots)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('nickname');
    // Both the adopted baseline and the migration that followed it.
    expect(db.prepare(`SELECT version FROM schema_version ORDER BY version`).all())
      .toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('leaves the ledger honest when a migration fails partway through a list', () => {
    const db = new Database(':memory:');
    const bad = [
      ...MIGRATIONS,
      m(2, 'good', `ALTER TABLE bots ADD COLUMN one TEXT;`),
      m(3, 'bad', `ALTER TABLE nonexistent_table ADD COLUMN two TEXT;`),
      m(4, 'never', `ALTER TABLE bots ADD COLUMN three TEXT;`),
    ];
    expect(() => migrate(db, { migrations: bad })).toThrow(/migration 3 \(bad\) failed/);

    const applied = (db.prepare(`SELECT version FROM schema_version ORDER BY version`).all() as {
      version: number;
    }[]).map((r) => r.version);
    expect(applied).toEqual([1, 2]);

    const cols = (db.prepare(`PRAGMA table_info(bots)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('one');
    expect(cols).not.toContain('three');
  });

  it('rolls a failing migration back rather than leaving half of it applied', () => {
    const db = new Database(':memory:');
    const bad = [
      ...MIGRATIONS,
      m(2, 'half', `ALTER TABLE bots ADD COLUMN ok TEXT; ALTER TABLE nope ADD COLUMN boom TEXT;`),
    ];
    expect(() => migrate(db, { migrations: bad })).toThrow(MigrationError);

    const cols = (db.prepare(`PRAGMA table_info(bots)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('ok');
  });
});

describe('migrate: pre-migration snapshot', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-migrate-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not snapshot a brand-new database', () => {
    const backups = path.join(dir, 'backups');
    openDb(path.join(dir, 'antbot.db'), { backupsDir: backups });
    expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([]);
  });

  it('snapshots an existing database before applying a migration, WAL content included', () => {
    const file = path.join(dir, 'antbot.db');
    const backups = path.join(dir, 'backups');

    const first = openDb(file, { backupsDir: backups });
    first.prepare(`INSERT INTO bots (id, slug, name, created_at) VALUES ('b1', 'ada', 'Ada', 1)`).run();
    first.close();

    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    const result = migrate(db, {
      backupsDir: backups,
      migrations: [...MIGRATIONS, m(2, 'add-nickname', `ALTER TABLE bots ADD COLUMN nickname TEXT;`)],
      now: () => 1_700_000_000_000,
    });
    db.close();

    expect(result.backupPath).toBe(path.join(backups, 'antbot-pre-v2-2023-11-14T22-13-20-000Z.db'));
    const snap = new Database(result.backupPath!, { readonly: true });
    expect(snap.prepare(`SELECT slug FROM bots`).all()).toEqual([{ slug: 'ada' }]);
    // The snapshot is of the *old* schema — that is the point of taking it first.
    const cols = (snap.prepare(`PRAGMA table_info(bots)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('nickname');
    snap.close();
  });
});

describe('MIGRATIONS', () => {
  it('is a well-formed, gap-free list starting at 1', () => {
    expect(() => planMigrations(0, MIGRATIONS)).not.toThrow();
    expect(MIGRATIONS.map((x) => x.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  // Renumbering a released migration would re-run it on databases that already have it.
  it('keeps migration 1 as the baseline', () => {
    expect(MIGRATIONS[0]).toMatchObject({ version: 1, name: 'baseline' });
    expect(MIGRATIONS[0]!.up).toBe(SCHEMA_SQL);
  });
});
