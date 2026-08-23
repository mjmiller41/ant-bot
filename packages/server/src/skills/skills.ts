import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../db/store.js';
import { slugify } from '../util/ids.js';
import type { Skill } from '@antbot/shared';

/**
 * A skill is a directory `<skillsDir>/<slug>/SKILL.md` with a YAML-ish frontmatter block
 * (name, description) followed by a markdown body in the 6-part shape from outline §8:
 * when to use it, required inputs and access, sequence of work, how to validate the result,
 * what to return, what requires approval.
 */

export const SKILL_TEMPLATE = `## When to use it

Describe the trigger: what request or situation should make a bot reach for this skill instead
of improvising. Be specific enough that a bot with this skill enabled recognizes the moment.

## Required inputs and access

List what the skill needs before it can run: source systems, connectors/MCP servers, files,
credentials, or information the user must supply. Say what happens if something required is
missing.

## Sequence of work

Write the ordered steps the bot should follow. Prefer "gather → draft/reconcile → recommend"
over "act immediately" — automate preparation before execution.

## How to validate the result

State how the bot should check its own output before returning it: what to cross-check, what
counts as "current" data, and what stale-data policy applies. Per outline §8: **if the source
data is unavailable, report the failure instead of using old data.**

## What to return

Describe the shape of the deliverable: a document, a spreadsheet, a draft message, a linked
watch list, or a recommendation with evidence. Separate facts found, assumptions, actions
already taken, actions waiting for approval, and open questions where relevant.

## What requires approval

Name the actions this skill must never take without an explicit human "go ahead": sending,
publishing, purchasing, deleting, overwriting, or any production change. This section should
never be empty — every skill has an approval boundary.
`;

export interface WriteSkillInput {
  name: string;
  description?: string;
  bodyMd: string;
  source?: 'user' | 'taught' | 'imported';
}

export interface InstalledSkill {
  skill: Skill;
  executables: string[];
  manifestText: string;
  replaced: boolean;
}

export interface ParsedSkillFile {
  name: string;
  description: string;
  bodyMd: string;
}

/** Parse the `---\nname: "..."\ndescription: "..."\n---\n<body>` shape. Pure, no I/O. */
export function parseFrontmatter(md: string): ParsedSkillFile {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', bodyMd: md };
  const [, fm, rest] = m;
  const data: Record<string, string> = {};
  const lines = (fm ?? '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const idx = line.indexOf(':');
    if (idx === -1 || /^\s/.test(line)) continue; // continuation lines are consumed below
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    // YAML block scalars: `>` folds newlines into spaces, `|` keeps them. Published
    // skills use both for long descriptions, and the description is what the model
    // matches on — dropping it to a bare ">" makes the skill invisible.
    const block = /^([>|])([-+]?)$/.exec(value);
    if (block) {
      const folded = block[1] === '>';
      const collected: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() !== '' && !/^\s/.test(next)) break; // next top-level key
        collected.push(next.trim());
        i++;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      value = folded
        ? collected.filter((l) => l !== '').join(' ')
        : collected.join('\n');
      // A folded block separates paragraphs (blank lines) with a newline.
      if (folded && collected.includes('')) {
        value = collected
          .reduce<string[]>((acc, l) => {
            if (l === '') acc.push('');
            else if (acc.length && acc[acc.length - 1] !== '') acc[acc.length - 1] += ` ${l}`;
            else acc[acc.length - 1] = l;
            return acc;
          }, [''])
          .filter((para) => para !== '')
          .join('\n');
      }
      data[key] = value;
      continue;
    }

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    data[key] = value;
  }
  return {
    name: data.name ?? '',
    description: data.description ?? '',
    bodyMd: (rest ?? '').replace(/^\r?\n/, ''),
  };
}

/** Render a SKILL.md file from its parts. Pure, no I/O. */
export function renderSkillFile(input: { name: string; description: string; bodyMd: string }): string {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `---\nname: "${esc(input.name)}"\ndescription: "${esc(input.description)}"\n---\n\n${input.bodyMd.trim()}\n`;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Default location of the bundled starter skills, resolved relative to this module. */
function defaultExamplesDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/server/src/skills -> repo root -> skills-examples
  return path.join(here, '../../../../skills-examples');
}

/**
 * Copy the bundled starter skills into `targetDir` if it doesn't already contain any skill
 * directories. Safe to call on every boot: it is a no-op once anything has been seeded/written.
 */
export function seedExamples(targetDir: string, examplesDir: string = defaultExamplesDir()): void {
  fs.mkdirSync(targetDir, { recursive: true });
  const hasAny = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .some((e) => e.isDirectory());
  if (hasAny) return;
  if (!fs.existsSync(examplesDir)) return;
  for (const entry of fs.readdirSync(examplesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    copyDirRecursive(path.join(examplesDir, entry.name), path.join(targetDir, entry.name));
  }
}

/** Skills committed to the ant-bot project itself: `<repo>/skills/<slug>/SKILL.md`. */
function defaultProjectSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/server/{src,dist}/skills -> repo root -> skills
  return path.join(here, '../../../../skills');
}

/**
 * Copy skills that live in the ant-bot project into the installed skills directory, so a
 * skill can be version-controlled alongside the code that uses it. Runs on every boot and
 * refreshes in place, which makes the project directory the source of truth for anything
 * it contains — edit the file in the repo, restart, and the change is live.
 */
export function syncProjectSkills(
  targetDir: string,
  projectDir: string = defaultProjectSkillsDir(),
): string[] {
  if (!fs.existsSync(projectDir)) return [];
  fs.mkdirSync(targetDir, { recursive: true });
  const synced: string[] = [];
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(projectDir, entry.name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    const dest = path.join(targetDir, entry.name);
    fs.rmSync(dest, { recursive: true, force: true });
    copyDirRecursive(src, dest);
    synced.push(entry.name);
  }
  return synced;
}

/**
 * Raised when a source resolves to more than one skill and the caller did not opt in.
 * Carries the names so the caller can tell the human (or the model) what to narrow to.
 */
export class MultipleSkillsError extends Error {
  constructor(
    readonly source: string,
    readonly names: string[],
  ) {
    super(`"${source}" contains ${names.length} skills, not one.`);
    this.name = 'MultipleSkillsError';
  }
}

export class SkillStore {
  constructor(
    private store: Store,
    private skillsDir: string,
  ) {}

  private slugDir(slug: string): string {
    return path.join(this.skillsDir, slug);
  }

  /** Resolve a stored skill path and assert it is inside the skills dir (no path traversal). */
  private assertInsideSkillsDir(candidate: string): string {
    const root = path.resolve(this.skillsDir) + path.sep;
    const resolved = path.resolve(candidate);
    if (resolved !== path.resolve(this.skillsDir) && !resolved.startsWith(root)) {
      throw new Error(`Refusing to touch a skill path outside the skills directory: ${candidate}`);
    }
    return resolved;
  }

  /** Create (or overwrite by slug) a skill directory + SKILL.md, and register it. */
  writeSkill(input: WriteSkillInput): Skill {
    const existing = new Set(this.store.listSkills().map((s) => s.slug));
    const slug = slugify(input.name, existing);
    const dir = this.assertInsideSkillsDir(this.slugDir(slug));
    fs.mkdirSync(dir, { recursive: true });
    const content = renderSkillFile({
      name: input.name,
      description: input.description ?? '',
      bodyMd: input.bodyMd,
    });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    return this.store.createSkill({
      slug,
      name: input.name,
      description: input.description,
      path: dir,
      source: input.source,
    });
  }

  /**
   * Install every skill found at `source` and register it. Existing slugs are replaced in
   * place so re-installing upgrades rather than accumulating copies.
   *
   * Throws `MultipleSkillsError` if `source` holds more than one skill unless
   * `allowMultiple` is set, so a caller cannot install a hundred skills by accident.
   */
  async installFromSource(
    source: string,
    opts: { allowMultiple?: boolean } = {},
  ): Promise<InstalledSkill[]> {
    const { stage, copyTree, renderManifest } = await import('./install.js');
    const parsed = (await import('./install.js')).parseSkillSource(source);
    const { staged, cleanup } = await stage(parsed);
    try {
      // Installing a whole monorepo when one skill was wanted is easy to do by accident and
      // tedious to undo, so a multi-skill source has to be asked for explicitly.
      if (staged.length > 1 && !opts.allowMultiple) {
        throw new MultipleSkillsError(source, staged.map((sk) => sk.name));
      }
      const out: InstalledSkill[] = [];
      for (const skill of staged) {
        const existing = this.store.getSkillBySlug(slugify(skill.name, new Set()));
        const others = new Set(this.store.listSkills().map((x) => x.slug));
        if (existing) others.delete(existing.slug);
        const slug = existing?.slug ?? slugify(skill.name, others);

        const dir = this.assertInsideSkillsDir(this.slugDir(slug));
        fs.rmSync(dir, { recursive: true, force: true });
        copyTree(skill.dir, dir);

        const registered = existing
          ? (this.store.updateSkill?.(existing.id, { name: skill.name, description: skill.description }) ?? existing)
          : this.store.createSkill({
              slug, name: skill.name, description: skill.description, path: dir, source: 'imported',
            });

        out.push({
          skill: registered,
          executables: skill.manifest.executables,
          manifestText: renderManifest(skill, dir),
          replaced: Boolean(existing),
        });
      }
      return out;
    } finally {
      cleanup();
    }
  }

  /** Read a skill's SKILL.md and return it with the parsed body (frontmatter stripped). */
  readSkill(id: string): (Skill & { bodyMd: string }) | null {
    const skill = this.store.getSkill(id);
    if (!skill) return null;
    const file = path.join(skill.path, 'SKILL.md');
    if (!fs.existsSync(file)) return { ...skill, bodyMd: '' };
    const raw = fs.readFileSync(file, 'utf8');
    const { bodyMd } = parseFrontmatter(raw);
    return { ...skill, bodyMd };
  }

  /** Remove a skill's directory and its db row. Guards against a maliciously escaped path. */
  deleteSkill(id: string): void {
    const skill = this.store.getSkill(id);
    if (!skill) return;
    const resolved = this.assertInsideSkillsDir(skill.path);
    fs.rmSync(resolved, { recursive: true, force: true });
    this.store.deleteSkill(id);
  }

  /**
   * Bring the registry back in line with what is actually on disk.
   *
   * A row can outlive its directory — a skill removed by hand, or a layout migration that
   * moved files without rewriting paths — and the UI then lists skills that cannot load.
   * Rows whose directory moved are repaired in place so bot assignments survive; rows with
   * nothing left on disk are dropped. Returns what it did, for the boot log.
   */
  reconcile(): { repaired: string[]; removed: string[] } {
    const repaired: string[] = [];
    const removed: string[] = [];
    for (const skill of this.store.listSkills()) {
      if (fs.existsSync(path.join(skill.path, 'SKILL.md'))) continue;
      const expected = path.join(this.skillsDir, skill.slug);
      if (fs.existsSync(path.join(expected, 'SKILL.md'))) {
        this.store.updateSkill(skill.id, { path: expected });
        repaired.push(skill.slug);
      } else {
        this.store.deleteSkill(skill.id);
        removed.push(skill.slug);
      }
    }
    return { repaired, removed };
  }

  /**
   * Scan the skills dir at boot and register any SKILL.md not yet known to the db, so users
   * can drop skills in by hand. Idempotent: already-registered slugs are left untouched.
   */
  syncFromDisk(): Skill[] {
    if (!fs.existsSync(this.skillsDir)) return [];
    const added: Skill[] = [];
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const dir = path.join(this.skillsDir, slug);
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      if (this.store.getSkillBySlug(slug)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const { name, description } = parseFrontmatter(raw);
      const skill = this.store.createSkill({
        slug,
        name: name || slug,
        description,
        path: dir,
        source: 'imported',
      });
      added.push(skill);
    }
    return added;
  }
}
