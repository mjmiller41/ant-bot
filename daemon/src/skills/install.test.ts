import { describe, it, expect } from 'vitest';
import { parseSkillSource, classifyFiles, isExecutableFile, describeSkillSource } from './install.js';

describe('parseSkillSource', () => {
  it('recognises a bare GitHub shorthand', () => {
    expect(parseSkillSource('github.com/acme/skills')).toEqual({
      kind: 'git', url: 'https://github.com/acme/skills', ref: undefined, subdir: undefined,
    });
  });

  it('recognises owner/repo shorthand as GitHub', () => {
    expect(parseSkillSource('acme/pdf-skill')).toEqual({
      kind: 'git', url: 'https://github.com/acme/pdf-skill', ref: undefined, subdir: undefined,
    });
  });

  it('keeps an explicit https git URL', () => {
    expect(parseSkillSource('https://github.com/acme/skills.git')).toMatchObject({
      kind: 'git', url: 'https://github.com/acme/skills.git',
    });
  });

  it('supports an ssh git URL', () => {
    expect(parseSkillSource('git@github.com:acme/skills.git')).toMatchObject({
      kind: 'git', url: 'git@github.com:acme/skills.git',
    });
  });

  it('parses a #ref suffix', () => {
    expect(parseSkillSource('github.com/acme/skills#v2')).toMatchObject({ kind: 'git', ref: 'v2' });
  });

  it('parses a subdirectory for monorepos', () => {
    expect(parseSkillSource('github.com/acme/skills/tree/main/pdf')).toMatchObject({
      kind: 'git', url: 'https://github.com/acme/skills', ref: 'main', subdir: 'pdf',
    });
  });

  it('recognises a raw SKILL.md URL', () => {
    expect(parseSkillSource('https://example.com/a/SKILL.md')).toEqual({
      kind: 'url', url: 'https://example.com/a/SKILL.md',
    });
  });

  it('treats other https URLs as unsupported rather than guessing', () => {
    expect(() => parseSkillSource('https://example.com/skill.tar.gz')).toThrow(/SKILL\.md|git/i);
  });

  it('recognises relative and absolute local paths', () => {
    expect(parseSkillSource('./skills/mine')).toMatchObject({ kind: 'path' });
    expect(parseSkillSource('/opt/skills/mine')).toMatchObject({ kind: 'path' });
    expect(parseSkillSource('~/skills/mine')).toMatchObject({ kind: 'path' });
  });

  it('rejects empty input', () => {
    expect(() => parseSkillSource('   ')).toThrow();
  });
});

describe('parseSkillSource — a link to one skill inside a repository', () => {
  it('takes the directory from a /tree/<ref>/<dir> link', () => {
    expect(parseSkillSource('https://github.com/acme/skills/tree/main/deep-research')).toEqual({
      kind: 'git', url: 'https://github.com/acme/skills', ref: 'main', subdir: 'deep-research',
    });
  });

  // The link GitHub's own UI hands you points at the file, not the directory.
  it('drops a trailing /SKILL.md from a /blob/ link so it names the directory', () => {
    expect(parseSkillSource('https://github.com/acme/skills/blob/main/deep-research/SKILL.md')).toEqual({
      kind: 'git', url: 'https://github.com/acme/skills', ref: 'main', subdir: 'deep-research',
    });
  });

  it('handles a nested skill directory', () => {
    expect(parseSkillSource('https://github.com/acme/skills/blob/main/a/b/SKILL.md')).toMatchObject({
      subdir: 'a/b',
    });
  });

  it('treats a SKILL.md at the repo root as the whole repo, not a subdir', () => {
    expect(parseSkillSource('https://github.com/acme/skills/blob/main/SKILL.md')).toMatchObject({
      subdir: undefined,
    });
  });

  it('is case-insensitive about the filename', () => {
    expect(parseSkillSource('https://github.com/acme/skills/blob/main/x/skill.md')).toMatchObject({
      subdir: 'x',
    });
  });
});

describe('describeSkillSource', () => {
  it('calls out a whole-repository install explicitly', () => {
    const d = describeSkillSource('acme/skills');
    expect(d).toContain('EVERY skill');
    expect(d).toContain('whole repository');
  });

  it('names the single skill when the source is scoped', () => {
    expect(describeSkillSource('https://github.com/acme/skills/tree/main/deep-research')).toBe(
      'Install "deep-research" from github.com/acme/skills#main',
    );
  });

  it('describes a direct SKILL.md link as one skill', () => {
    expect(describeSkillSource('https://host/x/SKILL.md')).toBe('Install one skill from host/x/SKILL.md');
  });

  it('describes a local path', () => {
    expect(describeSkillSource('./my-skill')).toContain('local path');
  });

  it('never throws on an unparseable source', () => {
    expect(describeSkillSource('mcpmarket.com/tools/skills/deep-research-5')).toContain(
      'mcpmarket.com/tools/skills/deep-research-5',
    );
  });
});

describe('isExecutableFile', () => {
  it('flags files by script extension', () => {
    for (const n of ['run.py', 'go.sh', 'x.js', 'y.rb', 'z.pl', 'a.bash', 'b.ps1']) {
      expect(isExecutableFile(n, 0o644)).toBe(true);
    }
  });

  it('flags files carrying a unix execute bit', () => {
    expect(isExecutableFile('helper', 0o755)).toBe(true);
    expect(isExecutableFile('helper', 0o644)).toBe(false);
  });

  it('does not flag ordinary docs and data', () => {
    for (const n of ['SKILL.md', 'notes.txt', 'data.json', 'table.csv']) {
      expect(isExecutableFile(n, 0o644)).toBe(false);
    }
  });
});

describe('classifyFiles', () => {
  it('separates executables and totals the bytes', () => {
    const m = classifyFiles([
      { relPath: 'SKILL.md', bytes: 2100, mode: 0o644 },
      { relPath: 'reference/spec.md', bytes: 8400, mode: 0o644 },
      { relPath: 'scripts/extract.py', bytes: 1200, mode: 0o755 },
    ]);
    expect(m.totalBytes).toBe(11700);
    expect(m.executables).toEqual(['scripts/extract.py']);
    expect(m.files).toHaveLength(3);
  });

  it('reports no executables for a docs-only skill', () => {
    const m = classifyFiles([{ relPath: 'SKILL.md', bytes: 10, mode: 0o644 }]);
    expect(m.executables).toEqual([]);
  });
});

/* ------------------------------ staging an install ------------------------------ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach } from 'vitest';
import { stageFromPath, findSkillDirs, walkFiles } from './install.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-install-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeSkill(dir: string, name: string, extra: Record<string, string> = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: does ${name} things\n---\n\n## When to use it\nAlways.\n`);
  for (const [rel, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

describe('findSkillDirs', () => {
  it('finds a skill at the root', () => {
    writeSkill(path.join(tmp, 'repo'), 'alpha');
    expect(findSkillDirs(path.join(tmp, 'repo'))).toEqual([path.join(tmp, 'repo')]);
  });

  it('finds several skills in one repo', () => {
    writeSkill(path.join(tmp, 'repo/skills/alpha'), 'alpha');
    writeSkill(path.join(tmp, 'repo/skills/beta'), 'beta');
    expect(findSkillDirs(path.join(tmp, 'repo'))).toHaveLength(2);
  });

  it('does not descend into a skill that contains nested markdown', () => {
    writeSkill(path.join(tmp, 'repo/alpha'), 'alpha', { 'reference/SKILL.md': 'decoy' });
    expect(findSkillDirs(path.join(tmp, 'repo'))).toEqual([path.join(tmp, 'repo/alpha')]);
  });

  it('returns nothing when there is no SKILL.md', () => {
    fs.mkdirSync(path.join(tmp, 'repo/docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'repo/docs/README.md'), 'hi');
    expect(findSkillDirs(path.join(tmp, 'repo'))).toEqual([]);
  });
});

describe('walkFiles', () => {
  it('ignores .git and node_modules', () => {
    writeSkill(path.join(tmp, 's'), 'alpha', { 'scripts/go.py': 'print(1)' });
    fs.mkdirSync(path.join(tmp, 's/.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 's/.git/config'), 'x');
    const rels = walkFiles(path.join(tmp, 's')).map((f) => f.relPath).sort();
    expect(rels).toEqual(['SKILL.md', path.join('scripts', 'go.py')]);
  });
});

describe('stageFromPath', () => {
  it('stages a single skill directory', async () => {
    writeSkill(path.join(tmp, 'mine'), 'my-skill');
    const staged = await stageFromPath({ kind: 'path', path: path.join(tmp, 'mine') });
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe('my-skill');
    expect(staged[0].description).toBe('does my-skill things');
    expect(staged[0].manifest.files.map((f) => f.relPath)).toContain('SKILL.md');
  });

  it('accepts a path pointing straight at a SKILL.md', async () => {
    writeSkill(path.join(tmp, 'mine'), 'my-skill');
    const staged = await stageFromPath({ kind: 'path', path: path.join(tmp, 'mine/SKILL.md') });
    expect(staged[0].name).toBe('my-skill');
  });

  it('stages every skill in a directory of skills', async () => {
    writeSkill(path.join(tmp, 'pack/alpha'), 'alpha');
    writeSkill(path.join(tmp, 'pack/beta'), 'beta');
    const staged = await stageFromPath({ kind: 'path', path: path.join(tmp, 'pack') });
    expect(staged.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('surfaces bundled scripts in the manifest', async () => {
    writeSkill(path.join(tmp, 'mine'), 'my-skill', { 'scripts/extract.py': 'print(1)' });
    const staged = await stageFromPath({ kind: 'path', path: path.join(tmp, 'mine') });
    expect(staged[0].manifest.executables).toEqual([path.join('scripts', 'extract.py')]);
  });

  it('refuses a directory with no SKILL.md', async () => {
    fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
    await expect(stageFromPath({ kind: 'path', path: path.join(tmp, 'empty') })).rejects.toThrow(/SKILL\.md/i);
  });

  it('refuses a missing path', async () => {
    await expect(stageFromPath({ kind: 'path', path: path.join(tmp, 'nope') })).rejects.toThrow(/not found|no such/i);
  });

  it('refuses a SKILL.md with no name in its frontmatter', async () => {
    fs.mkdirSync(path.join(tmp, 'bad'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'bad/SKILL.md'), '# no frontmatter here\n');
    await expect(stageFromPath({ kind: 'path', path: path.join(tmp, 'bad') })).rejects.toThrow(/name/i);
  });
});
