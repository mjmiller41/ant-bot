import path from 'node:path';
import fs from 'node:fs';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Store } from '../db/store.js';
import type { EventBus } from '../util/bus.js';
import type { PermissionGateway } from '../permissions/gateway.js';
import type { MountedConnector } from '../agent/runtime.js';
import { runTurn, type TurnEvent } from '../agent/session.js';
import { buildSystemPrompt } from './prompt.js';
import { ensureMemoryDir } from '../memory/memory.js';
import { logger } from '../util/log.js';
import { LIMITS, type Bot, type Card, type TurnOrigin, type Settings } from '@antbot/contract';
import { newId } from '../util/ids.js';
import { describeSkillSource } from '../skills/install.js';

const log = logger('bots');

export interface TurnJob {
  id: string;
  botId: string;
  threadId: string;
  prompt: string;
  origin: TurnOrigin;
  hops: number;
  /** Priority: interactive turns run before routine turns (plan §9). */
  priority: number;
  onDone?: (summary: string, ok: boolean) => void;
}

export interface ManagerDeps {
  store: Store;
  bus: EventBus;
  gateway: PermissionGateway;
  workspace: string;
  getSettings: () => Settings;
  /**
   * Root of the local plugin carrying installed skills. A resolver rather than a value
   * because the skills subsystem is wired after the manager is constructed.
   */
  skillPluginPath?: () => string | undefined;
  /** Install a skill from a user-supplied source. Gated by the `install_skill` require-rule. */
  installSkill?: (
    source: string,
    opts?: { allowMultiple?: boolean },
  ) => Promise<Array<{ name: string; executables: string[] }>>;
  /** Every installed skill, so a bot can check before installing or removing. */
  listSkills?: () => Array<{ slug: string; name: string; description: string }>;
  /** Uninstall by slug. Gated by the `remove_skill` require-rule. */
  removeSkill?: (slug: string) => Promise<{ removed: boolean; name?: string }>;
  browserTools?: (botId: string) => ReturnType<typeof createSdkMcpServer> | undefined;
  /**
   * MCP connectors assigned to this bot, resolved and ready to mount. Async because mounting
   * reads secrets from the keychain; returns what it could mount plus what to tell the model
   * about, so a connector skipped for a missing credential simply is not there this turn.
   */
  connectorServers?: (botId: string) => Promise<{
    servers: Record<string, MountedConnector>;
    mounted: { name: string; description: string }[];
  }>;
}

export class BotManager {
  private queue: TurnJob[] = [];
  private running = new Map<string, { job: TurnJob; abort: AbortController }>();
  private draining = false;

  constructor(private deps: ManagerDeps) {}

  get runningCount(): number {
    return this.running.size;
  }
  get queuedCount(): number {
    return this.queue.length;
  }
  isBusy(botId: string): boolean {
    return this.running.has(botId) || this.queue.some((j) => j.botId === botId);
  }

  /** Enqueue a turn. Interactive work sorts ahead of routine work. */
  enqueue(job: Omit<TurnJob, 'id' | 'priority'> & { priority?: number }): TurnJob {
    const full: TurnJob = {
      ...job,
      id: newId(),
      priority: job.priority ?? (job.origin === 'routine' ? 10 : 0),
    };
    this.queue.push(full);
    this.queue.sort((a, b) => a.priority - b.priority);
    this.setState(full.botId, 'queued');
    void this.drain();
    return full;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const max = this.deps.getSettings().maxConcurrentSessions ?? LIMITS.DEFAULT_MAX_CONCURRENT_SESSIONS;
      while (this.queue.length && this.running.size < max) {
        const idx = this.queue.findIndex((j) => !this.running.has(j.botId));
        if (idx === -1) break;
        const [job] = this.queue.splice(idx, 1);
        void this.execute(job!);
      }
    } finally {
      this.draining = false;
    }
  }

  private setState(botId: string, state: Bot['state'], attention?: Bot['attention']): void {
    const bot = this.deps.store.updateBot(botId, { state, ...(attention ? { attention } : {}) });
    if (!bot) return;
    this.deps.bus.publish({
      type: 'bot.state', botId, threadId: bot.threadId, state: bot.state, attention: bot.attention,
    });
  }

  interrupt(botId: string): boolean {
    const r = this.running.get(botId);
    this.queue = this.queue.filter((j) => j.botId !== botId);
    this.deps.gateway.cancelForBot(botId);
    if (!r) {
      this.setState(botId, 'idle');
      return false;
    }
    r.abort.abort();
    return true;
  }

  /** Custom tools exposed to every bot turn: handoff, memory, secrets-safe helpers. */
  private buildToolServer(bot: Bot, threadId: string, hops: number) {
    const { store, workspace } = this.deps;
    return createSdkMcpServer({
      name: 'antbot',
      version: '1.0.0',
      tools: [
        tool(
          'send_to_bot',
          'Hand work to another bot on this account. The recipient wakes, handles the request in its own thread, and can reply later. Use when the job genuinely belongs to that role.',
          { bot_slug: z.string().describe('slug of the teammate, e.g. "writer"'), message: z.string().describe('the request, with all context they need') },
          async (args: { bot_slug: string; message: string }) => {
            const target = store.getBotBySlug(args.bot_slug);
            if (!target) return { content: [{ type: 'text' as const, text: `No bot with slug "${args.bot_slug}". Use one of: ${store.listBots().map((b) => b.slug).join(', ')}` }] };
            if (target.id === bot.id) return { content: [{ type: 'text' as const, text: 'You cannot hand work to yourthis.' }] };
            if (hops + 1 > LIMITS.MAX_BOT_TO_BOT_HOPS)
              return { content: [{ type: 'text' as const, text: `Hop limit of ${LIMITS.MAX_BOT_TO_BOT_HOPS} reached. Stop and report back to the human instead.` }] };
            store.createMail({ fromBotId: bot.id, toBotId: target.id, contentMd: args.message, hops: hops + 1 });
            this.postSystemCard(threadId, bot.id, { type: 'handoff', fromBotId: bot.id, toBotId: target.id, note: args.message.slice(0, 300) });
            this.enqueue({
              botId: target.id, threadId: target.threadId!, origin: 'bot', hops: hops + 1,
              prompt: `**Handoff from @${bot.slug} (${bot.name}):**\n\n${args.message}\n\n---\nHandle this, then reply. If it belongs to someone else, say so rather than guessing.`,
            });
            return { content: [{ type: 'text' as const, text: `Handed to @${target.slug}. They will pick it up and reply in their own thread.` }] };
          },
        ),
        tool(
          'remember',
          'Save a durable preference or fact to your memory so it survives future turns. Use only for stable things, never for changing data.',
          { title: z.string().describe('short kebab-case file name'), note: z.string().describe('the fact, in markdown') },
          async (args: { title: string; note: string }) => {
            const dir = ensureMemoryDir(workspace, bot.slug);
            const file = path.join(dir, `${args.title.replace(/[^a-zA-Z0-9._-]/g, '-')}.md`);
            fs.writeFileSync(file, args.note);
            return { content: [{ type: 'text' as const, text: `Saved to memory: ${path.basename(file)}` }] };
          },
        ),
        tool(
          'list_skills',
          'List every skill installed on this account, with its slug. Check here before installing ' +
            'something that may already be present, and to find the exact slug to pass to remove_skill.',
          {},
          async () => {
            const skills = this.deps.listSkills?.() ?? [];
            if (!skills.length)
              return { content: [{ type: 'text' as const, text: 'No skills are installed.' }] };
            const lines = skills.map((sk) => `- ${sk.slug} — ${sk.name}${sk.description ? `: ${sk.description}` : ''}`);
            return { content: [{ type: 'text' as const, text: `${skills.length} skill(s) installed:\n${lines.join('\n')}` }] };
          },
        ),
        tool(
          'install_skill',
          'Install a skill so you (and other bots) can use it. This always stops for the human\'s ' +
            'approval first, because a skill is instructions that will steer future work and may ship scripts. ' +
            'Check list_skills before installing something you already have.\n' +
            'Install the NARROWEST source that covers the request. Accepted forms:\n' +
            '  github.com/owner/repo/tree/<ref>/<dir>  one skill inside a repository — prefer this\n' +
            '  https://host/path/SKILL.md              one skill, direct link\n' +
            '  ./path/to/skill                         a local directory\n' +
            '  owner/repo, github.com/owner/repo       EVERY skill in the repository\n' +
            'A bare owner/repo pointing at a collection installs all of it. If the human asked for one ' +
            'named skill, point at that skill\'s directory instead; if you only have a link to the repo ' +
            'root, call this anyway and the error will list what is inside so you can narrow it.',
          {
            source: z.string().describe('prefer owner/repo/tree/<ref>/<dir> or a /SKILL.md link; owner/repo installs the whole repository'),
            reason: z.string().describe('why you need this skill for the task at hand'),
            install_all: z
              .boolean()
              .optional()
              .describe('set true only when the human has asked for every skill in a multi-skill source'),
          },
          async (args: { source: string; reason: string; install_all?: boolean }) => {
            if (!this.deps.installSkill)
              return { content: [{ type: 'text' as const, text: 'Skill installation is unavailable on this server.' }] };
            try {
              const installed = await this.deps.installSkill(args.source, { allowMultiple: args.install_all === true });
              if (!installed.length)
                return { content: [{ type: 'text' as const, text: `No skill found at "${args.source}".` }] };
              const names = installed.map((i) => i.name).join(', ');
              const scripts = installed.flatMap((i) => i.executables);
              const note = scripts.length
                ? ` Note for the human: this shipped ${scripts.length} script(s): ${scripts.join(', ')}.`
                : '';
              return {
                content: [{
                  type: 'text' as const,
                  text: `Installed: ${names}.${note} A skill must still be assigned to you in Bot settings ` +
                    'before you can invoke it — ask the human to enable it, then retry.',
                }],
              };
            } catch (err) {
              const e = err as Error & { name?: string; names?: string[] };
              if (e.name === 'MultipleSkillsError' && Array.isArray(e.names)) {
                const listed = e.names.slice(0, 40).join(', ');
                const more = e.names.length > 40 ? `, and ${e.names.length - 40} more` : '';
                return {
                  content: [{
                    type: 'text' as const,
                    text:
                      `Nothing was installed. "${args.source}" holds ${e.names.length} skills: ${listed}${more}.\n` +
                      'Pick the one you need and install just it, e.g. ' +
                      `${args.source.replace(/^https?:\/\//, '').replace(/\/$/, '')}/tree/main/<skill-directory>. ` +
                      'Only pass install_all if the human has asked for all of them.',
                  }],
                };
              }
              return { content: [{ type: 'text' as const, text: `Install failed: ${e.message}` }] };
            }
          },
        ),
        tool(
          'remove_skill',
          'Uninstall a skill by slug — deletes its directory and its registration together. ' +
            'Use this rather than deleting skill directories with Bash, which would leave the ' +
            'registry pointing at files that no longer exist. Stops for the human\'s approval.',
          {
            slug: z.string().describe('the skill slug, exactly as list_skills reports it'),
            reason: z.string().describe('why this skill should be removed'),
          },
          async (args: { slug: string; reason: string }) => {
            if (!this.deps.removeSkill)
              return { content: [{ type: 'text' as const, text: 'Skill removal is unavailable on this server.' }] };
            try {
              const res = await this.deps.removeSkill(args.slug);
              if (!res.removed) {
                const known = (this.deps.listSkills?.() ?? []).map((sk) => sk.slug).join(', ');
                return { content: [{ type: 'text' as const, text: `No skill with slug "${args.slug}". Installed: ${known || 'none'}.` }] };
              }
              return { content: [{ type: 'text' as const, text: `Removed "${args.slug}"${res.name ? ` (${res.name})` : ''}.` }] };
            } catch (err) {
              return { content: [{ type: 'text' as const, text: `Remove failed: ${(err as Error).message}` }] };
            }
          },
        ),
        tool(
          'request_secret',
          'Ask the human for a secret value (API key, token). The value goes straight to the keychain and is never shown to you. Never ask for passwords in chat — ask for computer takeover instead.',
          { name: z.string().describe('identifier, e.g. STRIPE_API_KEY'), reason: z.string() },
          async (args: { name: string; reason: string }) => {
            this.deps.bus.publish({ type: 'secret.request', botId: bot.id, threadId, requestId: newId(), name: args.name, reason: args.reason });
            return { content: [{ type: 'text' as const, text: `Asked the human for "${args.name}". It will be injected into your environment as that variable name; you will never see the value. Continue once they confirm.` }] };
          },
        ),
      ],
    });
  }

  private postSystemCard(threadId: string, botId: string, card: Card): void {
    const msg = this.deps.store.createMessage({ threadId, authorKind: 'system', authorBotId: botId, cards: [card] });
    this.deps.bus.publish({ type: 'message.created', threadId, botId, message: msg });
  }

  private async execute(job: TurnJob): Promise<void> {
    const { store, bus, gateway, workspace, getSettings } = this.deps;
    const bot = store.getBot(job.botId);
    if (!bot) return;

    const abort = new AbortController();
    this.running.set(job.botId, { job, abort });
    this.setState(job.botId, 'running', 'none');

    const settings = getSettings();
    const msg = store.createMessage({
      threadId: job.threadId, authorKind: 'bot', authorBotId: bot.id, contentMd: '', streaming: true,
    });
    bus.publish({ type: 'message.created', threadId: job.threadId, botId: bot.id, message: msg });

    const thread = store.getThread(job.threadId);
    const isGroup = thread?.kind === 'group';
    const botDir = path.join(workspace, 'bots', bot.slug);
    fs.mkdirSync(botDir, { recursive: true });

    const botSkills = store.listBotSkills(bot.id);
    const connectors = await this.deps.connectorServers?.(bot.id);
    const systemPrompt = buildSystemPrompt({
      bot, workspace, skills: botSkills,
      connectors: connectors?.mounted ?? [],
      roster: store.listBots().map((x) => ({ slug: x.slug, name: x.name, title: x.title })),
      isGroup,
    });

    let text = '';
    let ok = true;
    let errorMessage = '';
    const toolCards = new Map<string, number>();

    const mcpServers: Record<string, any> = { antbot: this.buildToolServer(bot, job.threadId, job.hops) };
    const browser = this.deps.browserTools?.(bot.id);
    if (browser) mcpServers.browser = browser;


    try {
      for await (const ev of runTurn({
        prompt: job.prompt,
        resumeSessionId: bot.sessionId,
        modelTier: bot.modelTier,
        systemPrompt,
        cwd: workspace,
        settings,
        abortController: abort,
        mcpServers,
        // Names are validated against RESERVED_CONNECTOR_NAMES, so these cannot clobber the two
        // in-process servers above. Mounted by the runtime adapter, not here.
        connectors: connectors?.servers ?? {},
        skillPluginPath: this.deps.skillPluginPath?.(),
        // Skill names come from SKILL.md frontmatter, which is what the SDK matches on.
        enabledSkills: botSkills.map((s) => s.name),
        canUseTool: async (toolName, input) => {
          // Tools we provide ourselves are already scoped; the gateway still sees them.
          this.setState(job.botId, 'waiting_approval', 'needs_attention');
          const d = await gateway.check({
            botId: bot.id, threadId: job.threadId, toolName, input,
            botDescription: bot.description, settings, signal: abort.signal,
            workspace,
            // Render the approval inline in the transcript so the human can act on it
            // where the work is happening, not only in a global queue.
            onPending: (approval) => {
              const card: Card = { type: 'approval', approvalId: approval.id };
              const idx = store.appendCard(msg.id, card);
              bus.publish({
                type: 'message.card', threadId: job.threadId, botId: bot.id,
                messageId: msg.id, card, cardIndex: idx,
              });
            },
          });
          if (!abort.signal.aborted) this.setState(job.botId, 'running');
          return d.behavior === 'allow'
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: d.message };
        },
      })) {
        await this.applyEvent(ev, { job, bot, msgId: msg.id, toolCards });
        if (ev.kind === 'text' && ev.text) text += ev.text;
        if (ev.kind === 'done') {
          if (ev.text && !text.trim()) text = ev.text;
          ok = !ev.isError;
        }
        if (ev.kind === 'error') {
          ok = false;
          errorMessage = ev.message ?? 'Unknown error';
        }
      }
    } catch (err) {
      ok = false;
      errorMessage = err instanceof Error ? err.message : String(err);
      log.error('turn crashed', err);
    } finally {
      this.running.delete(job.botId);
    }

    if (errorMessage) {
      const idx = store.appendCard(msg.id, { type: 'error', message: errorMessage });
      bus.publish({ type: 'message.card', threadId: job.threadId, botId: bot.id, messageId: msg.id, card: { type: 'error', message: errorMessage }, cardIndex: idx });
    }

    const final = text.trim();
    store.updateMessage(msg.id, { contentMd: final, streaming: false });
    bus.publish({ type: 'message.done', threadId: job.threadId, botId: bot.id, messageId: msg.id, contentMd: final });

    const interrupted = abort.signal.aborted;
    this.setState(job.botId, interrupted ? 'interrupted' : 'idle', 'unread');
    if (interrupted) this.setState(job.botId, 'idle', 'unread');

    job.onDone?.(final || errorMessage, ok && !interrupted);
    void this.drain();
  }

  private async applyEvent(
    ev: TurnEvent,
    ctx: { job: TurnJob; bot: Bot; msgId: string; toolCards: Map<string, number> },
  ): Promise<void> {
    const { store, bus } = this.deps;
    const { job, bot, msgId, toolCards } = ctx;

    switch (ev.kind) {
      case 'session':
        if (ev.sessionId) store.updateBot(bot.id, { sessionId: ev.sessionId });
        break;

      // A connector that does not come up gives the bot no tools and no way to say why — it
      // simply behaves as though the connector were never assigned. Surfacing the SDK's own
      // verdict is the difference between "my bot ignores my connector" and a stated reason.
      case 'mcp_status': {
        // Persist every connector's verdict on its row — the Connectors screen shows state, and a
        // toast is gone in seconds. The two in-process servers are not rows.
        for (const m of ev.mcpStatus ?? []) {
          if (m.name === 'antbot' || m.name === 'browser') continue;
          store.setConnectorStatusByName(m.name, m.status, m.error ?? null);
        }
        const bad = (ev.mcpStatus ?? []).filter((m) => m.status !== 'connected');
        if (!bad.length) break;
        for (const m of bad) {
          log.warn(`connector "${m.name}" did not connect for ${bot.slug}: ${m.status}${m.error ? ` — ${m.error}` : ''}`);
        }
        bus.publish({
          type: 'notify',
          botId: bot.id,
          threadId: job.threadId,
          title: 'Connector unavailable',
          body: bad.map((m) => `${m.name}: ${describeMcpStatus(m.status)}`).join('; '),
          level: 'warn',
        });
        break;
      }

      // Mid-turn sign-in: the link goes into the thread as a card, where the human is looking,
      // and it persists — a toast would be gone before they came back from the browser.
      case 'signin': {
        if (!ev.signin) break;
        const card: Card = { type: 'signin', serverName: ev.signin.serverName, url: ev.signin.url };
        const idx = store.appendCard(msgId, card);
        bus.publish({ type: 'message.card', threadId: job.threadId, botId: bot.id, messageId: msgId, card, cardIndex: idx });
        store.setConnectorStatusByName(ev.signin.serverName, 'needs-sign-in', null);
        break;
      }

      case 'text':
        if (ev.text) {
          const cur = store.getMessage(msgId);
          store.updateMessage(msgId, { contentMd: (cur?.contentMd ?? '') + ev.text });
          bus.publish({ type: 'message.delta', threadId: job.threadId, botId: bot.id, messageId: msgId, delta: ev.text });
        }
        break;

      case 'tool_start': {
        const card: Card = {
          type: 'tool', toolName: ev.toolName ?? 'tool',
          summary: summarizeTool(ev.toolName ?? '', ev.toolInput),
          input: ev.toolInput, status: 'running',
        };
        const idx = store.appendCard(msgId, card);
        if (ev.toolUseId) toolCards.set(ev.toolUseId, idx);
        bus.publish({ type: 'message.card', threadId: job.threadId, botId: bot.id, messageId: msgId, card, cardIndex: idx });
        break;
      }

      case 'tool_result': {
        const idx = ev.toolUseId ? toolCards.get(ev.toolUseId) : undefined;
        if (idx === undefined) break;
        const cur = store.getMessage(msgId);
        const existing = cur?.cards[idx];
        if (!existing || existing.type !== 'tool') break;
        const denied = ev.isError && /denied|approval/i.test(ev.result ?? '');
        const card: Card = {
          ...existing,
          status: denied ? 'denied' : ev.isError ? 'error' : 'ok',
          result: (ev.result ?? '').slice(0, 2000),
        };
        store.updateCard(msgId, idx, card);
        bus.publish({ type: 'message.card', threadId: job.threadId, botId: bot.id, messageId: msgId, card, cardIndex: idx });
        break;
      }

      case 'done':
        if (ev.sessionId) store.updateBot(bot.id, { sessionId: ev.sessionId });
        if (ev.usage) {
          store.recordUsage({
            botId: bot.id, turnId: job.id, model: ev.usage.model,
            inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens,
            cacheReadTokens: ev.usage.cacheReadTokens, costEstimate: ev.usage.costUsd,
          });
          bus.publish({
            type: 'usage.tick', threadId: job.threadId, botId: bot.id,
            inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens, model: ev.usage.model,
          });
        }
        break;

      default:
        break;
    }
  }
}

/** Plain-language reason a connector is not usable this turn. */
export function describeMcpStatus(status: string): string {
  switch (status) {
    case 'needs-auth':
      return 'needs authentication — the server rejected the credentials it was given (or was given none)';
    case 'failed':
      return 'failed to start — run `antbot mcp check <name>` to see why';
    case 'pending':
      return 'did not finish connecting in time';
    case 'disabled':
      return 'is disabled';
    default:
      return status;
  }
}

/**
 * Tool arguments as `key: value`, not JSON.
 *
 * These land in an approval card and in the thread, where a raw object is noise a person has to
 * decode before deciding anything. Nested objects collapse to `{…}`: naming the key is useful,
 * dumping its contents is the thing being avoided.
 */
export function summarizeArgs(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue;
    let s: string;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
    else if (Array.isArray(v)) s = `${v.length} item${v.length === 1 ? '' : 's'}`;
    else s = '{…}';
    parts.push(`${k}: ${s.length > 60 ? `${s.slice(0, 60)}…` : s}`);
  }
  return parts.join(', ');
}

export function summarizeTool(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  if (name === 'Bash') return s('command').slice(0, 160);
  if (name === 'Read' || name === 'Write' || name === 'Edit') return s('file_path');
  if (name === 'WebFetch') return s('url');
  if (name.includes('send_to_bot')) return `→ @${s('bot_slug')}`;
  if (name.includes('install_skill')) return describeSkillSource(s('source'));
  if (name.includes('remove_skill')) return `remove skill: ${s('slug')}`;
  if (name.includes('list_skills')) return 'list installed skills';
  if (name.includes('remember')) return `memory: ${s('title')}`;
  if (name.startsWith('browser_') || name.includes('browser')) return [s('url'), s('selector'), s('text')].filter(Boolean).join(' ').slice(0, 160);
  // A third-party connector's tool. Nothing is known about its arguments, but naming the server
  // and the tool beats an approval card that reads as raw JSON. Matched last so the built-in
  // servers above keep their own summaries.
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) {
    const args = summarizeArgs(input);
    return `${mcp[1]}: ${mcp[2]}${args ? ` ${args}` : ''}`.slice(0, 160);
  }
  const args = summarizeArgs(input);
  return args.length > 160 ? `${args.slice(0, 160)}…` : args;
}
