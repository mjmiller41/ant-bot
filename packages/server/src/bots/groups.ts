import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildEnv } from '../agent/session.js';
import type { Settings, Bot } from '@antbot/shared';
import { logger } from '../util/log.js';

const log = logger('groups');

/**
 * Pick which bots should answer a group message.
 * Explicit @-mentions always win; otherwise a cheap Haiku pass routes it.
 * Falls back to the first member so a group is never silent.
 */
export async function routeGroupMessage(args: {
  text: string;
  members: Bot[];
  mentionBotIds?: string[];
  mentionEveryone?: boolean;
  settings: Settings;
  cwd: string;
}): Promise<Bot[]> {
  const { text, members, mentionBotIds, mentionEveryone, settings, cwd } = args;
  if (mentionEveryone) return members;
  if (mentionBotIds?.length) {
    const picked = members.filter((m) => mentionBotIds.includes(m.id));
    if (picked.length) return picked;
  }

  const inline = members.filter((m) => new RegExp(`@${m.slug}\\b`, 'i').test(text));
  if (inline.length) return inline;

  try {
    const roster = members.map((m) => `- ${m.slug}: ${m.name}${m.title ? `, ${m.title}` : ''}. ${m.description.slice(0, 200)}`).join('\n');
    const q = query({
      prompt: `Team:\n${roster}\n\nMessage:\n${text.slice(0, 2000)}\n\nWhich single teammate should own this? Reply with only the slug.`,
      options: {
        model: 'haiku',
        systemPrompt: 'You route work to the right teammate. Reply with exactly one slug from the list and nothing else.',
        cwd, settingSources: [], env: buildEnv(settings), maxTurns: 1, allowedTools: [],
      },
    });
    let out = '';
    for await (const m of q) {
      const msg = m as Record<string, any>;
      if (msg.type === 'result' && typeof msg.result === 'string') out = msg.result;
    }
    const slug = out.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    const found = members.find((m) => m.slug === slug);
    if (found) return [found];
  } catch (err) {
    log.warn('group router failed; defaulting to first member', err);
  }
  return members.slice(0, 1);
}

/** Extract @slug mentions from raw composer text. */
export function parseMentions(text: string, members: Bot[]): { botIds: string[]; everyone: boolean } {
  const everyone = /@everyone\b/i.test(text);
  const botIds = members.filter((m) => new RegExp(`@${m.slug}\\b`, 'i').test(text)).map((m) => m.id);
  return { botIds, everyone };
}
