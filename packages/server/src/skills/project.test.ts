import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncProjectSkills } from './skills.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-proj-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeSkill(dir: string, name: string, body = 'body') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
}

describe('syncProjectSkills', () => {
  it('installs skills committed to the project', () => {
    writeSkill(path.join(tmp, 'project/alpha'), 'alpha');
    writeSkill(path.join(tmp, 'project/beta'), 'beta');
    const synced = syncProjectSkills(path.join(tmp, 'installed'), path.join(tmp, 'project'));
    expect(synced.sort()).toEqual(['alpha', 'beta']);
    expect(fs.existsSync(path.join(tmp, 'installed/alpha/SKILL.md'))).toBe(true);
  });

  it('refreshes an edited project skill on the next boot', () => {
    writeSkill(path.join(tmp, 'project/alpha'), 'alpha', 'v1');
    syncProjectSkills(path.join(tmp, 'installed'), path.join(tmp, 'project'));
    writeSkill(path.join(tmp, 'project/alpha'), 'alpha', 'v2');
    syncProjectSkills(path.join(tmp, 'installed'), path.join(tmp, 'project'));
    expect(fs.readFileSync(path.join(tmp, 'installed/alpha/SKILL.md'), 'utf8')).toContain('v2');
  });

  it('carries supporting files along', () => {
    writeSkill(path.join(tmp, 'project/alpha'), 'alpha');
    fs.mkdirSync(path.join(tmp, 'project/alpha/reference'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'project/alpha/reference/spec.md'), 'spec');
    syncProjectSkills(path.join(tmp, 'installed'), path.join(tmp, 'project'));
    expect(fs.existsSync(path.join(tmp, 'installed/alpha/reference/spec.md'))).toBe(true);
  });

  it('ignores directories without a SKILL.md', () => {
    fs.mkdirSync(path.join(tmp, 'project/notaskill'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'project/notaskill/README.md'), 'x');
    expect(syncProjectSkills(path.join(tmp, 'installed'), path.join(tmp, 'project'))).toEqual([]);
  });

  it('is a no-op when the project has no skills directory', () => {
    expect(syncProjectSkills(path.join(tmp, 'installed'), path.join(tmp, 'nope'))).toEqual([]);
  });

  it('does not disturb skills installed from other sources', () => {
    writeSkill(path.join(tmp, 'installed/from-github'), 'from-github');
    writeSkill(path.join(tmp, 'project/alpha'), 'alpha');
    syncProjectSkills(path.join(tmp, 'installed'), path.join(tmp, 'project'));
    expect(fs.existsSync(path.join(tmp, 'installed/from-github/SKILL.md'))).toBe(true);
  });
});
