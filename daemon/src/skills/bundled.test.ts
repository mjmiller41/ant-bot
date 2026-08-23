import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planSkillSync,
  hashSkillDir,
  readLedger,
  KNOWN_PRIOR_HASHES,
  syncBundledSkills,
  defaultBundledSkillsDir,
  type SkillSyncState,
} from './bundled.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-bundled-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const bundled = (): string => path.join(tmp, 'bundled');
const installed = (): string => path.join(tmp, 'installed');

function writeSkill(dir: string, name: string, body = 'body'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
}

function state(over: Partial<SkillSyncState> = {}): SkillSyncState {
  return { slug: 'alpha', shippedHash: 'ship', installedHash: 'ship', ledgerHash: 'ship', ...over };
}

function sync(): ReturnType<typeof syncBundledSkills> {
  return syncBundledSkills(installed(), bundled());
}

function actionOf(slug: string, decisions: ReturnType<typeof syncBundledSkills>): string | undefined {
  return decisions.find((d) => d.slug === slug)?.action;
}

describe('planSkillSync', () => {
  it('installs a skill that is absent and was never seeded', () => {
    expect(planSkillSync([state({ installedHash: null, ledgerHash: undefined })]))
      .toEqual([{ slug: 'alpha', action: 'install' }]);
  });

  it('leaves a skill the user deleted deleted', () => {
    expect(planSkillSync([state({ installedHash: null, ledgerHash: 'ship' })]))
      .toEqual([{ slug: 'alpha', action: 'skip-deleted' }]);
  });

  it('updates our own copy when the shipped version changes', () => {
    expect(planSkillSync([state({ shippedHash: 'v2', installedHash: 'v1', ledgerHash: 'v1' })]))
      .toEqual([{ slug: 'alpha', action: 'update' }]);
  });

  it('does nothing when our copy is already current', () => {
    expect(planSkillSync([state()])).toEqual([{ slug: 'alpha', action: 'unchanged' }]);
  });

  it('never overwrites a copy the user edited', () => {
    expect(planSkillSync([state({ shippedHash: 'v2', installedHash: 'edited', ledgerHash: 'v1' })]))
      .toEqual([{ slug: 'alpha', action: 'skip-modified' }]);
  });

  it('adopts an unrecorded copy that is identical to what ships', () => {
    // The pre-ledger seed path: an older ant-bot copied this file and recorded nothing.
    expect(planSkillSync([state({ ledgerHash: undefined })]))
      .toEqual([{ slug: 'alpha', action: 'adopt' }]);
  });

  it('keeps its hands off an unrecorded copy with different content', () => {
    expect(planSkillSync([state({ installedHash: 'someone-elses', ledgerHash: undefined })]))
      .toEqual([{ slug: 'alpha', action: 'skip-foreign' }]);
  });

  it('updates an untouched copy of a version we are known to have shipped', () => {
    // The pre-ledger upgrade that changes a skill: without the prior-hash list this reads as
    // someone else's skill and the fix never reaches anyone who already had it.
    expect(planSkillSync([state({
      shippedHash: 'v2', installedHash: 'v1', ledgerHash: undefined, priorHashes: ['v0', 'v1'],
    })])).toEqual([{ slug: 'alpha', action: 'update' }]);
  });

  it('still keeps its hands off an edited copy that matches no shipped version', () => {
    expect(planSkillSync([state({
      shippedHash: 'v2', installedHash: 'edited', ledgerHash: undefined, priorHashes: ['v1'],
    })])).toEqual([{ slug: 'alpha', action: 'skip-foreign' }]);
  });
});

describe('hashSkillDir', () => {
  it('changes when a file changes', () => {
    writeSkill(path.join(tmp, 'a'), 'alpha', 'v1');
    const before = hashSkillDir(path.join(tmp, 'a'));
    writeSkill(path.join(tmp, 'a'), 'alpha', 'v2');
    expect(hashSkillDir(path.join(tmp, 'a'))).not.toBe(before);
  });

  it('covers supporting files, not just SKILL.md', () => {
    writeSkill(path.join(tmp, 'a'), 'alpha');
    const before = hashSkillDir(path.join(tmp, 'a'));
    fs.mkdirSync(path.join(tmp, 'a/reference'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a/reference/spec.md'), 'spec');
    expect(hashSkillDir(path.join(tmp, 'a'))).not.toBe(before);
  });

  it('matches for two identical trees regardless of where they live', () => {
    writeSkill(path.join(tmp, 'a'), 'alpha');
    writeSkill(path.join(tmp, 'b'), 'alpha');
    expect(hashSkillDir(path.join(tmp, 'a'))).toBe(hashSkillDir(path.join(tmp, 'b')));
  });

  it('ignores what copyTree does not copy', () => {
    // Hashing .git would make an adopted skill look modified on the next boot forever.
    writeSkill(path.join(tmp, 'a'), 'alpha');
    const before = hashSkillDir(path.join(tmp, 'a'));
    fs.mkdirSync(path.join(tmp, 'a/.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'a/.git/HEAD'), 'ref');
    expect(hashSkillDir(path.join(tmp, 'a'))).toBe(before);
  });
});

describe('syncBundledSkills', () => {
  it('installs the shipped skills on a first run and records them', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha');
    writeSkill(path.join(bundled(), 'beta'), 'beta');
    const decisions = sync();
    expect(decisions.map((d) => d.action)).toEqual(['install', 'install']);
    expect(fs.existsSync(path.join(installed(), 'alpha/SKILL.md'))).toBe(true);
    expect(Object.keys(readLedger(installed()).skills).sort()).toEqual(['alpha', 'beta']);
  });

  it('carries supporting files along', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha');
    fs.mkdirSync(path.join(bundled(), 'alpha/reference'), { recursive: true });
    fs.writeFileSync(path.join(bundled(), 'alpha/reference/spec.md'), 'spec');
    sync();
    expect(fs.readFileSync(path.join(installed(), 'alpha/reference/spec.md'), 'utf8')).toBe('spec');
  });

  it('is a no-op on a second run with nothing changed', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha');
    sync();
    expect(actionOf('alpha', sync())).toBe('unchanged');
  });

  it('refreshes an untouched skill when the shipped copy changes', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha', 'v1');
    sync();
    writeSkill(path.join(bundled(), 'alpha'), 'alpha', 'v2');
    expect(actionOf('alpha', sync())).toBe('update');
    expect(fs.readFileSync(path.join(installed(), 'alpha/SKILL.md'), 'utf8')).toContain('v2');
  });

  it('keeps a user edit even when the shipped copy changes', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha', 'v1');
    sync();
    writeSkill(path.join(installed(), 'alpha'), 'alpha', 'my own version');
    writeSkill(path.join(bundled(), 'alpha'), 'alpha', 'v2');
    expect(actionOf('alpha', sync())).toBe('skip-modified');
    expect(fs.readFileSync(path.join(installed(), 'alpha/SKILL.md'), 'utf8')).toContain('my own version');
  });

  it('does not resurrect a skill the user deleted', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha');
    sync();
    fs.rmSync(path.join(installed(), 'alpha'), { recursive: true, force: true });
    expect(actionOf('alpha', sync())).toBe('skip-deleted');
    expect(fs.existsSync(path.join(installed(), 'alpha'))).toBe(false);
  });

  it('adopts a pre-ledger seed so it starts tracking upstream again', () => {
    // What an upgrade from a seedExamples-era install looks like: files on disk, no ledger.
    writeSkill(path.join(bundled(), 'alpha'), 'alpha', 'v1');
    writeSkill(path.join(installed(), 'alpha'), 'alpha', 'v1');
    expect(actionOf('alpha', sync())).toBe('adopt');
    writeSkill(path.join(bundled(), 'alpha'), 'alpha', 'v2');
    expect(actionOf('alpha', sync())).toBe('update');
  });

  it('will not overwrite a same-named skill installed from somewhere else', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha', 'ours');
    writeSkill(path.join(installed(), 'alpha'), 'alpha', 'from github');
    expect(actionOf('alpha', sync())).toBe('skip-foreign');
    expect(fs.readFileSync(path.join(installed(), 'alpha/SKILL.md'), 'utf8')).toContain('from github');
  });

  it('does not disturb skills installed from other sources', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha');
    writeSkill(path.join(installed(), 'from-github'), 'from-github');
    sync();
    expect(fs.existsSync(path.join(installed(), 'from-github/SKILL.md'))).toBe(true);
    expect(readLedger(installed()).skills['from-github']).toBeUndefined();
  });

  it('ignores directories without a SKILL.md', () => {
    fs.mkdirSync(path.join(bundled(), 'notaskill'), { recursive: true });
    fs.writeFileSync(path.join(bundled(), 'notaskill/README.md'), 'x');
    expect(sync()).toEqual([]);
    expect(fs.existsSync(path.join(installed(), 'notaskill'))).toBe(false);
  });

  it('is a no-op when there is no bundled skills directory', () => {
    expect(syncBundledSkills(installed(), path.join(tmp, 'nope'))).toEqual([]);
  });

  it('treats an unreadable ledger as empty rather than throwing', () => {
    writeSkill(path.join(bundled(), 'alpha'), 'alpha');
    sync();
    fs.writeFileSync(path.join(installed(), '.managed.json'), '{not json');
    expect(actionOf('alpha', sync())).toBe('adopt');
  });
});

describe('KNOWN_PRIOR_HASHES', () => {
  it('records a prior hash for every skill that shipped before the ledger existed', () => {
    // Append-only: dropping an entry silently strands every install still carrying that version.
    for (const slug of ['bug-repro', 'deep-research', 'inbox-digest', 'weekly-report']) {
      expect(KNOWN_PRIOR_HASHES[slug]?.length).toBeGreaterThan(0);
    }
  });

  it('holds sha256 hex digests', () => {
    for (const hashes of Object.values(KNOWN_PRIOR_HASHES)) {
      for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('never lists the hash a skill currently ships with', () => {
    // A current hash in this list would be dead weight at best; at worst it hides a real change.
    for (const [slug, hashes] of Object.entries(KNOWN_PRIOR_HASHES)) {
      const dir = path.join(defaultBundledSkillsDir(), slug);
      if (!fs.existsSync(dir)) continue;
      expect(hashes).not.toContain(hashSkillDir(dir));
    }
  });
});

describe('defaultBundledSkillsDir', () => {
  it("resolves to the repo's own skills directory", () => {
    const dir = defaultBundledSkillsDir();
    expect(fs.existsSync(path.join(dir, 'weekly-report', 'SKILL.md'))).toBe(true);
  });
});
