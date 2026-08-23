import { describe, it, expect } from 'vitest';
import {
  BotSchema, ThreadSchema, MessageSchema, CardSchema, ApprovalSchema, RuleSchema,
  RoutineSchema, RoutineRunSchema, MailboxEntrySchema, UsageRowSchema, AttachmentSchema,
  SkillSchema, ServerEventSchema, SettingsSchema, SettingsPatchSchema,
  CreateBotRequest, CreateThreadRequest, PostMessageRequest, ApprovalDecisionRequest,
  CreateRuleRequest, CreateRoutineRequest, CreateSkillRequest,
  LIMITS, LIMIT_ERROR, LimitError,
  MODEL_TIERS, ModelTierSchema,
  ConnectorSchema, ConnectorConfigSchema, CreateConnectorRequest,
  CONNECTOR_NAME_RE, RESERVED_CONNECTOR_NAMES,
} from './index.js';

describe('entity schemas round-trip', () => {
  it('parses a bot and applies defaults', () => {
    const bot = BotSchema.parse({ id: 'b1', slug: 'scout', name: 'Scout', createdAt: 1 });
    expect(bot.modelTier).toBe('sonnet');
    expect(bot.state).toBe('idle');
    expect(bot.attention).toBe('none');
    expect(bot.avatarEmoji).toBe('🤖');
    expect(bot.pinned).toBe(false);
    expect(BotSchema.parse(bot)).toEqual(bot);
  });

  it('rejects an invalid slug', () => {
    expect(BotSchema.safeParse({ id: 'b', slug: 'Not A Slug', name: 'x', createdAt: 1 }).success).toBe(false);
    expect(BotSchema.safeParse({ id: 'b', slug: '-lead', name: 'x', createdAt: 1 }).success).toBe(false);
    expect(BotSchema.safeParse({ id: 'b', slug: 'a-b-2', name: 'x', createdAt: 1 }).success).toBe(true);
  });

  it('parses threads, messages and attachments', () => {
    const t = ThreadSchema.parse({ id: 't', kind: 'group', createdAt: 0 });
    expect(t.memberBotIds).toEqual([]);
    const m = MessageSchema.parse({ id: 'm', threadId: 't', authorKind: 'user', createdAt: 0 });
    expect(m.cards).toEqual([]);
    expect(m.streaming).toBe(false);
    const a = AttachmentSchema.parse({ id: 'a', messageId: null, path: '/x', name: 'x', mime: 'text/plain', bytes: 3, createdAt: 0 });
    expect(a.bytes).toBe(3);
  });

  it('rejects an unknown thread kind and author kind', () => {
    expect(ThreadSchema.safeParse({ id: 't', kind: 'channel', createdAt: 0 }).success).toBe(false);
    expect(MessageSchema.safeParse({ id: 'm', threadId: 't', authorKind: 'robot', createdAt: 0 }).success).toBe(false);
  });

  it('round-trips every card variant', () => {
    const cards = [
      { type: 'tool', toolName: 'Bash', summary: 'ls', status: 'ok' },
      { type: 'file', path: '/w/a.md', name: 'a.md', mime: 'text/markdown', bytes: 10 },
      { type: 'approval', approvalId: 'ap1' },
      { type: 'handoff', fromBotId: 'a', toBotId: 'b', note: 'take this' },
      { type: 'error', message: 'boom' },
    ];
    for (const c of cards) {
      const parsed = CardSchema.parse(c);
      expect(CardSchema.parse(parsed)).toEqual(parsed);
    }
    expect(CardSchema.parse(cards[1] as never)).toMatchObject({ action: 'created' });
  });

  it('rejects an unknown card type', () => {
    expect(CardSchema.safeParse({ type: 'nope' }).success).toBe(false);
  });

  it('parses approvals, rules, skills, routines, runs, mail and usage', () => {
    const ap = ApprovalSchema.parse({ id: 'a', botId: 'b', threadId: 't', toolName: 'Bash', inputSummary: 's', rawInput: {}, createdAt: 0 });
    expect(ap.status).toBe('pending');
    expect(ap.decidedBy).toBeNull();
    const r = RuleSchema.parse({ id: 'r', kind: 'require', createdAt: 0 });
    expect(r.toolPattern).toBe('*');
    expect(r.enabled).toBe(true);
    expect(SkillSchema.parse({ id: 's', slug: 'x', name: 'X', path: '/p', createdAt: 0 }).source).toBe('user');
    const ro = RoutineSchema.parse({ id: 'ro', botId: 'b', name: 'n', cronExpr: '* * * * *', instructionMd: 'do', createdAt: 0 });
    expect(ro.enabled).toBe(true);
    expect(ro.timezone).toBe('UTC');
    expect(RoutineRunSchema.parse({ id: 'run', routineId: 'ro', startedAt: 0, status: 'running' }).isTest).toBe(false);
    expect(MailboxEntrySchema.parse({ id: 'm', fromBotId: 'a', toBotId: 'b', contentMd: 'x', createdAt: 0 }).hops).toBe(1);
    expect(UsageRowSchema.parse({ id: 'u', botId: 'b', turnId: 't', model: 'sonnet', createdAt: 0 }).inputTokens).toBe(0);
  });
});

describe('server events', () => {
  const base = { seq: 1, threadId: 't', botId: 'b' };
  it('parses each event variant', () => {
    const events = [
      { ...base, type: 'hello' },
      { ...base, type: 'message.created', message: { id: 'm', threadId: 't', authorKind: 'bot', createdAt: 0 } },
      { ...base, type: 'message.delta', messageId: 'm', delta: 'hi' },
      { ...base, type: 'message.done', messageId: 'm', contentMd: 'hi' },
      { ...base, type: 'message.card', messageId: 'm', cardIndex: 0, card: { type: 'error', message: 'x' } },
      { ...base, type: 'bot.state', state: 'running', attention: 'none' },
      { ...base, type: 'usage.tick', inputTokens: 1, outputTokens: 2, model: 'sonnet' },
      { ...base, type: 'notify', title: 't', body: 'b', level: 'warn' },
      { ...base, type: 'secret.request', requestId: 'r', name: 'API_KEY', reason: 'why' },
    ];
    for (const e of events) expect(ServerEventSchema.safeParse(e).success, `${e.type} failed`).toBe(true);
  });

  it('requires seq on every event', () => {
    expect(ServerEventSchema.safeParse({ type: 'hello', threadId: null, botId: null }).success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(ServerEventSchema.safeParse({ ...base, type: 'made.up' }).success).toBe(false);
  });
});

describe('request schemas', () => {
  it('accepts minimal valid payloads', () => {
    expect(CreateBotRequest.parse({ name: 'Scout' }).name).toBe('Scout');
    expect(CreateThreadRequest.parse({ kind: 'dm', memberBotIds: ['a'] }).memberBotIds).toHaveLength(1);
    expect(PostMessageRequest.parse({ contentMd: 'hi' }).contentMd).toBe('hi');
    expect(ApprovalDecisionRequest.parse({ decision: 'allow' }).decision).toBe('allow');
    expect(CreateRuleRequest.parse({ kind: 'require', toolPattern: 'Bash' }).inputPattern).toBe('');
    expect(CreateRoutineRequest.parse({ botId: 'b', name: 'n', cronExpr: '* * * * *', instructionMd: 'x' }).botId).toBe('b');
    expect(CreateSkillRequest.parse({ name: 'S', bodyMd: 'body' }).description).toBe('');
  });

  it('rejects empty or malformed payloads', () => {
    expect(CreateBotRequest.safeParse({ name: '' }).success).toBe(false);
    expect(CreateBotRequest.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
    expect(CreateThreadRequest.safeParse({ kind: 'dm' }).success).toBe(false);
    expect(ApprovalDecisionRequest.safeParse({ decision: 'maybe' }).success).toBe(false);
    expect(CreateRoutineRequest.safeParse({ botId: 'b', name: '', cronExpr: '*', instructionMd: 'x' }).success).toBe(false);
  });

  it('carries an optional alwaysRule for "always allow"', () => {
    const d = ApprovalDecisionRequest.parse({ decision: 'allow', alwaysRule: { toolPattern: 'Bash' } });
    expect(d.alwaysRule?.inputPattern).toBe('');
  });
});

describe('settings', () => {
  it('defaults to safe values', () => {
    const s = SettingsSchema.parse({});
    expect(s.maxConcurrentSessions).toBe(LIMITS.DEFAULT_MAX_CONCURRENT_SESSIONS);
    expect(s.billingMode).toBe('subscription');
    expect(s.localExecution).toBe('ask');
    expect(s.autoReviewEnabled).toBe(true);
    expect(s.computerMode).toBe('host');
  });
  it('bounds concurrency', () => {
    expect(SettingsSchema.safeParse({ maxConcurrentSessions: 0 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ maxConcurrentSessions: 9 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ maxConcurrentSessions: 8 }).success).toBe(true);
  });

  it('a settings patch carries only the keys the client actually sent', () => {
    // SettingsSchema fills every absent key from its .default(), so parsing a patch
    // through it (even .partial()) yields a COMPLETE object — persisting that would
    // silently reset every setting the client did not mention.
    const viaFull = SettingsSchema.partial().parse({ theme: 'dark' });
    expect(Object.keys(viaFull).length).toBeGreaterThan(1); // documents why the patch schema exists

    const patch = SettingsPatchSchema.parse({ theme: 'dark' });
    expect(patch).toEqual({ theme: 'dark' });
    expect(SettingsPatchSchema.parse({})).toEqual({});
  });

  it('a settings patch still validates the values it does carry', () => {
    expect(SettingsPatchSchema.safeParse({ maxConcurrentSessions: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ maxConcurrentSessions: 9 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ localExecution: 'sometimes' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ localExecution: 'never' }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true);
  });
});

describe('limits', () => {
  it('matches the documented operational limits (outline §13)', () => {
    expect(LIMITS.MAX_BOTS_AND_GROUPS).toBe(50);
    expect(LIMITS.MIN_GROUP_MEMBERS).toBe(2);
    expect(LIMITS.MAX_GROUP_MEMBERS).toBe(6);
    expect(LIMITS.MAX_ROUTINES_PER_BOT).toBe(50);
    expect(LIMITS.ROUTINE_RUNS_RETAINED).toBe(20);
    expect(LIMITS.MAX_ATTACHMENTS_PER_MESSAGE).toBe(6);
    expect(LIMITS.MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(LIMITS.MAX_VIDEO_ATTACHMENT_BYTES).toBe(200 * 1024 * 1024);
    expect(LIMITS.TEACH_RECORDING_MAX_MS).toBe(10 * 60 * 1000);
  });
  it('LimitError carries a typed code', () => {
    const e = new LimitError(LIMIT_ERROR.GROUP_SIZE, 'too big');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('GROUP_SIZE');
    expect(e.name).toBe('LimitError');
  });
});

describe('ModelTierSchema', () => {
  it('offers fable, opus, sonnet and haiku, most capable first', () => {
    expect(MODEL_TIERS).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  // MODEL_TIERS is what both pickers render; the schema is what the API validates. If they
  // diverge, the UI offers a tier the server rejects.
  it('validates exactly the tiers the UI offers', () => {
    expect(ModelTierSchema.options).toEqual([...MODEL_TIERS]);
    for (const tier of MODEL_TIERS) expect(ModelTierSchema.parse(tier)).toBe(tier);
  });

  it('rejects anything that is not a CLI model alias', () => {
    expect(ModelTierSchema.safeParse('gpt-4').success).toBe(false);
    // A full model ID is not a tier: resolveModel passes the tier straight to `claude --model`,
    // and the schema is what keeps an API-shaped string out of that position.
    expect(ModelTierSchema.safeParse('claude-fable-5').success).toBe(false);
  });
});

describe('ConnectorConfigSchema', () => {
  it('parses a stdio connector and defaults args/env', () => {
    const c = ConnectorConfigSchema.parse({ transport: 'stdio', command: 'npx' });
    expect(c).toEqual({ transport: 'stdio', command: 'npx', args: [], env: {} });
  });

  it('parses http and sse with an optional tool allowlist', () => {
    expect(ConnectorConfigSchema.parse({ transport: 'http', url: 'https://x.dev/mcp' }))
      .toEqual({ transport: 'http', url: 'https://x.dev/mcp', headers: {} });
    const sse = ConnectorConfigSchema.parse({ transport: 'sse', url: 'https://x.dev/sse', tools: ['a'] });
    expect(sse).toMatchObject({ transport: 'sse', tools: ['a'] });
  });

  it('rejects an unknown transport and a malformed url', () => {
    expect(ConnectorConfigSchema.safeParse({ transport: 'carrier-pigeon', url: 'https://x' }).success).toBe(false);
    expect(ConnectorConfigSchema.safeParse({ transport: 'http', url: 'not a url' }).success).toBe(false);
  });

  it('requires a command for stdio', () => {
    expect(ConnectorConfigSchema.safeParse({ transport: 'stdio', command: '' }).success).toBe(false);
  });
});

describe('ConnectorSchema name rules', () => {
  const withName = (name: string) =>
    ConnectorSchema.safeParse({ id: 'c1', name, config: { transport: 'stdio', command: 'x' }, createdAt: 0 });

  it('accepts lowercase names with digits and hyphens', () => {
    for (const n of ['github', 'my-server', 'a', 'x1-2']) expect(withName(n).success).toBe(true);
  });

  // A name containing `__` would break toolNameAliases' split of mcp__<name>__<tool>, leaving the
  // connector's tools unmatchable by the very rules meant to gate them.
  it('rejects underscores, uppercase, and leading hyphens', () => {
    for (const n of ['my_server', 'a__b', 'GitHub', '-lead', '']) expect(withName(n).success).toBe(false);
  });

  it('rejects a name longer than 32 characters', () => {
    expect(withName('a'.repeat(32)).success).toBe(true);
    expect(withName('a'.repeat(33)).success).toBe(false);
  });

  // These would overwrite the built-in servers in the turn's mcpServers record.
  it('rejects the reserved built-in server names', () => {
    for (const n of RESERVED_CONNECTOR_NAMES) expect(withName(n).success).toBe(false);
  });

  it('keeps CONNECTOR_NAME_RE in step with what the schema accepts', () => {
    for (const n of ['ok-1', 'bad_name', 'UPPER']) {
      expect(withName(n).success).toBe(CONNECTOR_NAME_RE.test(n));
    }
  });

  it('defaults description and enabled', () => {
    const c = ConnectorSchema.parse({ id: 'c1', name: 'gh', config: { transport: 'stdio', command: 'x' }, createdAt: 0 });
    expect(c).toMatchObject({ description: '', enabled: true });
  });
});

describe('CreateConnectorRequest', () => {
  it('accepts a minimal body', () => {
    expect(CreateConnectorRequest.parse({ name: 'gh', config: { transport: 'stdio', command: 'npx' } }))
      .toMatchObject({ name: 'gh', description: '' });
  });

  it('applies the same name rules as the entity', () => {
    expect(CreateConnectorRequest.safeParse({ name: 'antbot', config: { transport: 'stdio', command: 'x' } }).success).toBe(false);
  });
});
