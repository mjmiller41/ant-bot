import fs from 'node:fs';
import path from 'node:path';

/**
 * The skills directory is exposed to the agent SDK as a **local plugin**, which is what
 * gives bots the real `Skill` tool (discovery, progressive disclosure, per-session
 * filtering) instead of a list of paths they have to read by hand.
 *
 * A local plugin is a directory containing `.claude-plugin/plugin.json` and a `skills/`
 * subdirectory, so the layout is:
 *
 *   <root>/.claude-plugin/plugin.json     generated, refreshed each boot
 *   <root>/skills/<slug>/SKILL.md         the skills themselves
 */

export const PLUGIN_NAME = 'antbot';

/** Where individual skill directories live inside the plugin root. */
export function skillFilesDir(pluginRoot: string): string {
  return path.join(pluginRoot, 'skills');
}

export function ensureSkillPlugin(pluginRoot: string): string {
  const manifestDir = path.join(pluginRoot, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(skillFilesDir(pluginRoot), { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    `${JSON.stringify(
      {
        name: PLUGIN_NAME,
        description: 'Skills installed into ant-bot and available to its bots.',
        version: '1.0.0',
      },
      null,
      2,
    )}\n`,
  );
  return pluginRoot;
}

/**
 * Pre-plugin installs kept skills at `<root>/<slug>/SKILL.md`. Move them under
 * `<root>/skills/` so the plugin loader can see them. Idempotent; never overwrites a
 * skill already present at the destination.
 */
export function migrateLegacyLayout(pluginRoot: string): string[] {
  if (!fs.existsSync(pluginRoot)) return [];
  const dest = skillFilesDir(pluginRoot);
  const moved: string[] = [];

  for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'skills' || entry.name === '.claude-plugin') continue;
    const from = path.join(pluginRoot, entry.name);
    if (!fs.existsSync(path.join(from, 'SKILL.md'))) continue;

    const to = path.join(dest, entry.name);
    if (fs.existsSync(to)) continue; // destination wins; leave the stale copy in place
    fs.mkdirSync(dest, { recursive: true });
    fs.renameSync(from, to);
    moved.push(entry.name);
  }
  return moved;
}
