import type { FastifyInstance } from 'fastify';
import type { App } from '../app.js';
import {
  CreateBotRequest, UpdateBotRequest, CreateThreadRequest, PostMessageRequest,
  LimitError, type RosterEntry, type ThreadWithMessages,
} from '@antbot/contract';
import { routeGroupMessage, parseMentions } from '../bots/groups.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageVersion } from '../util/locate.js';
import { readMemory, writeMemory, deleteMemory } from '../memory/memory.js';

// Read from package.json rather than hardcoded, so a release bump cannot leave /api/health
// claiming a version the CLI disagrees with.
export const SERVER_VERSION = readPackageVersion(
  path.dirname(fileURLToPath(import.meta.url)),
  (p) => fs.existsSync(p),
  (p) => fs.readFileSync(p, 'utf8'),
);

export function registerCoreRoutes(f: FastifyInstance, app: App): void {
  const { store, bus, manager } = app;

  f.get('/api/health', async () => ({
    ok: true,
    seq: bus.currentSeq,
    version: SERVER_VERSION,
    bots: store.listBots().length,
  }));

  /* ------------------------------- bots ------------------------------- */
  f.get('/api/bots', async (): Promise<RosterEntry[]> =>
    store.listBots().map((bot) => ({
      bot,
      thread: bot.threadId ? store.getThread(bot.threadId) : null,
      lastMessageAt: bot.threadId ? store.lastMessageAt(bot.threadId) : 0,
    })),
  );

  f.post('/api/bots', async (req, reply) => {
    const parsed = CreateBotRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid body' });
    try {
      return store.createBot(parsed.data);
    } catch (err) {
      if (err instanceof LimitError) return reply.code(409).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  f.get<{ Params: { id: string } }>('/api/bots/:id', async (req, reply) => {
    const bot = store.getBot(req.params.id);
    return bot ?? reply.code(404).send({ error: 'No such bot' });
  });

  f.patch<{ Params: { id: string } }>('/api/bots/:id', async (req, reply) => {
    const parsed = UpdateBotRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    const bot = store.updateBot(req.params.id, parsed.data);
    if (!bot) return reply.code(404).send({ error: 'No such bot' });
    bus.publish({ type: 'bot.state', botId: bot.id, threadId: bot.threadId, state: bot.state, attention: bot.attention });
    return bot;
  });

  f.delete<{ Params: { id: string } }>('/api/bots/:id', async (req, reply) => {
    if (!store.getBot(req.params.id)) return reply.code(404).send({ error: 'No such bot' });
    manager.interrupt(req.params.id);
    store.deleteBot(req.params.id);
    return { ok: true };
  });

  /**
   * Start a fresh conversation: clears the thread and the SDK session, keeps the bot.
   *
   * Refused while the bot is working — resetting the session mid-turn would leave the running
   * turn writing into a message that no longer exists.
   */
  f.post<{ Params: { id: string } }>('/api/bots/:id/reset', async (req, reply) => {
    const bot = store.getBot(req.params.id);
    if (!bot) return reply.code(404).send({ error: 'No such bot' });
    if (bot.state === 'running' || bot.state === 'queued') {
      return reply.code(409).send({ error: 'This bot is working. Stop it first, then start fresh.' });
    }
    const result = store.resetBotSession(bot.id);
    if (!result) return reply.code(404).send({ error: 'No such bot' });
    if (bot.threadId) bus.publish({ type: 'thread.updated', threadId: bot.threadId, botId: bot.id, threadId2: bot.threadId });
    return { ok: true, ...result };
  });

  f.post<{ Params: { id: string } }>('/api/bots/:id/duplicate', async (req, reply) => {
    try {
      const copy = store.duplicateBot(req.params.id);
      return copy ?? reply.code(404).send({ error: 'No such bot' });
    } catch (err) {
      if (err instanceof LimitError) return reply.code(409).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  f.post<{ Params: { id: string } }>('/api/bots/:id/stop', async (req) => ({
    stopped: manager.interrupt(req.params.id),
  }));

  /* ------------------------------ memory ------------------------------ */
  f.get<{ Params: { id: string } }>('/api/bots/:id/memory', async (req, reply) => {
    const bot = store.getBot(req.params.id);
    if (!bot) return reply.code(404).send({ error: 'No such bot' });
    return readMemory(app.cfg.paths.workspace, bot.slug);
  });

  f.put<{ Params: { id: string }; Body: { name: string; content: string } }>('/api/bots/:id/memory', async (req, reply) => {
    const bot = store.getBot(req.params.id);
    if (!bot) return reply.code(404).send({ error: 'No such bot' });
    const { name, content } = req.body ?? {};
    if (!name || typeof content !== 'string') return reply.code(400).send({ error: 'name and content are required' });
    writeMemory(app.cfg.paths.workspace, bot.slug, name, content);
    return { ok: true };
  });

  f.delete<{ Params: { id: string; name: string } }>('/api/bots/:id/memory/:name', async (req, reply) => {
    const bot = store.getBot(req.params.id);
    if (!bot) return reply.code(404).send({ error: 'No such bot' });
    deleteMemory(app.cfg.paths.workspace, bot.slug, req.params.name);
    return { ok: true };
  });

  f.get<{ Params: { id: string } }>('/api/bots/:id/skills', async (req, reply) => {
    if (!store.getBot(req.params.id)) return reply.code(404).send({ error: 'No such bot' });
    return store.listBotSkills(req.params.id);
  });

  f.put<{ Params: { id: string }; Body: { skillIds: string[] } }>('/api/bots/:id/skills', async (req, reply) => {
    if (!store.getBot(req.params.id)) return reply.code(404).send({ error: 'No such bot' });
    store.setBotSkills(req.params.id, req.body?.skillIds ?? []);
    return { ok: true };
  });

  f.get<{ Params: { id: string } }>('/api/bots/:id/connectors', async (req, reply) => {
    if (!store.getBot(req.params.id)) return reply.code(404).send({ error: 'No such bot' });
    return store.listBotConnectors(req.params.id);
  });

  f.put<{ Params: { id: string }; Body: { connectorIds: string[] } }>('/api/bots/:id/connectors', async (req, reply) => {
    if (!store.getBot(req.params.id)) return reply.code(404).send({ error: 'No such bot' });
    store.setBotConnectors(req.params.id, req.body?.connectorIds ?? []);
    return { ok: true };
  });

  /* ----------------------------- threads ------------------------------ */
  f.get('/api/threads', async () => store.listThreads());

  f.post('/api/threads', async (req, reply) => {
    const parsed = CreateThreadRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    try {
      const members = parsed.data.memberBotIds.map((id) => store.getBot(id)).filter(Boolean);
      if (members.length !== parsed.data.memberBotIds.length)
        return reply.code(400).send({ error: 'One or more bots do not exist' });
      const title = parsed.data.title || members.map((m) => m!.name).join(', ');
      return store.createThread({ ...parsed.data, title });
    } catch (err) {
      if (err instanceof LimitError) return reply.code(409).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  f.get<{ Params: { id: string } }>('/api/threads/:id', async (req, reply) => {
    const thread = store.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'No such thread' });
    const payload: ThreadWithMessages = { thread, messages: store.listMessages(thread.id) };
    return payload;
  });

  f.delete<{ Params: { id: string } }>('/api/threads/:id', async (req) => {
    store.deleteThread(req.params.id);
    return { ok: true };
  });

  f.post<{ Params: { id: string } }>('/api/threads/:id/read', async (req, reply) => {
    const thread = store.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'No such thread' });
    store.updateThread(thread.id, { lastReadAt: Date.now() });
    for (const id of thread.memberBotIds) {
      const bot = store.getBot(id);
      if (bot && bot.attention !== 'needs_attention') {
        store.updateBot(id, { attention: 'none' });
        bus.publish({ type: 'bot.state', botId: id, threadId: thread.id, state: bot.state, attention: 'none' });
      }
    }
    return { ok: true };
  });

  /* ----------------------------- messages ----------------------------- */
  f.post<{ Params: { id: string } }>('/api/threads/:id/messages', async (req, reply) => {
    const parsed = PostMessageRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    const thread = store.getThread(req.params.id);
    if (!thread) return reply.code(404).send({ error: 'No such thread' });

    app.lastUserActivity.at = Date.now();

    const msg = store.createMessage({
      threadId: thread.id, authorKind: 'user', contentMd: parsed.data.contentMd,
      replyToId: parsed.data.replyToId ?? null,
    });
    if (parsed.data.attachmentIds?.length) {
      try {
        store.attachToMessage(parsed.data.attachmentIds, msg.id);
      } catch (err) {
        if (err instanceof LimitError) return reply.code(409).send({ error: err.message, code: err.code });
        throw err;
      }
    }
    bus.publish({ type: 'message.created', threadId: thread.id, botId: null, message: store.getMessage(msg.id)! });

    const attachments = store.listAttachmentsForMessage(msg.id);
    const attachNote = attachments.length
      ? `\n\nAttached files (read them from disk):\n${attachments.map((a) => `- ${a.name} → ${a.path}`).join('\n')}`
      : '';
    const prompt = parsed.data.contentMd + attachNote;

    const members = thread.memberBotIds.map((id) => store.getBot(id)).filter(Boolean) as NonNullable<ReturnType<typeof store.getBot>>[];
    if (!members.length) return msg;

    if (thread.kind === 'dm') {
      manager.enqueue({ botId: members[0]!.id, threadId: thread.id, prompt, origin: 'user', hops: 0 });
    } else {
      const inline = parseMentions(parsed.data.contentMd, members);
      const targets = await routeGroupMessage({
        text: parsed.data.contentMd,
        members,
        mentionBotIds: parsed.data.mentionBotIds ?? inline.botIds,
        mentionEveryone: parsed.data.mentionEveryone ?? inline.everyone,
        settings: app.getSettings(),
        cwd: app.cfg.paths.workspace,
      });
      for (const t of targets)
        manager.enqueue({ botId: t.id, threadId: thread.id, prompt, origin: 'user', hops: 0 });
    }
    return msg;
  });
}
