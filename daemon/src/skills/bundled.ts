import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyTree } from './install.js';
import { findBundledSkillsDir, nodeLocateDeps } from '../util/locate.js';

/**
 * Skills that ship with ant-bot itself, in the repo's (and the published package's)
 * `skills/` directory, installed into the user's skills directory on boot.
 *
 * The hard part is not copying files, it is deciding what to copy *again*. A bundled skill
 * has two owners: ant-bot ships updates to it, and the user is free to edit or delete it.
 * Refreshing unconditionally throws away the user's edits and resurrects what they deleted;
 * seeding once means a shipped fix never reaches anyone who already has the old copy. So the
 * hash of what we wrote is recorded in a ledger, and on the next boot the on-disk copy is
 * compared against it: untouched copies track upstream, touched ones are left alone. This is
 * the same bargain a package manager makes with an edited config file.
 */

const LEDGER_FILE = '.managed.json';
const LEDGER_VERSION = 1;

export interface LedgerEntry {
  /** Hash of the skill directory as ant-bot last wrote it. */
  hash: string;
  syncedAt: string;
}

export interface Ledger {
  version: number;
  skills: Record<string, LedgerEntry>;
}

export type SkillSyncAction =
  /** Not on disk and never seeded — a first install. */
  | 'install'
  /** Ours, untouched by the user, and the shipped copy changed. */
  | 'update'
  /** Not in the ledger but byte-identical to what ships — adopt it so it tracks upstream. */
  | 'adopt'
  /** Ours, untouched, already current. */
  | 'unchanged'
  /** Ours, but the user edited it. */
  | 'skip-modified'
  /** Same slug, different content, never seeded by us — someone else's skill. */
  | 'skip-foreign'
  /** Seeded once and since deleted by the user. */
  | 'skip-deleted';

export interface SkillSyncState {
  slug: string;
  /** Hash of the skill as it ships with this build. */
  shippedHash: string;
  /** Hash of the copy in the user's skills directory, or null if it is not there. */
  installedHash: string | null;
  /** Hash recorded the last time ant-bot wrote this skill, or undefined if it never did. */
  ledgerHash: string | undefined;
  /** Hashes this skill shipped with in earlier ant-bot versions. See KNOWN_PRIOR_HASHES. */
  priorHashes?: string[];
}

/**
 * Hashes of skills as earlier ant-bot versions shipped them, before the ledger existed.
 *
 * Without this an upgrade that changes a shipped skill can never reach anyone who already has
 * it: their copy is not in the ledger and no longer matches what ships, so it reads as someone
 * else's skill and is left alone forever. Matching a known prior hash proves the copy is an
 * untouched older version of ours, which is safe to replace. This is the same record dpkg keeps
 * for conffiles, and it is append-only — add the outgoing hash here whenever a shipped skill
 * changes, never remove one.
 */
export const KNOWN_PRIOR_HASHES: Record<string, string[]> = {
  // 0.1.0, seeded from skills-examples/ — before the skills were renamed to spec-conformant
  // frontmatter names and deep-research got its references/ directory.
  'bug-repro': ['e8faa77eb98c3ba4d7618731d946c233354d158b3ecae7b1bed5908dce3e9cac'],
  'deep-research': ['33f7482fa2d136dad53c556b5a25527136838f8bd72d35a9657f45e6c21f391b'],
  'inbox-digest': ['45e137d9d6ce26ad6e230ef1b0711ad7d6b4be06d744f42accea2700f0039361'],
  'weekly-report': ['fb05e984b96e8771b236602b47a82f1ec600bd307b44878cd92694cdb658a852'],
};

export interface SkillSyncDecision {
  slug: string;
  action: SkillSyncAction;
}

/**
 * Decide what to do with each bundled skill. Pure, so every branch below is testable without
 * touching a filesystem — and there are more branches here than the copying deserves.
 */
export function planSkillSync(states: SkillSyncState[]): SkillSyncDecision[] {
  return states.map(({ slug, shippedHash, installedHash, ledgerHash, priorHashes }): SkillSyncDecision => {
    if (installedHash === null) {
      // A ledger entry with nothing on disk means the user deleted it. Putting it back on
      // every boot would make deletion impossible.
      return { slug, action: ledgerHash === undefined ? 'install' : 'skip-deleted' };
    }
    if (ledgerHash === undefined) {
      // Never seeded by us. Byte-identical to what ships means a pre-ledger seed from an older
      // ant-bot: adopt it as-is. Matching a hash we are known to have shipped before means an
      // untouched *older* copy of ours, safe to bring up to date. Anything else belongs to
      // whoever put it there (`antbot skill add`, or dropped in by hand) and we keep our hands off.
      if (installedHash === shippedHash) return { slug, action: 'adopt' };
      if (priorHashes?.includes(installedHash)) return { slug, action: 'update' };
      return { slug, action: 'skip-foreign' };
    }
    if (installedHash !== ledgerHash) return { slug, action: 'skip-modified' };
    return { slug, action: installedHash === shippedHash ? 'unchanged' : 'update' };
  });
}

/** Hash a skill directory: every file's path and contents, in a stable order. */
export function hashSkillDir(dir: string): string {
  const h = crypto.createHash('sha256');
  for (const rel of listFilesRecursive(dir).sort()) {
    h.update(rel.split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function listFilesRecursive(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Mirrors copyTree: what is not copied must not be hashed, or a skill would look
    // modified forever.
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) continue;
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function readLedger(targetDir: string): Ledger {
  try {
    const raw = fs.readFileSync(path.join(targetDir, LEDGER_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    if (parsed.version !== LEDGER_VERSION || typeof parsed.skills !== 'object' || !parsed.skills) {
      return { version: LEDGER_VERSION, skills: {} };
    }
    return { version: LEDGER_VERSION, skills: parsed.skills };
  } catch {
    // No ledger, or an unreadable one. Treating it as empty is safe: every on-disk skill then
    // looks foreign or adoptable, and nothing gets overwritten.
    return { version: LEDGER_VERSION, skills: {} };
  }
}

export function writeLedger(targetDir: string, ledger: Ledger): void {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

/** Location of the skills that ship with ant-bot; see `util/locate.ts` for the candidate order. */
export function defaultBundledSkillsDir(): string {
  return findBundledSkillsDir(
    nodeLocateDeps(path.dirname(fileURLToPath(import.meta.url)), () => null),
  );
}

/**
 * Install or refresh ant-bot's own skills in `targetDir`. Safe to call on every boot; see the
 * module comment for why it is not a plain copy. Returns what it did, for the boot log.
 */
export function syncBundledSkills(
  targetDir: string,
  bundledDir: string = defaultBundledSkillsDir(),
): SkillSyncDecision[] {
  if (!fs.existsSync(bundledDir)) return [];

  const ledger = readLedger(targetDir);
  const states: SkillSyncState[] = [];
  const shippedDirs = new Map<string, string>();

  for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(bundledDir, entry.name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    const dest = path.join(targetDir, entry.name);
    shippedDirs.set(entry.name, src);
    states.push({
      slug: entry.name,
      shippedHash: hashSkillDir(src),
      installedHash: fs.existsSync(path.join(dest, 'SKILL.md')) ? hashSkillDir(dest) : null,
      ledgerHash: ledger.skills[entry.name]?.hash,
      priorHashes: KNOWN_PRIOR_HASHES[entry.name],
    });
  }
  if (states.length === 0) return [];

  const decisions = planSkillSync(states);
  const byslug = new Map(states.map((s) => [s.slug, s]));
  const syncedAt = new Date().toISOString();
  let ledgerChanged = false;

  fs.mkdirSync(targetDir, { recursive: true });
  for (const decision of decisions) {
    const state = byslug.get(decision.slug)!;
    if (decision.action === 'install' || decision.action === 'update') {
      const dest = path.join(targetDir, decision.slug);
      fs.rmSync(dest, { recursive: true, force: true });
      copyTree(shippedDirs.get(decision.slug)!, dest);
    } else if (decision.action !== 'adopt') {
      continue;
    }
    ledger.skills[decision.slug] = { hash: state.shippedHash, syncedAt };
    ledgerChanged = true;
  }
  if (ledgerChanged) writeLedger(targetDir, ledger);

  return decisions;
}
