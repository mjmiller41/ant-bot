import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSkillPlugin, skillFilesDir, migrateLegacyLayout } from './plugin.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-plugin-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeSkill(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\nbody\n`);
}

describe('ensureSkillPlugin', () => {
  it('creates a valid local-plugin manifest the SDK can load', () => {
    ensureSkillPlugin(tmp);
    const manifest = path.join(tmp, '.claude-plugin', 'plugin.json');
    expect(fs.existsSync(manifest)).toBe(true);
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    expect(json.name).toBeTruthy();
    expect(fs.existsSync(skillFilesDir(tmp))).toBe(true);
  });

  it('is idempotent across boots', () => {
    ensureSkillPlugin(tmp);
    writeSkill(path.join(skillFilesDir(tmp), 'alpha'), 'alpha');
    ensureSkillPlugin(tmp);
    expect(fs.existsSync(path.join(skillFilesDir(tmp), 'alpha', 'SKILL.md'))).toBe(true);
  });

  it('puts skills under <root>/skills so the plugin loader finds them', () => {
    expect(skillFilesDir('/x')).toBe(path.join('/x', 'skills'));
  });
});

describe('migrateLegacyLayout', () => {
  it('moves skills that sat directly under the root into skills/', () => {
    // Pre-plugin layout: ~/.ant-bot/skills/<slug>/SKILL.md
    writeSkill(path.join(tmp, 'weekly-report'), 'Weekly Report');
    writeSkill(path.join(tmp, 'bug-repro'), 'Bug Reproduction');

    const moved = migrateLegacyLayout(tmp);

    expect(moved.sort()).toEqual(['bug-repro', 'weekly-report']);
    expect(fs.existsSync(path.join(skillFilesDir(tmp), 'weekly-report', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'weekly-report'))).toBe(false);
  });

  it('does nothing when already migrated', () => {
    ensureSkillPlugin(tmp);
    writeSkill(path.join(skillFilesDir(tmp), 'alpha'), 'alpha');
    expect(migrateLegacyLayout(tmp)).toEqual([]);
  });

  it('leaves the plugin manifest directory alone', () => {
    ensureSkillPlugin(tmp);
    migrateLegacyLayout(tmp);
    expect(fs.existsSync(path.join(tmp, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(skillFilesDir(tmp), '.claude-plugin'))).toBe(false);
  });

  it('does not clobber a skill that already exists at the destination', () => {
    ensureSkillPlugin(tmp);
    writeSkill(path.join(skillFilesDir(tmp), 'alpha'), 'new-alpha');
    writeSkill(path.join(tmp, 'alpha'), 'old-alpha');

    migrateLegacyLayout(tmp);

    const kept = fs.readFileSync(path.join(skillFilesDir(tmp), 'alpha', 'SKILL.md'), 'utf8');
    expect(kept).toContain('new-alpha');
  });
});
