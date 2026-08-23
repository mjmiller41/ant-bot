import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db/db.js';
import { Store } from '../db/store.js';
import { SkillStore, MultipleSkillsError, parseFrontmatter, renderSkillFile, SKILL_TEMPLATE } from './skills.js';

describe('frontmatter round-trip', () => {
  it('renders and parses name/description/body', () => {
    const rendered = renderSkillFile({
      name: 'Weekly Report',
      description: 'Builds the weekly report',
      bodyMd: '## When to use it\nWeekly.',
    });
    const parsed = parseFrontmatter(rendered);
    expect(parsed.name).toBe('Weekly Report');
    expect(parsed.description).toBe('Builds the weekly report');
    expect(parsed.bodyMd.trim()).toBe('## When to use it\nWeekly.');
  });

  it('escapes and unescapes embedded quotes', () => {
    const rendered = renderSkillFile({ name: 'Say "Hi"', description: 'a "quoted" desc', bodyMd: 'body' });
    const parsed = parseFrontmatter(rendered);
    expect(parsed.name).toBe('Say "Hi"');
    expect(parsed.description).toBe('a "quoted" desc');
  });

  it('falls back gracefully on non-frontmatter markdown', () => {
    const parsed = parseFrontmatter('# just a heading\nno frontmatter here');
    expect(parsed.name).toBe('');
    expect(parsed.bodyMd).toContain('just a heading');
  });
});

describe('SkillStore', () => {
  let dir: string;
  let store: Store;
  let skills: SkillStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-'));
    store = new Store(openDb(':memory:'));
    skills = new SkillStore(store, dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a skill on disk and registers it in the db', () => {
    const skill = skills.writeSkill({ name: 'Weekly Report', description: 'desc', bodyMd: 'body text' });
    expect(skill.slug).toBe('weekly-report');
    expect(fs.existsSync(path.join(dir, 'weekly-report', 'SKILL.md'))).toBe(true);
    expect(store.getSkill(skill.id)).not.toBeNull();
    expect(store.getSkillBySlug('weekly-report')?.id).toBe(skill.id);
  });

  it('de-duplicates slugs for two skills with the same name', () => {
    const a = skills.writeSkill({ name: 'Digest', bodyMd: 'a' });
    const b = skills.writeSkill({ name: 'Digest', bodyMd: 'b' });
    expect(a.slug).toBe('digest');
    expect(b.slug).not.toBe('digest');
    expect(fs.existsSync(path.join(dir, b.slug, 'SKILL.md'))).toBe(true);
  });

  it('reads a skill back with its body (frontmatter stripped)', () => {
    const skill = skills.writeSkill({ name: 'Bug Repro', bodyMd: '## When to use it\nWhen a bug report comes in.' });
    const read = skills.readSkill(skill.id);
    expect(read?.bodyMd).toContain('When a bug report comes in.');
    expect(read?.bodyMd).not.toContain('---');
    expect(read?.name).toBe('Bug Repro');
  });

  it('returns null reading a missing skill', () => {
    expect(skills.readSkill('does-not-exist')).toBeNull();
  });

  it('deletes a skill directory and its db row', () => {
    const skill = skills.writeSkill({ name: 'Temp Skill', bodyMd: 'x' });
    skills.deleteSkill(skill.id);
    expect(fs.existsSync(path.join(dir, 'temp-skill'))).toBe(false);
    expect(store.getSkill(skill.id)).toBeNull();
  });

  it('deleting a missing skill id is a harmless no-op', () => {
    expect(() => skills.deleteSkill('nope')).not.toThrow();
  });

  it('rejects deleting a skill whose stored path escapes the skills dir', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-outside-'));
    const evil = store.createSkill({ slug: 'evil', name: 'Evil', path: outside });
    expect(() => skills.deleteSkill(evil.id)).toThrow();
    expect(fs.existsSync(outside)).toBe(true);
    expect(store.getSkill(evil.id)).not.toBeNull(); // db row untouched since delete was refused
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a traversal attempt via ../ in the stored path', () => {
    const evil = store.createSkill({ slug: 'evil2', name: 'Evil2', path: path.join(dir, '..', 'escaped') });
    expect(() => skills.deleteSkill(evil.id)).toThrow();
  });

  it('syncs an unregistered hand-authored skill from disk', () => {
    const skillDir = path.join(dir, 'hand-authored');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      renderSkillFile({ name: 'Hand Authored', description: 'd', bodyMd: 'b' }),
    );
    const added = skills.syncFromDisk();
    expect(added).toHaveLength(1);
    expect(added[0]?.slug).toBe('hand-authored');
    expect(store.getSkillBySlug('hand-authored')).not.toBeNull();
  });

  it('ignores directories without a SKILL.md', () => {
    fs.mkdirSync(path.join(dir, 'not-a-skill'), { recursive: true });
    const added = skills.syncFromDisk();
    expect(added).toHaveLength(0);
  });

  it('syncFromDisk is idempotent', () => {
    const skillDir = path.join(dir, 'hand-authored-2');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      renderSkillFile({ name: 'X', description: '', bodyMd: 'b' }),
    );
    const first = skills.syncFromDisk();
    expect(first).toHaveLength(1);
    const before = store.listSkills().length;
    const second = skills.syncFromDisk();
    expect(second).toHaveLength(0);
    expect(store.listSkills().length).toBe(before);
  });

  it('SKILL_TEMPLATE contains all six required sections', () => {
    for (const heading of [
      'When to use it',
      'Required inputs and access',
      'Sequence of work',
      'How to validate the result',
      'What to return',
      'What requires approval',
    ]) {
      expect(SKILL_TEMPLATE).toContain(heading);
    }
  });
});

describe('SkillStore.refreshFromDisk', () => {
  let dir: string;
  let store: Store;
  let skills: SkillStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-refresh-'));
    store = new Store(openDb(':memory:'));
    skills = new SkillStore(store, dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function writeFile(slug: string, name: string, description: string): void {
    fs.mkdirSync(path.join(dir, slug), { recursive: true });
    fs.writeFileSync(
      path.join(dir, slug, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    );
  }

  it('pulls a renamed skill back in line with its file', () => {
    // The upgrade that renamed the bundled skills to spec-conformant slugs: the row still
    // says "Weekly Report" while the file now says weekly-report, and the SDK is handed the row.
    writeFile('weekly-report', 'Weekly Report', 'old');
    skills.syncFromDisk();
    writeFile('weekly-report', 'weekly-report', 'new');

    expect(skills.refreshFromDisk(['weekly-report'])).toEqual(['weekly-report']);
    const row = store.getSkillBySlug('weekly-report')!;
    expect(row.name).toBe('weekly-report');
    expect(row.description).toBe('new');
  });

  it('keeps bot assignments across the rename', () => {
    writeFile('weekly-report', 'Weekly Report', 'old');
    skills.syncFromDisk();
    const skill = store.getSkillBySlug('weekly-report')!;
    const bot = store.createBot({ name: 'Ana', title: 't', description: 'j' });
    store.setBotSkills(bot.id, [skill.id]);

    writeFile('weekly-report', 'weekly-report', 'new');
    skills.refreshFromDisk(['weekly-report']);

    expect(store.listBotSkills(bot.id).map((s) => s.name)).toEqual(['weekly-report']);
  });

  it('reports nothing when the file and the row already agree', () => {
    writeFile('alpha', 'alpha', 'same');
    skills.syncFromDisk();
    expect(skills.refreshFromDisk(['alpha'])).toEqual([]);
  });

  it('ignores slugs with no row and slugs with no file', () => {
    writeFile('alpha', 'alpha', 'a');
    expect(skills.refreshFromDisk(['alpha'])).toEqual([]); // never registered
    skills.syncFromDisk();
    fs.rmSync(path.join(dir, 'alpha'), { recursive: true, force: true });
    expect(skills.refreshFromDisk(['alpha', 'nonexistent'])).toEqual([]);
  });

  it('keeps the registered name when a file loses its frontmatter name', () => {
    writeFile('alpha', 'alpha', 'a');
    skills.syncFromDisk();
    fs.writeFileSync(path.join(dir, 'alpha', 'SKILL.md'), '# no frontmatter\n');
    skills.refreshFromDisk(['alpha']);
    expect(store.getSkillBySlug('alpha')!.name).toBe('alpha');
  });
});

describe('parseFrontmatter — YAML block scalars', () => {
  // Real published skills use folded (`>`) and literal (`|`) descriptions. The description
  // is what the model matches on when deciding to reach for a skill, so losing it to a
  // stray ">" makes the skill effectively invisible.
  it('folds a `>` block into a single line', () => {
    const md = [
      '---', 'name: academy-guide', 'description: >',
      '  Stop and check this skill before finishing any reply',
      '  about how to use Claude.', '---', '', '# Body',
    ].join('\n');
    const r = parseFrontmatter(md);
    expect(r.name).toBe('academy-guide');
    expect(r.description).toBe('Stop and check this skill before finishing any reply about how to use Claude.');
    expect(r.bodyMd.trim()).toBe('# Body');
  });

  it('keeps line breaks for a `|` literal block', () => {
    const md = ['---', 'name: x', 'description: |', '  line one', '  line two', '---', 'body'].join('\n');
    expect(parseFrontmatter(md).description).toBe('line one\nline two');
  });

  it('handles the `|-` strip indicator', () => {
    const md = ['---', 'name: claude-api', 'description: |-', '  first', '  second', '---', 'b'].join('\n');
    expect(parseFrontmatter(md).description).toBe('first\nsecond');
  });

  it('stops the block at the next top-level key', () => {
    const md = [
      '---', 'name: x', 'description: >', '  folded text', 'license: MIT', '---', 'b',
    ].join('\n');
    const r = parseFrontmatter(md);
    expect(r.description).toBe('folded text');
    expect(r.name).toBe('x');
  });

  it('still handles a plain single-line description', () => {
    const md = ['---', 'name: x', 'description: just a line', '---', 'b'].join('\n');
    expect(parseFrontmatter(md).description).toBe('just a line');
  });

  it('still handles a quoted description', () => {
    const md = ['---', 'name: x', 'description: "quoted \\"inner\\" text"', '---', 'b'].join('\n');
    expect(parseFrontmatter(md).description).toBe('quoted "inner" text');
  });

  it('preserves paragraph breaks in a folded block', () => {
    const md = ['---', 'name: x', 'description: >', '  para one', '', '  para two', '---', 'b'].join('\n');
    expect(parseFrontmatter(md).description).toBe('para one\npara two');
  });
});

/** A local directory holding `names.length` skill directories, usable as an install source. */
function makeSourceRepo(names: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-src-'));
  for (const n of names) {
    fs.mkdirSync(path.join(root, n), { recursive: true });
    fs.writeFileSync(
      path.join(root, n, 'SKILL.md'),
      renderSkillFile({ name: n, description: `the ${n} skill`, bodyMd: 'body' }),
    );
  }
  return root;
}

describe('installFromSource — a multi-skill source needs opting in', () => {
  let dir: string;
  let store: Store;
  let skills: SkillStore;
  const temps: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-'));
    store = new Store(openDb(':memory:'));
    skills = new SkillStore(store, dir);
  });
  afterEach(() => {
    for (const t of [dir, ...temps]) fs.rmSync(t, { recursive: true, force: true });
    temps.length = 0;
  });

  it('installs a single-skill source without ceremony', async () => {
    const src = makeSourceRepo(['deep-research']);
    temps.push(src);
    const installed = await skills.installFromSource(src);
    expect(installed.map((i) => i.skill.slug)).toEqual(['deep-research']);
  });

  it('refuses a source holding several skills, and installs nothing', async () => {
    const src = makeSourceRepo(['deep-research', 'pdf-tools', 'transcribe']);
    temps.push(src);
    await expect(skills.installFromSource(src)).rejects.toBeInstanceOf(MultipleSkillsError);
    expect(store.listSkills()).toHaveLength(0);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('names what it found so the caller can narrow the source', async () => {
    const src = makeSourceRepo(['deep-research', 'pdf-tools']);
    temps.push(src);
    await expect(skills.installFromSource(src)).rejects.toMatchObject({
      names: expect.arrayContaining(['deep-research', 'pdf-tools']),
    });
  });

  it('installs everything when the caller explicitly opts in', async () => {
    const src = makeSourceRepo(['deep-research', 'pdf-tools']);
    temps.push(src);
    const installed = await skills.installFromSource(src, { allowMultiple: true });
    expect(installed).toHaveLength(2);
    expect(store.listSkills()).toHaveLength(2);
  });
});

describe('installFromSource — spec check in the manifest', () => {
  let dir: string;
  let store: Store;
  let skills: SkillStore;
  const temps: string[] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-'));
    store = new Store(openDb(':memory:'));
    skills = new SkillStore(store, dir);
  });
  afterEach(() => {
    for (const t of [dir, ...temps]) fs.rmSync(t, { recursive: true, force: true });
    temps.length = 0;
  });

  function makeSkillDir(dirName: string, frontmatterName: string, body = 'body'): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-src-'));
    fs.mkdirSync(path.join(root, dirName), { recursive: true });
    fs.writeFileSync(
      path.join(root, dirName, 'SKILL.md'),
      `---\nname: ${frontmatterName}\ndescription: a skill\n---\n\n${body}\n`,
    );
    temps.push(root);
    return root;
  }

  it('says nothing extra when the skill conforms', async () => {
    const [installed] = await skills.installFromSource(makeSkillDir('alpha', 'alpha'));
    expect(installed!.manifestText).not.toContain('spec');
  });

  it('flags a non-conforming skill without refusing to install it', async () => {
    // A third-party skill with a sloppy frontmatter still works; staying silent about it is
    // how it stays broken.
    const [installed] = await skills.installFromSource(makeSkillDir('alpha', 'Alpha Skill'));
    expect(installed!.manifestText).toContain('does not conform');
    expect(installed!.manifestText).toContain('name-charset');
    expect(store.listSkills()).toHaveLength(1);
  });

  it('calls out a name/directory mismatch specifically', async () => {
    // installFromSource lands the skill in a directory named after `slugify(name)`, so a
    // mismatch only arises when the name itself is not already a slug — "Alpha Skill" is
    // written to alpha-skill/, and the frontmatter then disagrees with its own directory.
    const [installed] = await skills.installFromSource(makeSkillDir('alpha', 'Alpha Skill'));
    expect(installed!.manifestText).toContain('name-dir-mismatch');
    expect(installed!.manifestText).toContain('bots cannot actually enable this skill');
  });

  it('flags a reference the skill does not ship', async () => {
    const src = makeSkillDir('alpha', 'alpha', 'See [the guide](references/GUIDE.md).');
    const [installed] = await skills.installFromSource(src);
    expect(installed!.manifestText).toContain('reference-missing');
  });
});

describe('reconcile — registry vs. disk', () => {
  let dir: string;
  let store: Store;
  let skills: SkillStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-'));
    store = new Store(openDb(':memory:'));
    skills = new SkillStore(store, dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('leaves a healthy registry untouched', () => {
    skills.writeSkill({ name: 'Weekly Report', bodyMd: 'body' });
    expect(skills.reconcile()).toEqual({ repaired: [], removed: [] });
    expect(store.listSkills()).toHaveLength(1);
  });

  it('drops rows whose directory was deleted outside the app', () => {
    const kept = skills.writeSkill({ name: 'Keeper', bodyMd: 'body' });
    const gone = skills.writeSkill({ name: 'Goner', bodyMd: 'body' });
    fs.rmSync(path.join(dir, gone.slug), { recursive: true, force: true });

    expect(skills.reconcile()).toEqual({ repaired: [], removed: [gone.slug] });
    expect(store.listSkills().map((x) => x.id)).toEqual([kept.id]);
  });

  it('repairs a moved directory in place rather than dropping it', () => {
    const skill = skills.writeSkill({ name: 'Weekly Report', bodyMd: 'body' });
    // Simulate the legacy layout: the row points somewhere the files no longer are.
    store.updateSkill(skill.id, { path: path.join(dir, '..', 'stale', skill.slug) });

    expect(skills.reconcile()).toEqual({ repaired: [skill.slug], removed: [] });
    expect(store.getSkill(skill.id)?.path).toBe(path.join(dir, skill.slug));
  });

  it('keeps bot assignments across a repair', () => {
    const skill = skills.writeSkill({ name: 'Weekly Report', bodyMd: 'body' });
    const bot = store.createBot({ name: 'Scout' });
    store.setBotSkills(bot.id, [skill.id]);
    store.updateSkill(skill.id, { path: path.join(dir, '..', 'stale', skill.slug) });

    skills.reconcile();
    expect(store.listBotSkills(bot.id).map((x) => x.id)).toEqual([skill.id]);
  });

  it('drops the assignment when the skill is really gone', () => {
    const skill = skills.writeSkill({ name: 'Weekly Report', bodyMd: 'body' });
    const bot = store.createBot({ name: 'Scout' });
    store.setBotSkills(bot.id, [skill.id]);
    fs.rmSync(path.join(dir, skill.slug), { recursive: true, force: true });

    skills.reconcile();
    expect(store.listBotSkills(bot.id)).toHaveLength(0);
  });

  it('is idempotent', () => {
    const skill = skills.writeSkill({ name: 'Weekly Report', bodyMd: 'body' });
    fs.rmSync(path.join(dir, skill.slug), { recursive: true, force: true });
    skills.reconcile();
    expect(skills.reconcile()).toEqual({ repaired: [], removed: [] });
  });
});
