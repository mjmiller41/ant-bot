import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Installing a skill means adding instructions that later steer a bot, and possibly
 * scripts that run with the same access as any bot command. Every source is therefore
 * resolved explicitly rather than guessed at, everything lands under the skills
 * directory, and the caller is handed a manifest of exactly what arrived.
 */

export type SkillSource =
  | { kind: 'git'; url: string; ref?: string; subdir?: string }
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string };

const SCRIPT_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.pl', '.js', '.mjs', '.cjs',
  '.ts', '.ps1', '.bat', '.cmd', '.exe', '.bin',
]);

/** A file worth warning about: it can be executed, not merely read. */
export function isExecutableFile(relPath: string, mode: number): boolean {
  if (SCRIPT_EXTENSIONS.has(path.extname(relPath).toLowerCase())) return true;
  return (mode & 0o111) !== 0;
}

export interface FileStat {
  relPath: string;
  bytes: number;
  mode: number;
}

export interface SkillManifest {
  files: FileStat[];
  executables: string[];
  totalBytes: number;
}

export function classifyFiles(files: FileStat[]): SkillManifest {
  return {
    files,
    executables: files.filter((f) => isExecutableFile(f.relPath, f.mode)).map((f) => f.relPath),
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
  };
}

const GITHUB_TREE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/;
const GITHUB_REPO = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/;
const OWNER_REPO = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/;

/**
 * Turn a user-supplied spec into an explicit source.
 *
 * Accepts: `owner/repo`, `github.com/owner/repo`, a full https/ssh git URL, a GitHub
 * `/tree/<ref>/<subdir>` link, a local path, or a direct link to a raw `SKILL.md`.
 * Anything else throws rather than being guessed at.
 */
export function parseSkillSource(rawSpec: string): SkillSource {
  const spec = rawSpec.trim();
  if (!spec) throw new Error('A skill source is required.');

  // Local paths first — an explicit path prefix is unambiguous.
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec.startsWith('~')) {
    const expanded = spec.startsWith('~') ? path.join(os.homedir(), spec.slice(1)) : spec;
    return { kind: 'path', path: expanded };
  }

  if (spec.startsWith('git@') || spec.startsWith('ssh://') || spec.endsWith('.git')) {
    const [url, ref] = splitRef(spec);
    return { kind: 'git', url, ref, subdir: undefined };
  }

  const tree = GITHUB_TREE.exec(spec);
  if (tree) {
    const [, owner, repo, ref, subdir] = tree;
    // A `/blob/<ref>/<dir>/SKILL.md` link is what GitHub's UI hands you, and it is the most
    // natural thing to paste. Point it at the containing directory: a subdir naming a file
    // finds no skill directory and would fail with a confusing "No SKILL.md found".
    const dir = subdir ? subdir.replace(/(^|\/)SKILL\.md$/i, '') : '';
    return { kind: 'git', url: `https://github.com/${owner}/${repo}`, ref, subdir: dir || undefined };
  }

  const [base, ref] = splitRef(spec);

  const repoMatch = GITHUB_REPO.exec(base);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    return { kind: 'git', url: `https://github.com/${owner}/${repo}`, ref, subdir: undefined };
  }

  if (/^https?:\/\//.test(base)) {
    if (/\/SKILL\.md$/i.test(base)) return { kind: 'url', url: base };
    throw new Error(
      `Unsupported URL: ${base}\nSupported: a git repository, or a direct link ending in /SKILL.md.`,
    );
  }

  const ownerRepo = OWNER_REPO.exec(base);
  if (ownerRepo) {
    const [, owner, repo] = ownerRepo;
    return { kind: 'git', url: `https://github.com/${owner}/${repo}`, ref, subdir: undefined };
  }

  throw new Error(
    `Could not understand skill source "${rawSpec}".\n` +
      'Try: owner/repo, github.com/owner/repo, a git URL, a local path, or a URL ending in /SKILL.md.',
  );
}

/**
 * One line describing what installing `source` would pull in, for an approval card.
 * The distinction that matters is scope: one named skill, or every skill in a repository.
 * Never throws — an unparseable source is described verbatim so the card still renders.
 */
export function describeSkillSource(rawSpec: string): string {
  let parsed: SkillSource;
  try {
    parsed = parseSkillSource(rawSpec);
  } catch {
    return `Install skill from ${rawSpec}`;
  }
  const where = (u: string): string => u.replace(/^https?:\/\//, '');
  switch (parsed.kind) {
    case 'url':
      return `Install one skill from ${where(parsed.url)}`;
    case 'path':
      return `Install skill(s) from the local path ${parsed.path}`;
    case 'git': {
      const ref = parsed.ref ? `#${parsed.ref}` : '';
      return parsed.subdir
        ? `Install "${parsed.subdir}" from ${where(parsed.url)}${ref}`
        : `Install EVERY skill in ${where(parsed.url)}${ref} (whole repository)`;
    }
  }
}

function splitRef(spec: string): [string, string | undefined] {
  const hash = spec.lastIndexOf('#');
  if (hash === -1) return [spec, undefined];
  return [spec.slice(0, hash), spec.slice(hash + 1) || undefined];
}

/* ------------------------------- filesystem helpers ------------------------------- */

/** Every file under `root`, relative-pathed, skipping VCS metadata. */
export function walkFiles(root: string, rel = ''): FileStat[] {
  const out: FileStat[] = [];
  const dir = path.join(root, rel);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    const full = path.join(root, childRel);
    if (entry.isSymbolicLink()) continue; // never follow links out of the tree
    if (entry.isDirectory()) out.push(...walkFiles(root, childRel));
    else if (entry.isFile()) {
      const st = fs.statSync(full);
      out.push({ relPath: childRel, bytes: st.size, mode: st.mode });
    }
  }
  return out;
}

/** Directories containing a SKILL.md, anywhere under `root`. A repo may hold many. */
export function findSkillDirs(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) {
      found.push(dir);
      return; // a skill directory owns its whole subtree
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return found.sort();
}

export function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

export function runGit(args: string[], cwd?: string, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`git is required to install from a repository: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

/* ---------------------------------- staging ---------------------------------- */

import { parseFrontmatter } from './skills.js';

export interface StagedSkill {
  /** Name from the SKILL.md frontmatter — what the SDK's Skill tool matches on. */
  name: string;
  description: string;
  /** Directory holding SKILL.md and any supporting files, ready to copy in. */
  dir: string;
  manifest: SkillManifest;
}

/** Hard cap so a mis-typed source cannot fill the disk. */
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;

function readStaged(dir: string): StagedSkill {
  const file = path.join(dir, 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  const { name, description } = parseFrontmatter(raw);
  if (!name.trim()) {
    throw new Error(
      `${file} has no \`name\` in its frontmatter. A skill needs:\n---\nname: my-skill\ndescription: what it does\n---`,
    );
  }
  const manifest = classifyFiles(walkFiles(dir));
  if (manifest.totalBytes > MAX_SKILL_BYTES) {
    throw new Error(
      `Skill "${name}" is ${(manifest.totalBytes / 1048576).toFixed(1)} MB; the limit is ${MAX_SKILL_BYTES / 1048576} MB.`,
    );
  }
  return { name: name.trim(), description: description.trim(), dir, manifest };
}

/** Collect every skill under a local path. Accepts a skill dir, a SKILL.md, or a pack of skills. */
export async function stageFromPath(source: { kind: 'path'; path: string }): Promise<StagedSkill[]> {
  const target = path.resolve(source.path);
  if (!fs.existsSync(target)) throw new Error(`Path not found: ${target}`);

  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (path.basename(target).toLowerCase() !== 'skill.md')
      throw new Error(`Expected a directory or a SKILL.md file, got ${target}`);
    return [readStaged(path.dirname(target))];
  }

  const dirs = findSkillDirs(target);
  if (!dirs.length) throw new Error(`No SKILL.md found under ${target}`);
  return dirs.map(readStaged);
}

/** Clone a repo shallowly into a temp dir and stage the skills inside it. */
export async function stageFromGit(
  source: { kind: 'git'; url: string; ref?: string; subdir?: string },
  tmpRoot = os.tmpdir(),
): Promise<{ staged: StagedSkill[]; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'antbot-skill-git-'));
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const args = ['clone', '--depth', '1', '--quiet'];
    if (source.ref) args.push('--branch', source.ref);
    args.push(source.url, dir);
    await runGit(args);

    const root = source.subdir ? path.join(dir, source.subdir) : dir;
    if (!fs.existsSync(root)) throw new Error(`"${source.subdir}" does not exist in ${source.url}`);

    const dirs = findSkillDirs(root);
    if (!dirs.length) throw new Error(`No SKILL.md found in ${source.url}${source.subdir ? `/${source.subdir}` : ''}`);
    return { staged: dirs.map(readStaged), cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Fetch a single raw SKILL.md into a temp dir. */
export async function stageFromUrl(
  source: { kind: 'url'; url: string },
  tmpRoot = os.tmpdir(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ staged: StagedSkill[]; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'antbot-skill-url-'));
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const res = await fetchImpl(source.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Fetching ${source.url} failed: HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_SKILL_BYTES) throw new Error(`${source.url} is larger than the ${MAX_SKILL_BYTES / 1048576} MB limit.`);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
    return { staged: [readStaged(dir)], cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Resolve any source to staged skills plus a cleanup for whatever temp state it created. */
export async function stage(source: SkillSource): Promise<{ staged: StagedSkill[]; cleanup: () => void }> {
  if (source.kind === 'path') return { staged: await stageFromPath(source), cleanup: () => {} };
  if (source.kind === 'git') return stageFromGit(source);
  return stageFromUrl(source);
}

/** Human-readable summary of what an install put on disk. */
export function renderManifest(skill: StagedSkill, installedAt: string): string {
  const lines = [`✓ Installed '${skill.name}'`, ''];
  const width = Math.max(...skill.manifest.files.map((f) => f.relPath.length), 10);
  for (const f of [...skill.manifest.files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const size = f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`;
    const flag = isExecutableFile(f.relPath, f.mode) ? '   ⚠ executable' : '';
    lines.push(`  ${f.relPath.padEnd(width)}  ${size.padStart(8)}${flag}`);
  }
  if (skill.manifest.executables.length) {
    const n = skill.manifest.executables.length;
    lines.push(
      '',
      `⚠ This skill ships ${n} ${n === 1 ? 'script' : 'scripts'}. Scripts run with the same access`,
      '  as any bot command. Review before assigning:',
      `  ${installedAt}`,
    );
  }
  return lines.join('\n');
}
