import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './skills.js';

/**
 * Validation against the Agent Skills specification (`skills/SPEC.md`).
 *
 * Two things make this worth having as code rather than a review checklist. The frontmatter
 * `name` is not cosmetic — `manager.ts` passes it to the SDK as `enabledSkills`, so a name that
 * drifts from the spec (or from its directory) makes the skill silently unavailable to bots
 * rather than failing loudly. And a skill that points at `references/foo.md` files it does not
 * ship still loads fine; it just quietly instructs the model to read things that are not there.
 * Both failure modes are invisible at runtime, so they are caught here instead.
 */

export type ViolationLevel = 'error' | 'warning';

export interface SpecViolation {
  code: string;
  level: ViolationLevel;
  /** Frontmatter field or file path the violation is about, when there is one. */
  field?: string;
  message: string;
}

export interface SkillSpecInput {
  /** The skill's directory name — the spec requires `name` to match it. */
  dirName: string;
  /** Full text of SKILL.md. */
  raw: string;
  /** Every file in the skill directory, relative to it, in posix form. */
  files: string[];
}

export const SPEC_LIMITS = {
  NAME_MAX: 64,
  DESCRIPTION_MAX: 1024,
  COMPATIBILITY_MAX: 500,
  /** "Keep your main SKILL.md under 500 lines." */
  BODY_MAX_LINES: 500,
} as const;

const KNOWN_FIELDS = new Set([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
]);

/** Top-level frontmatter keys and their raw text, plus whether a `---` block was found at all. */
export function readFrontmatterFields(raw: string): { found: boolean; fields: Map<string, string> } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { found: false, fields: new Map() };
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    if (/^\s/.test(line) || line.trim() === '') continue; // nested/continuation lines
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return { found: true, fields };
}

/**
 * Relative file paths the body points at. Fenced code blocks are skipped: they are full of
 * example paths that are not meant to resolve, and flagging those trains people to ignore
 * the linter.
 */
export function extractFileReferences(body: string): string[] {
  const withoutFences = body.replace(/^```[\s\S]*?^```/gm, '');
  const out = new Set<string>();

  // Markdown links and images: [text](path) — skip URLs, anchors and absolute paths.
  for (const m of withoutFences.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = (m[1] ?? '').split('#')[0]!.trim();
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) continue;
    out.add(target);
  }
  // Bare mentions of the conventional directories, in prose or inline code:
  // `scripts/extract.py`, references/REFERENCE.md
  for (const m of withoutFences.matchAll(/(?:^|[\s`("'])((?:scripts|references|assets)\/[\w./-]+)/g)) {
    const target = (m[1] ?? '').replace(/[.,;:)`'"]+$/, '');
    if (target.endsWith('/')) continue;
    out.add(target);
  }
  return [...out];
}

/** Validate one skill against the spec. Pure — the caller supplies the file listing. */
export function validateSkill(input: SkillSpecInput): SpecViolation[] {
  const v: SpecViolation[] = [];
  const err = (code: string, message: string, field?: string): void => {
    v.push({ code, level: 'error', message, field });
  };
  const warn = (code: string, message: string, field?: string): void => {
    v.push({ code, level: 'warning', message, field });
  };

  const { found, fields } = readFrontmatterFields(input.raw);
  if (!found) {
    err('frontmatter-missing', 'SKILL.md must open with a YAML frontmatter block delimited by ---.');
    return v;
  }

  const { name, description, bodyMd } = parseFrontmatter(input.raw);

  // name
  if (!name) {
    err('name-missing', 'Frontmatter must set a non-empty `name`.', 'name');
  } else {
    if (name.length > SPEC_LIMITS.NAME_MAX) {
      err('name-too-long', `\`name\` is ${name.length} characters; the limit is ${SPEC_LIMITS.NAME_MAX}.`, 'name');
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
      err('name-charset', `\`name\` may only contain lowercase letters, digits and hyphens — got "${name}".`, 'name');
    }
    if (name.startsWith('-') || name.endsWith('-')) {
      err('name-hyphen-edge', '`name` must not start or end with a hyphen.', 'name');
    }
    if (name.includes('--')) {
      err('name-consecutive-hyphens', '`name` must not contain consecutive hyphens.', 'name');
    }
    if (name !== input.dirName) {
      // Not cosmetic: the SDK is handed frontmatter names, so a mismatch makes the skill
      // impossible to enable by its directory slug.
      err('name-dir-mismatch', `\`name\` ("${name}") must match the skill's directory name ("${input.dirName}").`, 'name');
    }
  }

  // description
  if (!description.trim()) {
    err('description-missing', 'Frontmatter must set a non-empty `description` saying what the skill does and when to use it.', 'description');
  } else if (description.length > SPEC_LIMITS.DESCRIPTION_MAX) {
    err('description-too-long', `\`description\` is ${description.length} characters; the limit is ${SPEC_LIMITS.DESCRIPTION_MAX}.`, 'description');
  }

  // compatibility
  const compatibility = fields.get('compatibility');
  if (compatibility !== undefined && compatibility.length > SPEC_LIMITS.COMPATIBILITY_MAX) {
    err('compatibility-too-long', `\`compatibility\` is ${compatibility.length} characters; the limit is ${SPEC_LIMITS.COMPATIBILITY_MAX}.`, 'compatibility');
  }

  for (const key of fields.keys()) {
    if (!KNOWN_FIELDS.has(key)) {
      // The spec defines a closed set; anything else belongs under `metadata`. A warning, not
      // an error, because an unknown key is inert rather than harmful.
      warn('unknown-field', `\`${key}\` is not a spec field — put client-specific values under \`metadata\`.`, key);
    }
  }

  // SKILL.md is loaded whole once a skill activates, so length is a context cost, not a style issue.
  const bodyLines = bodyMd.split('\n').length;
  if (bodyLines > SPEC_LIMITS.BODY_MAX_LINES) {
    warn('body-too-long', `SKILL.md body is ${bodyLines} lines; keep it under ${SPEC_LIMITS.BODY_MAX_LINES} and move detail into references/.`);
  }

  // File references
  const present = new Set(input.files.map((f) => f.split(path.sep).join('/')));
  for (const ref of extractFileReferences(bodyMd)) {
    const normalized = ref.replace(/^\.\//, '');
    if (!present.has(normalized)) {
      err('reference-missing', `SKILL.md points at "${ref}", which the skill does not ship.`, ref);
    } else if (normalized.split('/').length > 2) {
      warn('reference-too-deep', `"${ref}" is more than one level deep; keep references directly under a top-level directory.`, ref);
    }
  }

  return v;
}

/** List every file in a skill directory, relative and posix-style. */
export function listSkillFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listSkillFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Validate a skill on disk. Returns a `skill-md-missing` error if there is no SKILL.md. */
export function validateSkillDir(dir: string): SpecViolation[] {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) {
    return [{ code: 'skill-md-missing', level: 'error', message: `${dir} has no SKILL.md.` }];
  }
  return validateSkill({
    dirName: path.basename(dir),
    raw: fs.readFileSync(file, 'utf8'),
    files: listSkillFiles(dir),
  });
}

/** Validate every skill directory under `root`, skipping anything without a SKILL.md. */
export function validateSkillsIn(root: string): { slug: string; violations: SpecViolation[] }[] {
  if (!fs.existsSync(root)) return [];
  const out: { slug: string; violations: SpecViolation[] }[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    out.push({ slug: entry.name, violations: validateSkillDir(dir) });
  }
  return out;
}

/**
 * Render violations for a human reading install output. Returns '' when there are none, so
 * callers can append it unconditionally.
 */
export function formatSpecViolations(violations: SpecViolation[]): string {
  if (violations.length === 0) return '';
  const errors = violations.filter((v) => v.level === 'error').length;
  const lines = [
    '',
    errors > 0
      ? `⚠ This skill does not conform to the Agent Skills spec (${errors} error(s)):`
      : '⚠ Spec warnings for this skill:',
  ];
  for (const v of violations) {
    lines.push(`  ${v.level === 'error' ? 'error' : 'warn '} ${v.code}  ${v.message}`);
  }
  // A name that does not match its directory is the one violation that silently breaks the
  // skill at runtime, so it gets its own sentence rather than sitting in a list.
  if (violations.some((v) => v.code === 'name-dir-mismatch')) {
    lines.push('', '  Until `name` matches the directory, bots cannot actually enable this skill.');
  }
  return `${lines.join('\n')}\n`;
}
