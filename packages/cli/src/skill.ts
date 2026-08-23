import { getJson, postJson, deleteJson } from './net.js';
import { bold, dim, green, red, yellow } from './color.js';

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
  antbot skill remove <slug>`;

export async function runSkillCommand(argv: string[], port: number): Promise<number> {
  const [sub, ...rest] = argv;

  if (!sub || sub === 'list') return listSkills(port);
  if (sub === 'add') return addSkill(rest, port);
  if (sub === 'remove' || sub === 'rm') return removeSkill(rest, port);

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
