import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './proc.js';

/** Path segments that must never end up in a backup archive. */
export const BACKUP_EXCLUDED_DIRS = ['browser-profile', 'attachments'];

export interface BackupSource {
  dbPath: string;
  configPath: string;
  skillsDir: string;
  /** ~/.ant-bot/workspace/bots */
  botsDir: string;
  /** directory names found under botsDir, e.g. ['scout', 'writer'] */
  botSlugs: string[];
}

export interface BackupItem {
  /** absolute path on disk */
  source: string;
  /** path inside the archive, forward-slash separated */
  archivePath: string;
}

/**
 * Pure: computes exactly which paths belong in a backup archive, given an
 * already-enumerated list of bot slugs. Never includes browser-profile or
 * attachments.
 */
export function computeBackupItems(input: BackupSource): BackupItem[] {
  const items: BackupItem[] = [
    { source: input.dbPath, archivePath: 'antbot.db' },
    { source: input.configPath, archivePath: 'config.toml' },
    { source: input.skillsDir, archivePath: 'skills' },
  ];
  for (const slug of input.botSlugs) {
    items.push({
      source: path.join(input.botsDir, slug, 'memory'),
      archivePath: `workspace/bots/${slug}/memory`,
    });
  }
  return items;
}

/** Pure: true if a (forward-slash) relative archive path is in an excluded directory. */
export function isExcludedPath(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, '/').split('/');
  return segments.some((seg) => BACKUP_EXCLUDED_DIRS.includes(seg));
}

export interface CreateBackupOptions {
  root: string;
  dbPath: string;
  configPath: string;
  skillsDir: string;
  botsDir: string;
  outPath: string;
}

export interface CreateBackupResult {
  outPath: string;
  bytes: number;
  items: BackupItem[];
}

function listBotSlugs(botsDir: string): string[] {
  try {
    return fs
      .readdirSync(botsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** I/O: shells out to `tar czf` to build the archive. */
export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const botSlugs = listBotSlugs(opts.botsDir);
  const allItems = computeBackupItems({
    dbPath: opts.dbPath,
    configPath: opts.configPath,
    skillsDir: opts.skillsDir,
    botsDir: opts.botsDir,
    botSlugs,
  });
  const items = allItems.filter((item) => fs.existsSync(item.source));
  if (items.length === 0) {
    throw new Error('Nothing to back up: no antbot.db, config.toml, skills, or bot memory found.');
  }

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  const relPaths = items.map((item) => path.relative(opts.root, item.source));
  const args = ['czf', opts.outPath, '-C', opts.root, ...relPaths];

  let res;
  try {
    res = await runCommand('tar', args);
  } catch (err) {
    throw new Error(
      `Could not run "tar": ${(err as Error).message}. Is tar installed and on PATH?`,
    );
  }
  if (res.code !== 0) {
    throw new Error(`tar exited with code ${res.code}: ${res.stderr.trim()}`);
  }

  const { size } = fs.statSync(opts.outPath);
  return { outPath: opts.outPath, bytes: size, items };
}

export interface RestoreBackupOptions {
  archivePath: string;
  root: string;
}

/** I/O: shells out to `tar xzf` to extract the archive into root. */
export async function restoreBackup(opts: RestoreBackupOptions): Promise<void> {
  if (!fs.existsSync(opts.archivePath)) {
    throw new Error(`Backup file not found: ${opts.archivePath}`);
  }
  fs.mkdirSync(opts.root, { recursive: true });

  let res;
  try {
    res = await runCommand('tar', ['xzf', opts.archivePath, '-C', opts.root]);
  } catch (err) {
    throw new Error(
      `Could not run "tar": ${(err as Error).message}. Is tar installed and on PATH?`,
    );
  }
  if (res.code !== 0) {
    throw new Error(`tar exited with code ${res.code}: ${res.stderr.trim()}`);
  }
}
