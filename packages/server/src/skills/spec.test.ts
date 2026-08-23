import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateSkill,
  validateSkillDir,
  validateSkillsIn,
  extractFileReferences,
  readFrontmatterFields,
  SPEC_LIMITS,
  type SkillSpecInput,
} from './spec.js';
import { defaultBundledSkillsDir } from './bundled.js';

function input(over: Partial<SkillSpecInput> & { fm?: string; body?: string } = {}): SkillSpecInput {
  const fm = over.fm ?? 'name: alpha\ndescription: Does a thing. Use when a thing needs doing.';
  const body = over.body ?? '## When to use it\n\nWhenever.\n';
  return {
    dirName: over.dirName ?? 'alpha',
    raw: over.raw ?? `---\n${fm}\n---\n\n${body}`,
    files: over.files ?? ['SKILL.md'],
  };
}

const codes = (i: SkillSpecInput): string[] => validateSkill(i).map((v) => v.code);

describe('validateSkill — frontmatter', () => {
  it('passes a minimal conforming skill', () => {
    expect(validateSkill(input())).toEqual([]);
  });

  it('requires a frontmatter block', () => {
    expect(codes(input({ raw: '# Just a heading\n' }))).toEqual(['frontmatter-missing']);
  });

  it('rejects an uppercase or spaced name', () => {
    // The shape three of ant-bot's own skills shipped with before this check existed.
    expect(codes(input({ fm: 'name: "Weekly Report"\ndescription: d', dirName: 'weekly-report' })))
      .toEqual(expect.arrayContaining(['name-charset', 'name-dir-mismatch']));
  });

  it('rejects a name that does not match its directory', () => {
    expect(codes(input({ dirName: 'beta' }))).toEqual(['name-dir-mismatch']);
  });

  it('rejects leading, trailing and doubled hyphens', () => {
    expect(codes(input({ fm: 'name: -alpha\ndescription: d', dirName: '-alpha' }))).toContain('name-hyphen-edge');
    expect(codes(input({ fm: 'name: alpha-\ndescription: d', dirName: 'alpha-' }))).toContain('name-hyphen-edge');
    expect(codes(input({ fm: 'name: al--pha\ndescription: d', dirName: 'al--pha' }))).toContain('name-consecutive-hyphens');
  });

  it('enforces the name length limit', () => {
    const long = 'a'.repeat(SPEC_LIMITS.NAME_MAX + 1);
    expect(codes(input({ fm: `name: ${long}\ndescription: d`, dirName: long }))).toContain('name-too-long');
  });

  it('requires a non-empty description', () => {
    expect(codes(input({ fm: 'name: alpha\ndescription: ""' }))).toContain('description-missing');
    expect(codes(input({ fm: 'name: alpha' }))).toContain('description-missing');
  });

  it('enforces the description length limit', () => {
    const long = 'd'.repeat(SPEC_LIMITS.DESCRIPTION_MAX + 1);
    expect(codes(input({ fm: `name: alpha\ndescription: ${long}` }))).toContain('description-too-long');
  });

  it('accepts a description written as a YAML block scalar', () => {
    // Published skills routinely use `|` and `>` for long trigger lists.
    const fm = 'name: alpha\ndescription: |\n  Does a thing.\n  Use when a thing needs doing.';
    expect(validateSkill(input({ fm }))).toEqual([]);
  });

  it('enforces the compatibility length limit', () => {
    const long = 'c'.repeat(SPEC_LIMITS.COMPATIBILITY_MAX + 1);
    expect(codes(input({ fm: `name: alpha\ndescription: d\ncompatibility: ${long}` })))
      .toContain('compatibility-too-long');
  });

  it('accepts every optional spec field', () => {
    const fm = [
      'name: alpha',
      'description: d',
      'license: Apache-2.0',
      'compatibility: Requires git',
      'allowed-tools: Bash(git:*) Read',
      'metadata:',
      '  author: example-org',
    ].join('\n');
    expect(validateSkill(input({ fm }))).toEqual([]);
  });

  it('warns about a field the spec does not define', () => {
    const v = validateSkill(input({ fm: 'name: alpha\ndescription: d\nauthor: me' }));
    expect(v).toEqual([expect.objectContaining({ code: 'unknown-field', level: 'warning' })]);
  });
});

describe('validateSkill — body and references', () => {
  it('errors on a reference the skill does not ship', () => {
    const body = 'See [the guide](references/GUIDE.md).\n';
    expect(codes(input({ body }))).toEqual(['reference-missing']);
  });

  it('accepts a reference that is present', () => {
    const body = 'See [the guide](references/GUIDE.md).\n';
    expect(validateSkill(input({ body, files: ['SKILL.md', 'references/GUIDE.md'] }))).toEqual([]);
  });

  it('catches bare mentions of scripts/ and assets/ too', () => {
    expect(codes(input({ body: 'Run scripts/extract.py to start.\n' }))).toEqual(['reference-missing']);
    expect(codes(input({ body: 'Use `assets/template.docx`.\n' }))).toEqual(['reference-missing']);
  });

  it('ignores paths inside fenced code blocks', () => {
    // Examples in a fence are illustrative, not shipped files; flagging them trains people
    // to ignore the linter.
    const body = '```\nreferences/not-real.md\n```\n';
    expect(validateSkill(input({ body }))).toEqual([]);
  });

  it('ignores URLs, anchors and absolute paths', () => {
    const body = '[a](https://example.com) [b](#section) [c](/etc/passwd)\n';
    expect(validateSkill(input({ body }))).toEqual([]);
  });

  it('warns when a reference is more than one level deep', () => {
    const body = 'See [it](references/deep/GUIDE.md).\n';
    const v = validateSkill(input({ body, files: ['SKILL.md', 'references/deep/GUIDE.md'] }));
    expect(v).toEqual([expect.objectContaining({ code: 'reference-too-deep', level: 'warning' })]);
  });

  it('warns when the body outgrows the recommended length', () => {
    const body = `${'line\n'.repeat(SPEC_LIMITS.BODY_MAX_LINES + 1)}`;
    expect(validateSkill(input({ body })).map((x) => x.code)).toContain('body-too-long');
  });
});

describe('extractFileReferences', () => {
  it('finds markdown links, images and bare conventional paths', () => {
    const found = extractFileReferences(
      '[a](references/A.md) ![i](assets/i.png) run scripts/go.sh now\n',
    );
    expect(found.sort()).toEqual(['assets/i.png', 'references/A.md', 'scripts/go.sh']);
  });

  it('strips trailing punctuation from a bare path', () => {
    expect(extractFileReferences('See references/A.md, then stop.\n')).toEqual(['references/A.md']);
  });
});

describe('readFrontmatterFields', () => {
  it('reports top-level keys and skips nested ones', () => {
    const { found, fields } = readFrontmatterFields('---\nname: a\nmetadata:\n  author: b\n---\nbody');
    expect(found).toBe(true);
    expect([...fields.keys()]).toEqual(['name', 'metadata']);
  });
});

describe('validateSkillDir', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-spec-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors when there is no SKILL.md', () => {
    fs.mkdirSync(path.join(tmp, 'alpha'));
    expect(validateSkillDir(path.join(tmp, 'alpha')).map((v) => v.code)).toEqual(['skill-md-missing']);
  });

  it('validates a real directory, references included', () => {
    const dir = path.join(tmp, 'alpha');
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n\n[g](references/G.md)\n');
    expect(validateSkillDir(dir).map((v) => v.code)).toEqual(['reference-missing']);
    fs.writeFileSync(path.join(dir, 'references/G.md'), 'g');
    expect(validateSkillDir(dir)).toEqual([]);
  });
});

describe('the skills ant-bot ships', () => {
  // The bundled skills are the worked examples for docs/SKILLS.md and the thing every install
  // gets. If they do not pass, nothing else has standing to.
  it('all conform to the spec, with no warnings either', () => {
    const results = validateSkillsIn(defaultBundledSkillsDir());
    expect(results.length).toBeGreaterThan(0);
    const offenders = results
      .filter((r) => r.violations.length > 0)
      .map((r) => `${r.slug}: ${r.violations.map((v) => `[${v.level}] ${v.code} — ${v.message}`).join('; ')}`);
    expect(offenders).toEqual([]);
  });
});
