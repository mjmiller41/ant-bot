import type { DB } from './db.js';
import { newId, now, slugify } from '../util/ids.js';
import {
  LIMITS, LIMIT_ERROR, LimitError,
  type Bot, type Thread, type Message, type Attachment, type Approval, type Rule,
  type Skill, type Routine, type RoutineRun, type MailboxEntry, type UsageRow,
  type Card, type BotState, type Attention, type ModelTier, type Settings,
  SettingsSchema,
} from '@antbot/shared';

/* ------------------------------ row mappers ------------------------------ */
const b = (v: unknown): boolean => v === 1 || v === true;
const i = (v: boolean | undefined, d = false): number => ((v ?? d) ? 1 : 0);

type Row = Record<string, any>;

const toBot = (r: Row): Bot => ({
  id: r.id, slug: r.slug, name: r.name, title: r.title, description: r.description,
  avatarEmoji: r.avatar_emoji, modelTier: r.model_tier as ModelTier,
  pinned: b(r.pinned), hidden: b(r.hidden), notifications: b(r.notifications),
  sessionId: r.session_id, state: r.state as BotState, attention: r.attention as Attention,
  threadId: r.thread_id, createdAt: r.created_at, deletedAt: r.deleted_at,
});
const toThread = (r: Row): Thread => ({
  id: r.id, kind: r.kind, title: r.title, memberBotIds: JSON.parse(r.member_bot_ids),
  pinned: b(r.pinned), hidden: b(r.hidden), lastReadAt: r.last_read_at, createdAt: r.created_at,
});
const toMessage = (r: Row): Message => ({
  id: r.id, threadId: r.thread_id, authorKind: r.author_kind, authorBotId: r.author_bot_id,
  replyToId: r.reply_to_id, contentMd: r.content_md, cards: JSON.parse(r.cards),
  streaming: b(r.streaming), createdAt: r.created_at,
});
const toApproval = (r: Row): Approval => ({
  id: r.id, botId: r.bot_id, threadId: r.thread_id, toolName: r.tool_name,
  inputSummary: r.input_summary, rawInput: JSON.parse(r.raw_input), status: r.status,
  decidedBy: r.decided_by, reason: r.reason, ruleId: r.rule_id,
  createdAt: r.created_at, decidedAt: r.decided_at,
});
const toRule = (r: Row): Rule => ({
  id: r.id, kind: r.kind, toolPattern: r.tool_pattern, inputPattern: r.input_pattern,
  scopeNote: r.scope_note, builtin: b(r.builtin), enabled: b(r.enabled), createdAt: r.created_at,
});
const toSkill = (r: Row): Skill => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, path: r.path,
  source: r.source, createdAt: r.created_at,
});
const toRoutine = (r: Row): Routine => ({
  id: r.id, botId: r.bot_id, name: r.name, cronExpr: r.cron_expr, timezone: r.timezone,
  instructionMd: r.instruction_md, enabled: b(r.enabled), lastRunAt: r.last_run_at,
  nextRunAt: r.next_run_at, createdAt: r.created_at,
});
const toRun = (r: Row): RoutineRun => ({
  id: r.id, routineId: r.routine_id, startedAt: r.started_at, finishedAt: r.finished_at,
  status: r.status, summary: r.summary, threadId: r.thread_id, isTest: b(r.is_test),
});
const toAttachment = (r: Row): Attachment => ({
  id: r.id, messageId: r.message_id, path: r.path, name: r.name, mime: r.mime,
  bytes: r.bytes, createdAt: r.created_at,
});
const toMail = (r: Row): MailboxEntry => ({
  id: r.id, fromBotId: r.from_bot_id, toBotId: r.to_bot_id, contentMd: r.content_md,
  hops: r.hops, delivered: b(r.delivered), createdAt: r.created_at,
});
const toUsage = (r: Row): UsageRow => ({
  id: r.id, botId: r.bot_id, turnId: r.turn_id, model: r.model, inputTokens: r.input_tokens,
  outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens,
  costEstimate: r.cost_estimate, createdAt: r.created_at,
});

/* -------------------------------- store --------------------------------- */
export class Store {
  constructor(public db: DB) {}

  /* ---- bots ---- */
  countBotsAndGroups(): number {
    const bots = this.db.prepare(`SELECT COUNT(*) c FROM bots WHERE deleted_at IS NULL`).get() as Row;
    const groups = this.db.prepare(`SELECT COUNT(*) c FROM threads WHERE kind='group'`).get() as Row;
    return bots.c + groups.c;
  }

  createBot(input: { name: string; title?: string; description?: string; avatarEmoji?: string; modelTier?: ModelTier }): Bot {
    if (this.countBotsAndGroups() >= LIMITS.MAX_BOTS_AND_GROUPS)
      throw new LimitError(LIMIT_ERROR.TOO_MANY_BOTS, `Limit of ${LIMITS.MAX_BOTS_AND_GROUPS} bots and groups reached`);
    const existing = new Set(
      (this.db.prepare(`SELECT slug FROM bots`).all() as Row[]).map((r) => r.slug as string),
    );
    const id = newId();
    const thread = this.createThread({ kind: 'dm', title: input.name, memberBotIds: [id] });
    this.db
      .prepare(
        `INSERT INTO bots (id,slug,name,title,description,avatar_emoji,model_tier,pinned,hidden,notifications,session_id,state,attention,thread_id,created_at)
         VALUES (@id,@slug,@name,@title,@description,@avatar_emoji,@model_tier,0,0,1,NULL,'idle','none',@thread_id,@created_at)`,
      )
      .run({
        id, slug: slugify(input.name, existing), name: input.name, title: input.title ?? '',
        description: input.description ?? '', avatar_emoji: input.avatarEmoji ?? '🤖',
        model_tier: input.modelTier ?? 'sonnet', thread_id: thread.id, created_at: now(),
      });
    return this.getBot(id)!;
  }

  getBot(id: string): Bot | null {
    const r = this.db.prepare(`SELECT * FROM bots WHERE id=? AND deleted_at IS NULL`).get(id) as Row | undefined;
    return r ? toBot(r) : null;
  }
  getBotBySlug(slug: string): Bot | null {
    const r = this.db.prepare(`SELECT * FROM bots WHERE slug=? AND deleted_at IS NULL`).get(slug) as Row | undefined;
    return r ? toBot(r) : null;
  }
  listBots(includeHidden = true): Bot[] {
    const rows = this.db
      .prepare(`SELECT * FROM bots WHERE deleted_at IS NULL ${includeHidden ? '' : 'AND hidden=0'} ORDER BY pinned DESC, created_at ASC`)
      .all() as Row[];
    return rows.map(toBot);
  }
  updateBot(id: string, patch: Partial<Bot>): Bot | null {
    const cur = this.getBot(id);
    if (!cur) return null;
    const m: Record<string, unknown> = {
      name: patch.name ?? cur.name, title: patch.title ?? cur.title,
      description: patch.description ?? cur.description, avatar_emoji: patch.avatarEmoji ?? cur.avatarEmoji,
      model_tier: patch.modelTier ?? cur.modelTier,
      pinned: i(patch.pinned, cur.pinned), hidden: i(patch.hidden, cur.hidden),
      notifications: i(patch.notifications, cur.notifications),
      session_id: patch.sessionId !== undefined ? patch.sessionId : cur.sessionId,
      state: patch.state ?? cur.state, attention: patch.attention ?? cur.attention, id,
    };
    this.db.prepare(
      `UPDATE bots SET name=@name,title=@title,description=@description,avatar_emoji=@avatar_emoji,
       model_tier=@model_tier,pinned=@pinned,hidden=@hidden,notifications=@notifications,
       session_id=@session_id,state=@state,attention=@attention WHERE id=@id`,
    ).run(m);
    return this.getBot(id);
  }
  deleteBot(id: string): void {
    const bot = this.getBot(id);
    if (!bot) return;
    this.db.prepare(`UPDATE bots SET deleted_at=? WHERE id=?`).run(now(), id);
    this.db.prepare(`DELETE FROM routines WHERE bot_id=?`).run(id);
    if (bot.threadId) this.db.prepare(`DELETE FROM threads WHERE id=?`).run(bot.threadId);
  }
  duplicateBot(id: string): Bot | null {
    const src = this.getBot(id);
    if (!src) return null;
    const copy = this.createBot({
      name: `${src.name} copy`, title: src.title, description: src.description,
      avatarEmoji: src.avatarEmoji, modelTier: src.modelTier,
    });
    // carries skills + routines; NOT history or memory (outline §4)
    for (const bs of this.db.prepare(`SELECT * FROM bot_skills WHERE bot_id=?`).all(id) as Row[])
      this.db.prepare(`INSERT OR REPLACE INTO bot_skills (bot_id,skill_id,enabled) VALUES (?,?,?)`).run(copy.id, bs.skill_id, bs.enabled);
    for (const r of this.listRoutines(id))
      this.createRoutine({ botId: copy.id, name: r.name, cronExpr: r.cronExpr, timezone: r.timezone, instructionMd: r.instructionMd, enabled: false });
    return copy;
  }

  /* ---- threads & messages ---- */
  createThread(input: { kind: 'dm' | 'group'; title?: string; memberBotIds: string[] }): Thread {
    if (input.kind === 'group') {
      const n = input.memberBotIds.length;
      if (n < LIMITS.MIN_GROUP_MEMBERS || n > LIMITS.MAX_GROUP_MEMBERS)
        throw new LimitError(LIMIT_ERROR.GROUP_SIZE, `A group needs ${LIMITS.MIN_GROUP_MEMBERS}–${LIMITS.MAX_GROUP_MEMBERS} bots (got ${n})`);
      if (this.countBotsAndGroups() >= LIMITS.MAX_BOTS_AND_GROUPS)
        throw new LimitError(LIMIT_ERROR.TOO_MANY_BOTS, `Limit of ${LIMITS.MAX_BOTS_AND_GROUPS} bots and groups reached`);
    }
    const id = newId();
    this.db.prepare(
      `INSERT INTO threads (id,kind,title,member_bot_ids,pinned,hidden,last_read_at,created_at)
       VALUES (?,?,?,?,0,0,0,?)`,
    ).run(id, input.kind, input.title ?? '', JSON.stringify(input.memberBotIds), now());
    return this.getThread(id)!;
  }
  getThread(id: string): Thread | null {
    const r = this.db.prepare(`SELECT * FROM threads WHERE id=?`).get(id) as Row | undefined;
    return r ? toThread(r) : null;
  }
  listThreads(kind?: 'dm' | 'group'): Thread[] {
    const rows = (kind
      ? this.db.prepare(`SELECT * FROM threads WHERE kind=? ORDER BY created_at ASC`).all(kind)
      : this.db.prepare(`SELECT * FROM threads ORDER BY created_at ASC`).all()) as Row[];
    return rows.map(toThread);
  }
  updateThread(id: string, patch: Partial<Thread>): Thread | null {
    const cur = this.getThread(id);
    if (!cur) return null;
    this.db.prepare(
      `UPDATE threads SET title=?, member_bot_ids=?, pinned=?, hidden=?, last_read_at=? WHERE id=?`,
    ).run(
      patch.title ?? cur.title, JSON.stringify(patch.memberBotIds ?? cur.memberBotIds),
      i(patch.pinned, cur.pinned), i(patch.hidden, cur.hidden), patch.lastReadAt ?? cur.lastReadAt, id,
    );
    return this.getThread(id);
  }
  deleteThread(id: string): void {
    this.db.prepare(`DELETE FROM threads WHERE id=?`).run(id);
    this.db.prepare(`DELETE FROM messages WHERE thread_id=?`).run(id);
  }

  createMessage(input: {
    threadId: string; authorKind: 'user' | 'bot' | 'system'; authorBotId?: string | null;
    contentMd?: string; cards?: Card[]; streaming?: boolean; replyToId?: string | null;
  }): Message {
    const id = newId();
    this.db.prepare(
      `INSERT INTO messages (id,thread_id,author_kind,author_bot_id,reply_to_id,content_md,cards,streaming,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, input.threadId, input.authorKind, input.authorBotId ?? null, input.replyToId ?? null,
      input.contentMd ?? '', JSON.stringify(input.cards ?? []), i(input.streaming), now(),
    );
    return this.getMessage(id)!;
  }
  getMessage(id: string): Message | null {
    const r = this.db.prepare(`SELECT * FROM messages WHERE id=?`).get(id) as Row | undefined;
    return r ? toMessage(r) : null;
  }
  listMessages(threadId: string, limit = 500): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE thread_id=? ORDER BY created_at ASC LIMIT ?`)
      .all(threadId, limit) as Row[];
    return rows.map(toMessage);
  }
  updateMessage(id: string, patch: { contentMd?: string; cards?: Card[]; streaming?: boolean }): Message | null {
    const cur = this.getMessage(id);
    if (!cur) return null;
    this.db.prepare(`UPDATE messages SET content_md=?, cards=?, streaming=? WHERE id=?`).run(
      patch.contentMd ?? cur.contentMd, JSON.stringify(patch.cards ?? cur.cards), i(patch.streaming, cur.streaming), id,
    );
    return this.getMessage(id);
  }
  appendCard(id: string, card: Card): number {
    const cur = this.getMessage(id);
    if (!cur) return -1;
    const cards = [...cur.cards, card];
    this.db.prepare(`UPDATE messages SET cards=? WHERE id=?`).run(JSON.stringify(cards), id);
    return cards.length - 1;
  }
  updateCard(id: string, index: number, card: Card): void {
    const cur = this.getMessage(id);
    if (!cur || !cur.cards[index]) return;
    const cards = [...cur.cards];
    cards[index] = card;
    this.db.prepare(`UPDATE messages SET cards=? WHERE id=?`).run(JSON.stringify(cards), id);
  }
  lastMessageAt(threadId: string): number {
    const r = this.db.prepare(`SELECT MAX(created_at) m FROM messages WHERE thread_id=?`).get(threadId) as Row;
    return r?.m ?? 0;
  }

  /* ---- attachments ---- */
  createAttachment(a: Omit<Attachment, 'id' | 'createdAt'>): Attachment {
    const isVideo = a.mime.startsWith('video/');
    const cap = isVideo ? LIMITS.MAX_VIDEO_ATTACHMENT_BYTES : LIMITS.MAX_ATTACHMENT_BYTES;
    if (a.bytes > cap)
      throw new LimitError(LIMIT_ERROR.ATTACHMENT_TOO_LARGE, `${a.name} is ${(a.bytes / 1048576).toFixed(1)} MB; limit is ${cap / 1048576} MB`);
    const id = newId();
    this.db.prepare(
      `INSERT INTO attachments (id,message_id,path,name,mime,bytes,created_at) VALUES (?,?,?,?,?,?,?)`,
    ).run(id, a.messageId ?? null, a.path, a.name, a.mime, a.bytes, now());
    return toAttachment(this.db.prepare(`SELECT * FROM attachments WHERE id=?`).get(id) as Row);
  }
  getAttachment(id: string): Attachment | null {
    const r = this.db.prepare(`SELECT * FROM attachments WHERE id=?`).get(id) as Row | undefined;
    return r ? toAttachment(r) : null;
  }
  attachToMessage(ids: string[], messageId: string): void {
    if (ids.length > LIMITS.MAX_ATTACHMENTS_PER_MESSAGE)
      throw new LimitError(LIMIT_ERROR.TOO_MANY_ATTACHMENTS, `At most ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
    const stmt = this.db.prepare(`UPDATE attachments SET message_id=? WHERE id=?`);
    for (const id of ids) stmt.run(messageId, id);
  }
  listAttachmentsForMessage(messageId: string): Attachment[] {
    return (this.db.prepare(`SELECT * FROM attachments WHERE message_id=?`).all(messageId) as Row[]).map(toAttachment);
  }

  /* ---- approvals ---- */
  createApproval(a: { botId: string; threadId: string; toolName: string; inputSummary: string; rawInput: unknown; reason?: string }): Approval {
    const id = newId();
    this.db.prepare(
      `INSERT INTO approvals (id,bot_id,thread_id,tool_name,input_summary,raw_input,status,reason,created_at)
       VALUES (?,?,?,?,?,?, 'pending', ?, ?)`,
    ).run(id, a.botId, a.threadId, a.toolName, a.inputSummary, JSON.stringify(a.rawInput ?? null), a.reason ?? '', now());
    return this.getApproval(id)!;
  }
  getApproval(id: string): Approval | null {
    const r = this.db.prepare(`SELECT * FROM approvals WHERE id=?`).get(id) as Row | undefined;
    return r ? toApproval(r) : null;
  }
  listPendingApprovals(): Approval[] {
    return (this.db.prepare(`SELECT * FROM approvals WHERE status='pending' ORDER BY created_at ASC`).all() as Row[]).map(toApproval);
  }
  resolveApproval(id: string, status: 'allowed' | 'denied' | 'expired', decidedBy: 'user' | 'rule' | 'auto_review', ruleId?: string | null, reason?: string): Approval | null {
    const cur = this.getApproval(id);
    if (!cur) return null;
    this.db.prepare(`UPDATE approvals SET status=?, decided_by=?, rule_id=?, reason=?, decided_at=? WHERE id=?`)
      .run(status, decidedBy, ruleId ?? cur.ruleId, reason ?? cur.reason, now(), id);
    return this.getApproval(id);
  }

  /* ---- rules ---- */
  createRule(r: { kind: 'require' | 'allow'; toolPattern: string; inputPattern?: string; scopeNote?: string; builtin?: boolean }): Rule {
    const id = newId();
    this.db.prepare(
      `INSERT INTO rules (id,kind,tool_pattern,input_pattern,scope_note,builtin,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)`,
    ).run(id, r.kind, r.toolPattern, r.inputPattern ?? '', r.scopeNote ?? '', i(r.builtin), now());
    return this.getRule(id)!;
  }
  getRule(id: string): Rule | null {
    const r = this.db.prepare(`SELECT * FROM rules WHERE id=?`).get(id) as Row | undefined;
    return r ? toRule(r) : null;
  }
  listRules(onlyEnabled = false): Rule[] {
    return (this.db.prepare(`SELECT * FROM rules ${onlyEnabled ? 'WHERE enabled=1' : ''} ORDER BY kind ASC, created_at ASC`).all() as Row[]).map(toRule);
  }
  setRuleEnabled(id: string, enabled: boolean): void {
    this.db.prepare(`UPDATE rules SET enabled=? WHERE id=?`).run(i(enabled), id);
  }
  deleteRule(id: string): void {
    this.db.prepare(`DELETE FROM rules WHERE id=? AND builtin=0`).run(id);
  }

  /* ---- skills ---- */
  createSkill(s: { slug: string; name: string; description?: string; path: string; source?: 'user' | 'taught' | 'imported' }): Skill {
    const id = newId();
    this.db.prepare(
      `INSERT OR REPLACE INTO skills (id,slug,name,description,path,source,created_at) VALUES (?,?,?,?,?,?,?)`,
    ).run(id, s.slug, s.name, s.description ?? '', s.path, s.source ?? 'user', now());
    return this.getSkillBySlug(s.slug)!;
  }
  getSkill(id: string): Skill | null {
    const r = this.db.prepare(`SELECT * FROM skills WHERE id=?`).get(id) as Row | undefined;
    return r ? toSkill(r) : null;
  }
  getSkillBySlug(slug: string): Skill | null {
    const r = this.db.prepare(`SELECT * FROM skills WHERE slug=?`).get(slug) as Row | undefined;
    return r ? toSkill(r) : null;
  }
  listSkills(): Skill[] {
    return (this.db.prepare(`SELECT * FROM skills ORDER BY name ASC`).all() as Row[]).map(toSkill);
  }
  /**
   * Update a skill's metadata in place, keeping its id so bot assignments survive a
   * re-install. Returns null if the skill is gone.
   */
  updateSkill(id: string, patch: { name?: string; description?: string; path?: string }): Skill | null {
    const existing = this.getSkill(id);
    if (!existing) return null;
    this.db.prepare(`UPDATE skills SET name=?, description=?, path=? WHERE id=?`).run(
      patch.name ?? existing.name,
      patch.description ?? existing.description,
      patch.path ?? existing.path,
      id,
    );
    return this.getSkill(id);
  }
  deleteSkill(id: string): void {
    this.db.prepare(`DELETE FROM skills WHERE id=?`).run(id);
    this.db.prepare(`DELETE FROM bot_skills WHERE skill_id=?`).run(id);
  }
  setBotSkills(botId: string, skillIds: string[]): void {
    this.db.prepare(`DELETE FROM bot_skills WHERE bot_id=?`).run(botId);
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO bot_skills (bot_id,skill_id,enabled) VALUES (?,?,1)`);
    for (const s of skillIds) stmt.run(botId, s);
  }
  listBotSkills(botId: string): Skill[] {
    return (this.db.prepare(
      `SELECT s.* FROM skills s JOIN bot_skills bs ON bs.skill_id=s.id WHERE bs.bot_id=? AND bs.enabled=1`,
    ).all(botId) as Row[]).map(toSkill);
  }

  /* ---- routines ---- */
  createRoutine(r: { botId: string; name: string; cronExpr: string; timezone?: string; instructionMd: string; enabled?: boolean }): Routine {
    const count = (this.db.prepare(`SELECT COUNT(*) c FROM routines WHERE bot_id=?`).get(r.botId) as Row).c;
    if (count >= LIMITS.MAX_ROUTINES_PER_BOT)
      throw new LimitError(LIMIT_ERROR.TOO_MANY_ROUTINES, `A bot can own at most ${LIMITS.MAX_ROUTINES_PER_BOT} routines`);
    const id = newId();
    this.db.prepare(
      `INSERT INTO routines (id,bot_id,name,cron_expr,timezone,instruction_md,enabled,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, r.botId, r.name, r.cronExpr, r.timezone ?? 'UTC', r.instructionMd, i(r.enabled, true), now());
    return this.getRoutine(id)!;
  }
  getRoutine(id: string): Routine | null {
    const r = this.db.prepare(`SELECT * FROM routines WHERE id=?`).get(id) as Row | undefined;
    return r ? toRoutine(r) : null;
  }
  listRoutines(botId?: string): Routine[] {
    const rows = (botId
      ? this.db.prepare(`SELECT * FROM routines WHERE bot_id=? ORDER BY created_at ASC`).all(botId)
      : this.db.prepare(`SELECT * FROM routines ORDER BY created_at ASC`).all()) as Row[];
    return rows.map(toRoutine);
  }
  updateRoutine(id: string, patch: Partial<Routine>): Routine | null {
    const cur = this.getRoutine(id);
    if (!cur) return null;
    this.db.prepare(
      `UPDATE routines SET name=?,cron_expr=?,timezone=?,instruction_md=?,enabled=?,last_run_at=?,next_run_at=? WHERE id=?`,
    ).run(
      patch.name ?? cur.name, patch.cronExpr ?? cur.cronExpr, patch.timezone ?? cur.timezone,
      patch.instructionMd ?? cur.instructionMd, i(patch.enabled, cur.enabled),
      patch.lastRunAt !== undefined ? patch.lastRunAt : cur.lastRunAt,
      patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt, id,
    );
    return this.getRoutine(id);
  }
  deleteRoutine(id: string): void {
    this.db.prepare(`DELETE FROM routines WHERE id=?`).run(id);
    this.db.prepare(`DELETE FROM routine_runs WHERE routine_id=?`).run(id);
  }

  startRun(routineId: string, isTest = false, threadId?: string): RoutineRun {
    const id = newId();
    this.db.prepare(
      `INSERT INTO routine_runs (id,routine_id,started_at,status,summary,thread_id,is_test) VALUES (?,?,?,'running','',?,?)`,
    ).run(id, routineId, now(), threadId ?? null, i(isTest));
    return this.getRun(id)!;
  }
  finishRun(id: string, status: 'ok' | 'failed' | 'interrupted', summary: string): RoutineRun | null {
    this.db.prepare(`UPDATE routine_runs SET finished_at=?, status=?, summary=? WHERE id=?`).run(now(), status, summary, id);
    const run = this.getRun(id);
    if (run) this.pruneRuns(run.routineId);
    return run;
  }
  getRun(id: string): RoutineRun | null {
    const r = this.db.prepare(`SELECT * FROM routine_runs WHERE id=?`).get(id) as Row | undefined;
    return r ? toRun(r) : null;
  }
  listRuns(routineId: string): RoutineRun[] {
    return (this.db.prepare(
      `SELECT * FROM routine_runs WHERE routine_id=? ORDER BY started_at DESC LIMIT ?`,
    ).all(routineId, LIMITS.ROUTINE_RUNS_RETAINED) as Row[]).map(toRun);
  }
  /** Keep only the N most recent run records (outline §13). */
  pruneRuns(routineId: string): void {
    this.db.prepare(
      `DELETE FROM routine_runs WHERE routine_id=? AND id NOT IN
       (SELECT id FROM routine_runs WHERE routine_id=? ORDER BY started_at DESC LIMIT ?)`,
    ).run(routineId, routineId, LIMITS.ROUTINE_RUNS_RETAINED);
  }

  /* ---- mailbox ---- */
  createMail(m: { fromBotId: string; toBotId: string; contentMd: string; hops?: number }): MailboxEntry {
    const hops = m.hops ?? 1;
    if (hops > LIMITS.MAX_BOT_TO_BOT_HOPS)
      throw new LimitError(LIMIT_ERROR.HOP_LIMIT, `Bot-to-bot hop limit (${LIMITS.MAX_BOT_TO_BOT_HOPS}) reached; a human must take the next step`);
    const id = newId();
    this.db.prepare(
      `INSERT INTO mailbox (id,from_bot_id,to_bot_id,content_md,hops,delivered,created_at) VALUES (?,?,?,?,?,0,?)`,
    ).run(id, m.fromBotId, m.toBotId, m.contentMd, hops, now());
    return toMail(this.db.prepare(`SELECT * FROM mailbox WHERE id=?`).get(id) as Row);
  }
  markDelivered(id: string): void {
    this.db.prepare(`UPDATE mailbox SET delivered=1 WHERE id=?`).run(id);
  }
  listMail(toBotId: string, onlyUndelivered = true): MailboxEntry[] {
    return (this.db.prepare(
      `SELECT * FROM mailbox WHERE to_bot_id=? ${onlyUndelivered ? 'AND delivered=0' : ''} ORDER BY created_at ASC`,
    ).all(toBotId) as Row[]).map(toMail);
  }

  /* ---- usage ---- */
  recordUsage(u: Omit<UsageRow, 'id' | 'createdAt'>): UsageRow {
    const id = newId();
    this.db.prepare(
      `INSERT INTO usage (id,bot_id,turn_id,model,input_tokens,output_tokens,cache_read_tokens,cost_estimate,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, u.botId, u.turnId, u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.costEstimate, now());
    return toUsage(this.db.prepare(`SELECT * FROM usage WHERE id=?`).get(id) as Row);
  }
  listUsage(sinceMs = 0): UsageRow[] {
    return (this.db.prepare(`SELECT * FROM usage WHERE created_at>=? ORDER BY created_at DESC`).all(sinceMs) as Row[]).map(toUsage);
  }
  tokensToday(): number {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const r = this.db.prepare(
      `SELECT COALESCE(SUM(input_tokens+output_tokens),0) t FROM usage WHERE created_at>=?`,
    ).get(start.getTime()) as Row;
    return r.t;
  }

  /* ---- settings ---- */
  getSettings(): Settings {
    const rows = this.db.prepare(`SELECT * FROM settings`).all() as Row[];
    const obj: Record<string, unknown> = {};
    for (const r of rows) obj[r.key] = JSON.parse(r.value);
    return SettingsSchema.parse(obj);
  }
  patchSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)`);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v));
    return this.getSettings();
  }

  /* ---- search ---- */
  searchMessages(q: string, limit = 40): Message[] {
    if (!q.trim()) return [];
    const escaped = `"${q.replace(/"/g, '""')}"`;
    try {
      const rows = this.db.prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
         WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
      ).all(escaped, limit) as Row[];
      return rows.map(toMessage);
    } catch {
      const rows = this.db.prepare(
        `SELECT * FROM messages WHERE content_md LIKE ? ORDER BY created_at DESC LIMIT ?`,
      ).all(`%${q}%`, limit) as Row[];
      return rows.map(toMessage);
    }
  }
}
