import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from './db.js';
import { Store } from './store.js';
import { LIMITS, LIMIT_ERROR, LimitError, type Card } from '@antbot/shared';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(openDb(':memory:'));
  });

  /* ---------------------------- bots: basic CRUD --------------------------- */
  describe('bots', () => {
    it('createBot auto-creates a DM thread and a unique slug', () => {
      const b1 = store.createBot({ name: 'Assistant' });
      expect(b1.slug).toBe('assistant');
      expect(b1.threadId).toBeTruthy();
      const thread = store.getThread(b1.threadId!);
      expect(thread?.kind).toBe('dm');
      expect(thread?.memberBotIds).toEqual([b1.id]);
    });

    it('duplicate names get -2, -3 slug suffixes', () => {
      const b1 = store.createBot({ name: 'Assistant' });
      const b2 = store.createBot({ name: 'Assistant' });
      const b3 = store.createBot({ name: 'Assistant' });
      expect(b1.slug).toBe('assistant');
      expect(b2.slug).toBe('assistant-2');
      expect(b3.slug).toBe('assistant-3');
    });

    it('getBot / getBotBySlug / listBots / updateBot round-trip', () => {
      const bot = store.createBot({ name: 'Ops Bot', title: 'Ops' });
      expect(store.getBot(bot.id)?.name).toBe('Ops Bot');
      expect(store.getBotBySlug(bot.slug)?.id).toBe(bot.id);
      expect(store.listBots().some((b) => b.id === bot.id)).toBe(true);
      const updated = store.updateBot(bot.id, { title: 'New Title', pinned: true });
      expect(updated?.title).toBe('New Title');
      expect(updated?.pinned).toBe(true);
      expect(store.updateBot('nonexistent', { title: 'x' })).toBeNull();
    });

    it('listBots(false) excludes hidden bots', () => {
      const visible = store.createBot({ name: 'Visible' });
      const hidden = store.createBot({ name: 'Hidden' });
      store.updateBot(hidden.id, { hidden: true });
      const list = store.listBots(false);
      expect(list.some((b) => b.id === visible.id)).toBe(true);
      expect(list.some((b) => b.id === hidden.id)).toBe(false);
    });

    it('deleteBot is a soft delete: row remains with deleted_at, routines and thread removed, getBot returns null', () => {
      const bot = store.createBot({ name: 'ToDelete' });
      store.createRoutine({ botId: bot.id, name: 'r1', cronExpr: '* * * * *', instructionMd: 'x' });
      const threadId = bot.threadId!;
      store.deleteBot(bot.id);

      expect(store.getBot(bot.id)).toBeNull();

      const raw = store.db.prepare('SELECT * FROM bots WHERE id=?').get(bot.id) as Record<string, unknown> | undefined;
      expect(raw).toBeTruthy();
      expect(raw!.deleted_at).not.toBeNull();

      expect(store.listRoutines(bot.id).length).toBe(0);
      expect(store.getThread(threadId)).toBeNull();
    });

    it('duplicateBot copies profile, skills and routines but NOT history or memory; names it "<name> copy"; copied routines are disabled', () => {
      const bot = store.createBot({ name: 'Assistant', title: 'T', description: 'D' });
      const skill = store.createSkill({ slug: 'sk1', name: 'Skill One', path: '/skills/sk1' });
      store.setBotSkills(bot.id, [skill.id]);
      store.createRoutine({ botId: bot.id, name: 'r1', cronExpr: '* * * * *', instructionMd: 'do x', enabled: true });
      store.createMessage({ threadId: bot.threadId!, authorKind: 'user', contentMd: 'hello history' });

      const copy = store.duplicateBot(bot.id)!;
      expect(copy.id).not.toBe(bot.id);
      expect(copy.name).toBe('Assistant copy');
      expect(copy.title).toBe('T');
      expect(copy.description).toBe('D');

      const copySkills = store.listBotSkills(copy.id);
      expect(copySkills.map((s) => s.slug)).toContain('sk1');

      const copyRoutines = store.listRoutines(copy.id);
      expect(copyRoutines.length).toBe(1);
      expect(copyRoutines[0].name).toBe('r1');
      expect(copyRoutines[0].enabled).toBe(false);

      expect(copy.threadId).not.toBe(bot.threadId);
      expect(store.listMessages(copy.threadId!).length).toBe(0);

      expect(store.duplicateBot('nonexistent')).toBeNull();
    });
  });

  describe('LIMITS.MAX_BOTS_AND_GROUPS (50, combined bots + groups)', () => {
    it('throws TOO_MANY_BOTS once 50 bots exist', () => {
      for (let i = 0; i < 50; i++) store.createBot({ name: `bot${i}` });
      expect(() => store.createBot({ name: 'overflow' })).toThrow(LimitError);
      try {
        store.createBot({ name: 'overflow2' });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LimitError);
        expect((e as LimitError).code).toBe(LIMIT_ERROR.TOO_MANY_BOTS);
      }
    });

    it('counts bots and group threads together', () => {
      for (let i = 0; i < 49; i++) store.createBot({ name: `bot${i}` });
      // 49 bots + 1 group = 50
      store.createThread({ kind: 'group', memberBotIds: ['x', 'y'] });
      expect(store.countBotsAndGroups()).toBe(50);
      expect(() => store.createThread({ kind: 'group', memberBotIds: ['x', 'y'] })).toThrow(LimitError);
      try {
        store.createThread({ kind: 'group', memberBotIds: ['x', 'y'] });
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as LimitError).code).toBe(LIMIT_ERROR.TOO_MANY_BOTS);
      }
    });
  });

  describe('group size 2-6 enforced', () => {
    it('throws GROUP_SIZE at 1 member', () => {
      try {
        store.createThread({ kind: 'group', memberBotIds: ['a'] });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LimitError);
        expect((e as LimitError).code).toBe(LIMIT_ERROR.GROUP_SIZE);
      }
    });

    it('throws GROUP_SIZE at 7 members', () => {
      try {
        store.createThread({ kind: 'group', memberBotIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as LimitError).code).toBe(LIMIT_ERROR.GROUP_SIZE);
      }
    });

    it('succeeds at 2 members', () => {
      const t = store.createThread({ kind: 'group', memberBotIds: ['a', 'b'] });
      expect(t.kind).toBe('group');
      expect(t.memberBotIds.length).toBe(2);
    });

    it('succeeds at 6 members', () => {
      const t = store.createThread({ kind: 'group', memberBotIds: ['a', 'b', 'c', 'd', 'e', 'f'] });
      expect(t.memberBotIds.length).toBe(6);
    });
  });

  /* -------------------------------- threads -------------------------------- */
  describe('threads', () => {
    it('create/get/list/update/delete', () => {
      const t = store.createThread({ kind: 'dm', title: 'DM', memberBotIds: ['a'] });
      expect(store.getThread(t.id)?.title).toBe('DM');
      expect(store.listThreads('dm').some((x) => x.id === t.id)).toBe(true);
      const updated = store.updateThread(t.id, { title: 'Renamed', pinned: true });
      expect(updated?.title).toBe('Renamed');
      expect(updated?.pinned).toBe(true);
      store.deleteThread(t.id);
      expect(store.getThread(t.id)).toBeNull();
      expect(store.updateThread('nonexistent', { title: 'x' })).toBeNull();
    });
  });

  /* -------------------------------- messages -------------------------------- */
  describe('messages', () => {
    it('create/get/list/update, lastMessageAt', () => {
      const bot = store.createBot({ name: 'MsgBot' });
      const msg = store.createMessage({ threadId: bot.threadId!, authorKind: 'user', contentMd: 'hi' });
      expect(store.getMessage(msg.id)?.contentMd).toBe('hi');
      expect(store.listMessages(bot.threadId!).length).toBe(1);
      const updated = store.updateMessage(msg.id, { contentMd: 'bye' });
      expect(updated?.contentMd).toBe('bye');
      expect(store.lastMessageAt(bot.threadId!)).toBeGreaterThan(0);
      expect(store.getMessage('nonexistent')).toBeNull();
    });

    it('appendCard returns the new index; updateCard replaces in place; out-of-range index is a no-op', () => {
      const bot = store.createBot({ name: 'CardBot' });
      const msg = store.createMessage({ threadId: bot.threadId!, authorKind: 'bot', authorBotId: bot.id, contentMd: '' });
      const card1: Card = { type: 'error', message: 'e1' };
      const idx0 = store.appendCard(msg.id, card1);
      expect(idx0).toBe(0);
      const card2: Card = { type: 'error', message: 'e2' };
      const idx1 = store.appendCard(msg.id, card2);
      expect(idx1).toBe(1);

      const replaced: Card = { type: 'error', message: 'replaced' };
      store.updateCard(msg.id, 0, replaced);
      let after = store.getMessage(msg.id)!;
      expect(after.cards[0]).toEqual(replaced);
      expect(after.cards[1]).toEqual(card2);

      store.updateCard(msg.id, 99, { type: 'error', message: 'noop' });
      after = store.getMessage(msg.id)!;
      expect(after.cards.length).toBe(2);
      expect(after.cards[1]).toEqual(card2);

      expect(store.appendCard('nonexistent', card1)).toBe(-1);
    });
  });

  /* ------------------------------ attachments ------------------------------ */
  describe('attachments', () => {
    it('rejects >25MB non-video attachments (ATTACHMENT_TOO_LARGE)', () => {
      try {
        store.createAttachment({
          messageId: null, path: '/x', name: 'f.bin', mime: 'application/octet-stream',
          bytes: LIMITS.MAX_ATTACHMENT_BYTES + 1,
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LimitError);
        expect((e as LimitError).code).toBe(LIMIT_ERROR.ATTACHMENT_TOO_LARGE);
      }
    });

    it('accepts a 30MB video/mp4 (under the video cap, over the normal cap)', () => {
      const a = store.createAttachment({
        messageId: null, path: '/x', name: 'v.mp4', mime: 'video/mp4', bytes: 30 * 1024 * 1024,
      });
      expect(a.bytes).toBe(30 * 1024 * 1024);
      expect(a.mime).toBe('video/mp4');
    });

    it('rejects >200MB video attachments', () => {
      try {
        store.createAttachment({
          messageId: null, path: '/x', name: 'v.mp4', mime: 'video/mp4',
          bytes: LIMITS.MAX_VIDEO_ATTACHMENT_BYTES + 1,
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as LimitError).code).toBe(LIMIT_ERROR.ATTACHMENT_TOO_LARGE);
      }
    });

    it('attachToMessage with 7 ids throws TOO_MANY_ATTACHMENTS', () => {
      const bot = store.createBot({ name: 'AttBot' });
      const msg = store.createMessage({ threadId: bot.threadId!, authorKind: 'user', contentMd: 'x' });
      const ids = Array.from({ length: 7 }, (_, i) =>
        store.createAttachment({ messageId: null, path: `/x${i}`, name: `f${i}.txt`, mime: 'text/plain', bytes: 10 }).id,
      );
      try {
        store.attachToMessage(ids, msg.id);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LimitError);
        expect((e as LimitError).code).toBe(LIMIT_ERROR.TOO_MANY_ATTACHMENTS);
      }
    });

    it('attachToMessage / getAttachment / listAttachmentsForMessage', () => {
      const bot = store.createBot({ name: 'AttBot2' });
      const msg = store.createMessage({ threadId: bot.threadId!, authorKind: 'user', contentMd: 'x' });
      const a = store.createAttachment({ messageId: null, path: '/f', name: 'f.txt', mime: 'text/plain', bytes: 10 });
      store.attachToMessage([a.id], msg.id);
      expect(store.getAttachment(a.id)?.messageId).toBe(msg.id);
      expect(store.listAttachmentsForMessage(msg.id).length).toBe(1);
    });
  });

  /* ------------------------------- approvals -------------------------------- */
  describe('approvals', () => {
    it('create/get/listPending/resolve', () => {
      const a = store.createApproval({ botId: 'b1', threadId: 't1', toolName: 'Bash', inputSummary: 'run x', rawInput: { command: 'x' } });
      expect(store.getApproval(a.id)?.status).toBe('pending');
      expect(store.listPendingApprovals().length).toBe(1);
      const resolved = store.resolveApproval(a.id, 'allowed', 'user');
      expect(resolved?.status).toBe('allowed');
      expect(store.listPendingApprovals().length).toBe(0);
      expect(store.resolveApproval('nonexistent', 'allowed', 'user')).toBeNull();
    });
  });

  /* ---------------------------------- rules ---------------------------------- */
  describe('rules', () => {
    it('create/get/list/setEnabled', () => {
      const r = store.createRule({ kind: 'allow', toolPattern: 'Read' });
      expect(store.getRule(r.id)?.enabled).toBe(true);
      store.setRuleEnabled(r.id, false);
      expect(store.getRule(r.id)?.enabled).toBe(false);
      expect(store.listRules(true).some((x) => x.id === r.id)).toBe(false);
      expect(store.listRules(false).some((x) => x.id === r.id)).toBe(true);
    });

    it('deleteRule refuses to delete builtin rules but deletes normal rules', () => {
      const builtin = store.createRule({ kind: 'allow', toolPattern: 'Read', builtin: true });
      store.deleteRule(builtin.id);
      expect(store.getRule(builtin.id)).not.toBeNull();

      const normal = store.createRule({ kind: 'allow', toolPattern: 'X' });
      store.deleteRule(normal.id);
      expect(store.getRule(normal.id)).toBeNull();
    });
  });

  /* ---------------------------------- skills ---------------------------------- */
  describe('skills', () => {
    it('create/get/getBySlug/list/delete/setBotSkills/listBotSkills', () => {
      const s = store.createSkill({ slug: 'a', name: 'A', path: '/a' });
      expect(store.getSkill(s.id)?.slug).toBe('a');
      expect(store.getSkillBySlug('a')?.id).toBe(s.id);
      expect(store.listSkills().length).toBe(1);

      const bot = store.createBot({ name: 'SkillBot' });
      store.setBotSkills(bot.id, [s.id]);
      expect(store.listBotSkills(bot.id).map((x) => x.slug)).toEqual(['a']);

      store.deleteSkill(s.id);
      expect(store.getSkill(s.id)).toBeNull();
      expect(store.listBotSkills(bot.id).length).toBe(0);
    });
  });

  /* --------------------------------- routines --------------------------------- */
  describe('routines', () => {
    it('create/get/list/update/delete', () => {
      const bot = store.createBot({ name: 'RoutineBot' });
      const r = store.createRoutine({ botId: bot.id, name: 'r1', cronExpr: '* * * * *', instructionMd: 'x' });
      expect(store.getRoutine(r.id)?.name).toBe('r1');
      const updated = store.updateRoutine(r.id, { name: 'r2', enabled: false });
      expect(updated?.name).toBe('r2');
      expect(updated?.enabled).toBe(false);
      expect(store.listRoutines(bot.id).length).toBe(1);
      store.deleteRoutine(r.id);
      expect(store.getRoutine(r.id)).toBeNull();
    });

    it('MAX_ROUTINES_PER_BOT (50) throws TOO_MANY_ROUTINES', () => {
      const bot = store.createBot({ name: 'RoutineLimitBot' });
      for (let i = 0; i < 50; i++) store.createRoutine({ botId: bot.id, name: `r${i}`, cronExpr: '* * * * *', instructionMd: 'x' });
      try {
        store.createRoutine({ botId: bot.id, name: 'overflow', cronExpr: '* * * * *', instructionMd: 'x' });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LimitError);
        expect((e as LimitError).code).toBe(LIMIT_ERROR.TOO_MANY_ROUTINES);
      }
    });
  });

  /* ----------------------------- routine runs ----------------------------- */
  describe('routine runs', () => {
    it('pruneRuns keeps exactly the 20 most recent runs; listRuns returns newest-first', () => {
      const bot = store.createBot({ name: 'RunBot' });
      const routine = store.createRoutine({ botId: bot.id, name: 'r', cronExpr: '* * * * *', instructionMd: 'x' });
      const base = 1_000_000;
      for (let i = 0; i < 25; i++) {
        const run = store.startRun(routine.id);
        store.db.prepare('UPDATE routine_runs SET started_at=? WHERE id=?').run(base + i, run.id);
        store.finishRun(run.id, 'ok', `run-${i}`);
      }
      const all = store.db.prepare('SELECT COUNT(*) c FROM routine_runs WHERE routine_id=?').get(routine.id) as { c: number };
      expect(all.c).toBe(20);

      const runs = store.listRuns(routine.id);
      expect(runs.length).toBe(20);
      expect(runs[0].summary).toBe('run-24');
      expect(runs[runs.length - 1].summary).toBe('run-5');
      for (let i = 1; i < runs.length; i++) expect(runs[i - 1].startedAt).toBeGreaterThanOrEqual(runs[i].startedAt);
    });
  });

  /* --------------------------------- mailbox --------------------------------- */
  describe('mailbox', () => {
    it('createMail/markDelivered/listMail', () => {
      const m = store.createMail({ fromBotId: 'a', toBotId: 'b', contentMd: 'hi' });
      expect(store.listMail('b').length).toBe(1);
      store.markDelivered(m.id);
      expect(store.listMail('b').length).toBe(0);
      expect(store.listMail('b', false).length).toBe(1);
    });

    it('MAX_BOT_TO_BOT_HOPS (5) throws HOP_LIMIT', () => {
      const ok = store.createMail({ fromBotId: 'a', toBotId: 'b', contentMd: 'hi', hops: LIMITS.MAX_BOT_TO_BOT_HOPS });
      expect(ok.hops).toBe(5);
      try {
        store.createMail({ fromBotId: 'a', toBotId: 'b', contentMd: 'hi', hops: LIMITS.MAX_BOT_TO_BOT_HOPS + 1 });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LimitError);
        expect((e as LimitError).code).toBe(LIMIT_ERROR.HOP_LIMIT);
      }
    });
  });

  /* ---------------------------------- usage ---------------------------------- */
  describe('usage', () => {
    it('recordUsage/listUsage', () => {
      const bot = store.createBot({ name: 'UsageBot' });
      store.recordUsage({ botId: bot.id, turnId: 't1', model: 'sonnet', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, costEstimate: 0.01 });
      expect(store.listUsage().length).toBe(1);
    });

    it('tokensToday sums only rows from today, excluding older rows', () => {
      const bot = store.createBot({ name: 'UsageBot2' });
      store.recordUsage({ botId: bot.id, turnId: 't1', model: 'sonnet', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, costEstimate: 0 });

      const oldTime = Date.now() - 1000 * 60 * 60 * 24 * 2; // 2 days ago
      store.db.prepare(
        `INSERT INTO usage (id,bot_id,turn_id,model,input_tokens,output_tokens,cache_read_tokens,cost_estimate,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run('old-id', bot.id, 't-old', 'sonnet', 9999, 9999, 0, 0, oldTime);

      expect(store.tokensToday()).toBe(150);
    });
  });

  /* -------------------------------- settings -------------------------------- */
  describe('settings', () => {
    it('getSettings returns schema defaults on an empty table', () => {
      const s = store.getSettings();
      expect(s.timezone).toBe('UTC');
      expect(s.autoReviewEnabled).toBe(true);
      expect(s.billingMode).toBe('subscription');
      expect(s.maxConcurrentSessions).toBe(2);
    });

    it('patchSettings round-trips and merges with prior patches', () => {
      store.patchSettings({ timezone: 'America/New_York' });
      let s = store.getSettings();
      expect(s.timezone).toBe('America/New_York');
      expect(s.autoReviewEnabled).toBe(true);

      store.patchSettings({ autoReviewEnabled: false });
      s = store.getSettings();
      expect(s.timezone).toBe('America/New_York');
      expect(s.autoReviewEnabled).toBe(false);
    });
  });

  /* -------------------------------- search -------------------------------- */
  describe('searchMessages', () => {
    it('finds content via FTS', () => {
      const bot = store.createBot({ name: 'SearchBot' });
      store.createMessage({ threadId: bot.threadId!, authorKind: 'user', contentMd: 'the quick brown fox' });
      const results = store.searchMessages('quick');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].contentMd).toContain('quick');
    });

    it('tolerates FTS-hostile input without throwing', () => {
      const bot = store.createBot({ name: 'SearchBot2' });
      store.createMessage({ threadId: bot.threadId!, authorKind: 'user', contentMd: 'hello world' });
      for (const q of ['"', '*', 'AND', '']) {
        expect(() => store.searchMessages(q)).not.toThrow();
      }
      expect(store.searchMessages('')).toEqual([]);
    });
  });
});

describe('updateSkill', () => {
  const freshStore = (): Store => new Store(openDb(':memory:'));

  it('keeps the skill id so bot assignments survive a re-install', () => {
    const store = freshStore();
    const bot = store.createBot({ name: 'Scout' });
    const skill = store.createSkill({ slug: 'pdf', name: 'PDF', description: 'old', path: '/a' });
    store.setBotSkills(bot.id, [skill.id]);

    const updated = store.updateSkill(skill.id, { name: 'PDF', description: 'new' });

    expect(updated!.id).toBe(skill.id);
    expect(updated!.description).toBe('new');
    expect(store.listBotSkills(bot.id).map((s) => s.id)).toEqual([skill.id]);
  });

  it('returns null for an unknown skill', () => {
    expect(freshStore().updateSkill('nope', { name: 'x' })).toBeNull();
  });
});
