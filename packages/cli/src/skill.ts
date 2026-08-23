import fs from 'node:fs';
import path from 'node:path';
import { getJson, postJson, deleteJson } from './net.js';
import { bold, dim, green, red, yellow } from './color.js';
import { importSkillSpec, type SpecViolation } from './serverBridge.js';
import { loadPaths } from './daemon.js';

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: string;
}

interface InstallResponse {
  installed: Array<{ skill: SkillRow; executables: string[]; manifest: string; replaced: boolean }>;
}

const USAGE = `Usage:
  antbot skill list
  antbot skill add <source>
  antbot skill remove <slug>
  antbot skill lint [path]`;

export async function runSkillCommand(argv: string[], port: number): Promise<number> {
  const [sub, ...rest] = argv;

  if (!sub || sub === 'list') return listSkills(port);
  if (sub === 'add') return addSkill(rest, port);
  if (sub === 'remove' || sub === 'rm') return removeSkill(rest, port);
  if (sub === 'lint' || sub === 'check') return lintSkills(rest);

  console.error(red(`Unknown subcommand "${sub}".\n${USAGE}`));
  return 2;
}

function notRunning(err: unknown): number {
  console.error(red(`Could not reach the antbot daemon: ${(err as Error).message}`));
  console.error(dim('Start it with `antbot start`.'));
  return 1;
}

async function listSkills(port: number): Promise<number> {
  let skills: SkillRow[];
  try {
    skills = await getJson<SkillRow[]>(port, '/api/skills');
  } catch (err) {
    return notRunning(err);
  }
  if (!skills.length) {
    console.log('No skills installed. Add one with `antbot skill add <source>`.');
    return 0;
  }
  const width = Math.max(...skills.map((s) => s.slug.length));
  for (const s of skills) {
    console.log(`${bold(s.slug.padEnd(width))}  ${s.description || s.name}`);
  }
  console.log('');
  console.log(dim(`${skills.length} skill(s). Assign them to a bot in Bot settings → Skills.`));
  return 0;
}

async function addSkill(args: string[], port: number): Promise<number> {
  const source = args[0];
  if (!source) {
    console.error(red(`A source is required.\n${USAGE}`));
    return 2;
  }
  let res: InstallResponse;
  try {
    res = await postJson<InstallResponse>(port, '/api/skills/install', { source });
  } catch (err) {
    const message = (err as Error).message;
    if (/ECONNREFUSED|not reach/i.test(message)) return notRunning(err);
    console.error(red(message));
    return 1;
  }

  for (const item of res.installed) {
    console.log(item.manifest.replace(/^✓ Installed/, green('✓ Installed')));
    if (item.replaced) console.log(dim('  (upgraded in place; existing bot assignments kept)'));
    console.log('');
  }
  const names = res.installed.map((i) => i.skill.slug).join(', ');
  console.log(dim(`Assign to a bot in Bot settings → Skills: ${names}`));
  return 0;
}

async function removeSkill(args: string[], port: number): Promise<number> {
  const slug = args[0];
  if (!slug) {
    console.error(red(`A slug is required.\n${USAGE}`));
    return 2;
  }
  let skills: SkillRow[];
  try {
    skills = await getJson<SkillRow[]>(port, '/api/skills');
  } catch (err) {
    return notRunning(err);
  }
  const match = skills.find((s) => s.slug === slug || s.name === slug);
  if (!match) {
    console.error(red(`No skill named "${slug}".`));
    console.error(dim(`Installed: ${skills.map((s) => s.slug).join(', ') || '(none)'}`));
    return 1;
  }
  try {
    await deleteJson(port, `/api/skills/${match.id}`);
  } catch (err) {
    return notRunning(err);
  }
  console.log(green(`✓ Removed '${match.slug}'`));
  console.log(dim(yellow('Bots that had it assigned no longer have it.')));
  return 0;
}

/**
 * `antbot skill lint [path]` — check skills against the Agent Skills spec (skills/SPEC.md).
 *
 * Deliberately does not go through the daemon: the most useful moment to run this is on a
 * skill directory you are still writing, before anything is installed anywhere.
 */
async function lintSkills(args: string[]): Promise<number> {
  const target = args[0];
  let spec: Awaited<ReturnType<typeof importSkillSpec>>;
  try {
    spec = await importSkillSpec();
  } catch (err) {
    console.error(red(`Could not load the skill validator: ${(err as Error).message}`));
    return 1;
  }

  let results: { slug: string; violations: SpecViolation[] }[];
  let scanned: string;

  if (target) {
    const dir = path.resolve(target);
    if (!fs.existsSync(dir)) {
      console.error(red(`No such directory: ${dir}`));
      return 2;
    }
    scanned = dir;
    // A path can be one skill or a directory of them; treating a SKILL.md as the signal
    // means `antbot skill lint .` works from inside a skill you are writing.
    results = fs.existsSync(path.join(dir, 'SKILL.md'))
      ? [{ slug: path.basename(dir), violations: spec.validateSkillDir(dir) }]
      : spec.validateSkillsIn(dir);
  } else {
    scanned = path.join(loadPaths().skills, 'skills');
    results = spec.validateSkillsIn(scanned);
  }

  if (results.length === 0) {
    console.log(`No skills found in ${scanned}.`);
    return 0;
  }

  let errors = 0;
  let warnings = 0;
  const width = Math.max(...results.map((r) => r.slug.length));
  for (const { slug, violations } of results) {
    if (violations.length === 0) {
      console.log(`${green('✓')} ${bold(slug.padEnd(width))}  ${dim('conforms to the spec')}`);
      continue;
    }
    const worst = violations.some((v) => v.level === 'error') ? red('✗') : yellow('⚠');
    console.log(`${worst} ${bold(slug.padEnd(width))}`);
    for (const v of violations) {
      if (v.level === 'error') errors++;
      else warnings++;
      const tag = v.level === 'error' ? red('error') : yellow('warn ');
      console.log(`   ${tag} ${dim(v.code)}  ${v.message}`);
    }
  }

  console.log('');
  if (errors > 0) {
    console.log(red(`${errors} error(s), ${warnings} warning(s) across ${results.length} skill(s).`));
    console.log(dim('See skills/SPEC.md, or the skill-author skill, for how to fix each one.'));
    return 1;
  }
  if (warnings > 0) {
    console.log(yellow(`${warnings} warning(s) across ${results.length} skill(s).`));
    return 0;
  }
  console.log(green(`All ${results.length} skill(s) conform to the spec.`));
  return 0;
}
