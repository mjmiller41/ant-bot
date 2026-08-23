import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AutoReviewer } from './gateway.js';
import { buildEnv } from '../agent/session.js';
import type { Settings } from '@antbot/shared';
import { logger } from '../util/log.js';
import { summarize } from './gateway.js';

const log = logger('autoreview');

const SYSTEM = `You are the automated action reviewer for a local AI-teammate system.
You judge ONE proposed tool call and answer with a single JSON object.

Answer "allow_ok" only when the action is clearly routine, reversible and
low-consequence — reading files, inspecting state, searching, navigating to a
normal public page, writing inside the bot's own workspace.

Answer "needs_human" when the action is consequential or ambiguous: sending or
publishing anything, contacting a person, spending money, changing permissions,
touching production, deleting or overwriting data outside the workspace,
installing software, or anything whose blast radius you cannot determine.

Answer "deny_suggested" when the action looks actively unsafe or like an attempt
to exfiltrate credentials.

You are advisory only and you are NOT the last line of defence. When in doubt,
choose needs_human.

Reply with ONLY: {"verdict":"allow_ok|needs_human|deny_suggested","reason":"<12 words max>"}`;

/** Haiku-backed reviewer. Advisory: it can never green-light past a `require` rule. */
export class HaikuAutoReviewer implements AutoReviewer {
  constructor(
    private getSettings: () => Settings,
    private cwd: string,
  ) {}

  async classify(toolName: string, input: unknown, botDescription: string) {
    const prompt = `Bot's standing job description:
${botDescription.slice(0, 800) || '(none)'}

Proposed tool call:
tool: ${toolName}
summary: ${summarize(toolName, input)}
raw input: ${JSON.stringify(input).slice(0, 1500)}`;

    const q = query({
      prompt,
      options: {
        model: 'haiku',
        systemPrompt: SYSTEM,
        cwd: this.cwd,
        settingSources: [],
        env: buildEnv(this.getSettings()),
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'default',
      },
    });

    let out = '';
    for await (const m of q) {
      const msg = m as Record<string, any>;
      if (msg.type === 'result' && typeof msg.result === 'string') out = msg.result;
    }
    return parseVerdict(out);
  }
}

export function parseVerdict(text: string): { verdict: 'allow_ok' | 'needs_human' | 'deny_suggested'; reason: string } {
  const fallback = { verdict: 'needs_human' as const, reason: 'Reviewer output was unreadable' };
  if (!text) return fallback;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const o = JSON.parse(match[0]) as { verdict?: string; reason?: string };
    if (o.verdict === 'allow_ok' || o.verdict === 'needs_human' || o.verdict === 'deny_suggested')
      return { verdict: o.verdict, reason: String(o.reason ?? '').slice(0, 200) };
    return fallback;
  } catch {
    return fallback;
  }
}

/** Deterministic reviewer used in tests and when auto review is disabled. */
export class NullAutoReviewer implements AutoReviewer {
  async classify() {
    return { verdict: 'needs_human' as const, reason: 'Auto review disabled' };
  }
}

export function makeAutoReviewer(getSettings: () => Settings, cwd: string): AutoReviewer {
  try {
    return new HaikuAutoReviewer(getSettings, cwd);
  } catch (err) {
    log.warn('falling back to null reviewer', err);
    return new NullAutoReviewer();
  }
}
