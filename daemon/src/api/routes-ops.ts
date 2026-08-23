import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { App } from '../app.js';
import { workspaceRelative } from '../app.js';
import {
  ApprovalDecisionRequest, CreateRuleRequest, CreateRoutineRequest, CreateSkillRequest,
  SettingsPatchSchema, LimitError, type UsageSummary, type SearchResult,
} from '@antbot/contract';

export function registerOpsRoutes(f: FastifyInstance, app: App): void {
  const { store, gateway, bus } = app;

  /* ---------------------------- approvals ---------------------------- */
  f.get('/api/approvals', async () => store.listPendingApprovals());

  f.post<{ Params: { id: string } }>('/api/approvals/:id', async (req, reply) => {
    const parsed = ApprovalDecisionRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    const updated = gateway.decide(req.params.id, parsed.data.decision, parsed.data.alwaysRule);
    return updated ?? reply.code(404).send({ error: 'No such approval' });
  });

  /* ------------------------------ rules ------------------------------ */
  f.get('/api/rules', async () => store.listRules());

  f.post('/api/rules', async (req, reply) => {
    const parsed = CreateRuleRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    try {
      new RegExp(parsed.data.inputPattern || '');
    } catch {
      return reply.code(400).send({ error: 'inputPattern is not a valid regular expression' });
    }
    return store.createRule(parsed.data);
  });

  f.patch<{ Params: { id: string }; Body: { enabled: boolean } }>('/api/rules/:id', async (req, reply) => {
    const rule = store.getRule(req.params.id);
    if (!rule) return reply.code(404).send({ error: 'No such rule' });
    store.setRuleEnabled(rule.id, Boolean(req.body?.enabled));
    return store.getRule(rule.id);
  });

  f.delete<{ Params: { id: string } }>('/api/rules/:id', async (req, reply) => {
    const rule = store.getRule(req.params.id);
    if (!rule) return reply.code(404).send({ error: 'No such rule' });
    if (rule.builtin) return reply.code(400).send({ error: 'Built-in rules cannot be deleted; disable it instead.' });
    store.deleteRule(rule.id);
    return { ok: true };
  });

  /* ------------------------------ skills ----------------------------- */
  f.get('/api/skills', async () => store.listSkills());

  f.post('/api/skills', async (req, reply) => {
    const parsed = CreateSkillRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    if (!app.skills?.writeSkill) return reply.code(503).send({ error: 'Skills subsystem unavailable' });
    return app.skills.writeSkill(parsed.data);
  });

  // Install from a source (git repo, local path, or a raw SKILL.md URL). This is the
  // simple path: no hand-built JSON body, just the source string.
  f.post<{ Body: { source?: string } }>('/api/skills/install', async (req, reply) => {
    const source = (req.body?.source ?? '').trim();
    if (!source) return reply.code(400).send({ error: 'A "source" is required' });
    if (!app.skills?.installFromSource) return reply.code(503).send({ error: 'Skills subsystem unavailable' });
    try {
      // A human typing `antbot skill add owner/repo` is asking for that repository, whatever
      // it holds; the multi-skill guard exists for bots choosing a source on their own.
      const installed = await app.skills.installFromSource(source, { allowMultiple: true });
      return {
        installed: installed.map((i: { skill: unknown; executables: string[]; manifestText: string; replaced: boolean }) => ({
          skill: i.skill,
          executables: i.executables,
          manifest: i.manifestText,
          replaced: i.replaced,
        })),
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  f.get<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) return reply.code(404).send({ error: 'No such skill' });
    if (app.skills?.readSkill) return app.skills.readSkill(skill.id);
    return { ...skill, bodyMd: '' };
  });

  f.delete<{ Params: { id: string } }>('/api/skills/:id', async (req, reply) => {
    const skill = store.getSkill(req.params.id);
    if (!skill) return reply.code(404).send({ error: 'No such skill' });
    if (app.skills?.deleteSkill) app.skills.deleteSkill(skill.id);
    else store.deleteSkill(skill.id);
    return { ok: true };
  });

  /* ------------------------- secrets (WP-2.4) ------------------------ */
  // Values go straight to the OS keychain. Only NAMES are ever returned here, and a
  // value is never written to a transcript or placed in the model's context.
  f.get('/api/secrets', async () => ({
    backend: app.secrets?.backendName ?? 'unavailable',
    names: app.secrets?.list() ?? [],
  }));

  f.post<{ Body: { name?: string; value?: string } }>('/api/secrets', async (req, reply) => {
    if (!app.secrets) return reply.code(503).send({ error: 'Secrets backend unavailable' });
    const name = (req.body?.name ?? '').trim();
    const value = req.body?.value ?? '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return reply.code(400).send({ error: 'Name must be a valid environment-variable identifier' });
    if (!value) return reply.code(400).send({ error: 'A value is required' });
    await app.secrets.set(name, value);
    return { ok: true, names: app.secrets.list() };
  });

  f.delete<{ Params: { name: string } }>('/api/secrets/:name', async (req, reply) => {
    if (!app.secrets) return reply.code(503).send({ error: 'Secrets backend unavailable' });
    await app.secrets.remove(req.params.name);
    return { ok: true, names: app.secrets.list() };
  });

  /* ----------------------------- routines ---------------------------- */
  f.get<{ Querystring: { botId?: string } }>('/api/routines', async (req) => store.listRoutines(req.query.botId));

  f.post('/api/routines', async (req, reply) => {
    const parsed = CreateRoutineRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
    if (!store.getBot(parsed.data.botId)) return reply.code(400).send({ error: 'No such bot' });
    try {
      const routine = store.createRoutine({ ...parsed.data, timezone: parsed.data.timezone ?? app.getSettings().timezone });
      app.scheduler?.reload?.(routine.id);
      return routine;
    } catch (err) {
      if (err instanceof LimitError) return reply.code(409).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  f.patch<{ Params: { id: string } }>('/api/routines/:id', async (req, reply) => {
    const routine = store.updateRoutine(req.params.id, (req.body ?? {}) as Record<string, never>);
    if (!routine) return reply.code(404).send({ error: 'No such routine' });
    app.scheduler?.reload?.(routine.id);
    return routine;
  });

  f.delete<{ Params: { id: string } }>('/api/routines/:id', async (req, reply) => {
    if (!store.getRoutine(req.params.id)) return reply.code(404).send({ error: 'No such routine' });
    store.deleteRoutine(req.params.id);
    app.scheduler?.reload?.(req.params.id);
    return { ok: true };
  });

  f.get<{ Params: { id: string } }>('/api/routines/:id/runs', async (req) => store.listRuns(req.params.id));

  f.post<{ Params: { id: string } }>('/api/routines/:id/test-run', async (req, reply) => {
    const routine = store.getRoutine(req.params.id);
    if (!routine) return reply.code(404).send({ error: 'No such routine' });
    if (!app.scheduler?.testRun) return reply.code(503).send({ error: 'Scheduler unavailable' });
    const runId = await app.scheduler.testRun(routine.id);
    return { runId };
  });

  /* ---------------------------- attachments -------------------------- */
  f.post('/api/attachments', async (req, reply) => {
    const anyReq = req as unknown as { file?: () => Promise<any>; isMultipart?: () => boolean };
    if (typeof anyReq.file !== 'function') return reply.code(400).send({ error: 'Expected a multipart upload' });
    const part = await anyReq.file();
    if (!part) return reply.code(400).send({ error: 'No file in request' });
    const buf: Buffer = await part.toBuffer();
    const safe = String(part.filename ?? 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const dest = path.join(app.cfg.paths.attachments, `${Date.now()}-${safe}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    try {
      return store.createAttachment({
        messageId: null, path: dest, name: safe,
        mime: part.mimetype ?? 'application/octet-stream', bytes: buf.byteLength,
      });
    } catch (err) {
      fs.unlinkSync(dest);
      if (err instanceof LimitError) return reply.code(413).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  f.get<{ Params: { id: string } }>('/api/attachments/:id', async (req, reply) => {
    const a = store.getAttachment(req.params.id);
    if (!a || !fs.existsSync(a.path)) return reply.code(404).send({ error: 'No such attachment' });
    return reply.type(a.mime).send(fs.createReadStream(a.path));
  });

  /* ------------------------------ usage ------------------------------ */
  f.get('/api/usage', async (): Promise<UsageSummary> => {
    const rows = store.listUsage(0);
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const byBot = new Map<string, { inputTokens: number; outputTokens: number }>();
    const byDay = new Map<string, { inputTokens: number; outputTokens: number }>();
    const byModel = new Map<string, { inputTokens: number; outputTokens: number }>();
    for (const r of rows) {
      totals.inputTokens += r.inputTokens;
      totals.outputTokens += r.outputTokens;
      totals.cacheReadTokens += r.cacheReadTokens;
      const day = new Date(r.createdAt).toISOString().slice(0, 10);
      for (const [map, key] of [[byBot, r.botId], [byDay, day], [byModel, r.model]] as const) {
        const cur = map.get(key) ?? { inputTokens: 0, outputTokens: 0 };
        cur.inputTokens += r.inputTokens;
        cur.outputTokens += r.outputTokens;
        map.set(key, cur);
      }
    }
    return {
      totals,
      byBot: [...byBot].map(([botId, v]) => ({ botId, botName: store.getBot(botId)?.name ?? 'deleted', ...v })),
      byDay: [...byDay].map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
      byModel: [...byModel].map(([model, v]) => ({ model, ...v })),
    };
  });

  /* ------------------------------ search ----------------------------- */
  f.get<{ Querystring: { q?: string } }>('/api/search', async (req): Promise<SearchResult[]> => {
    const q = (req.query.q ?? '').trim();
    if (!q) return [];
    const out: SearchResult[] = [];
    for (const b of store.listBots()) {
      if (b.name.toLowerCase().includes(q.toLowerCase()) || b.title.toLowerCase().includes(q.toLowerCase()))
        out.push({ kind: 'bot', id: b.id, threadId: b.threadId, botId: b.id, title: b.name, snippet: b.title || b.description.slice(0, 120), createdAt: b.createdAt });
    }
    for (const m of store.searchMessages(q)) {
      const idx = m.contentMd.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 60);
      out.push({
        kind: 'message', id: m.id, threadId: m.threadId, botId: m.authorBotId,
        title: m.authorKind === 'user' ? 'You' : store.getBot(m.authorBotId ?? '')?.name ?? 'Bot',
        snippet: `${start > 0 ? '…' : ''}${m.contentMd.slice(start, start + 180)}`,
        createdAt: m.createdAt,
      });
    }
    for (const r of store.listRoutines()) {
      if (r.name.toLowerCase().includes(q.toLowerCase()))
        out.push({ kind: 'routine', id: r.id, threadId: null, botId: r.botId, title: r.name, snippet: r.cronExpr, createdAt: r.createdAt });
    }
    return out.slice(0, 50);
  });

  /* ----------------------------- settings ---------------------------- */
  f.get('/api/settings', async () => store.getSettings());

  f.patch('/api/settings', async (req, reply) => {
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid settings' });
    const next = store.patchSettings(parsed.data);
    app.scheduler?.syncAll?.();
    bus.publish({ type: 'notify', botId: null, threadId: null, title: 'Settings updated', body: '', level: 'info' });
    return next;
  });

  /* ---------------------------- workspace ---------------------------- */
  f.get<{ Querystring: { path?: string } }>('/api/workspace/tree', async (req, reply) => {
    const root = app.cfg.paths.workspace;
    const target = workspaceRelative(root, req.query.path ?? '.');
    if (!target) return reply.code(400).send({ error: 'Path is outside the workspace' });
    if (!fs.existsSync(target)) return [];
    return fs.readdirSync(target, { withFileTypes: true })
      .map((d) => {
        const full = path.join(target, d.name);
        let bytes = 0;
        try { bytes = d.isFile() ? fs.statSync(full).size : 0; } catch { /* ignore */ }
        return { name: d.name, path: path.relative(root, full), dir: d.isDirectory(), bytes };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  });

  f.get<{ Querystring: { path?: string } }>('/api/workspace/file', async (req, reply) => {
    const root = app.cfg.paths.workspace;
    const target = workspaceRelative(root, req.query.path ?? '');
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile())
      return reply.code(404).send({ error: 'No such file' });
    const ext = path.extname(target).toLowerCase();
    const mime: Record<string, string> = {
      '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
      '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.html': 'text/html',
    };
    return reply.type(mime[ext] ?? 'application/octet-stream').send(fs.createReadStream(target));
  });

  /* ----------------------------- computer ---------------------------- */
  f.get('/api/computer/status', async () => {
    if (!app.browser?.status) return { available: false, reason: 'Browser service not built', mode: 'host', headless: true, pages: [] };
    try {
      return await app.browser.status();
    } catch (err) {
      return { available: false, reason: (err as Error).message, mode: 'host', headless: true, pages: [] };
    }
  });

  f.post<{ Body: { botId?: string } }>('/api/computer/takeover', async (req, reply) => {
    if (!app.browser?.takeOver) return reply.code(503).send({ error: 'Browser service unavailable' });
    return app.browser.takeOver(req.body?.botId ?? 'shared');
  });

  f.delete<{ Body: { botId?: string } }>('/api/computer/takeover', async (req, reply) => {
    if (!app.browser?.returnControl) return reply.code(503).send({ error: 'Browser service unavailable' });
    await app.browser.returnControl(req.body?.botId ?? 'shared');
    return { ok: true };
  });
}
