import { z } from 'zod';

export const BotStateSchema = z.enum([
  'idle',
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'interrupted',
]);
export type BotState = z.infer<typeof BotStateSchema>;

export const AttentionSchema = z.enum(['none', 'unread', 'needs_attention']);
export type Attention = z.infer<typeof AttentionSchema>;

/**
 * Model tiers a Bot can run on, ordered most to least capable — this is also the order the UI
 * renders them in, so both pickers stay consistent without repeating the list.
 *
 * Each value is a `claude` CLI model alias, passed through verbatim by `resolveModel()`. Adding a
 * tier here means adding an alias the CLI accepts (`claude --model`), not an API model ID.
 */
export const MODEL_TIERS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const ModelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const BotSchema = z.object({
  id: z.string(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(60),
  title: z.string().max(120).default(''),
  description: z.string().max(8000).default(''),
  avatarEmoji: z.string().max(8).default('🤖'),
  modelTier: ModelTierSchema.default('sonnet'),
  pinned: z.boolean().default(false),
  hidden: z.boolean().default(false),
  notifications: z.boolean().default(true),
  sessionId: z.string().nullable().default(null),
  state: BotStateSchema.default('idle'),
  attention: AttentionSchema.default('none'),
  threadId: z.string().nullable().default(null),
  createdAt: z.number(),
  deletedAt: z.number().nullable().default(null),
});
export type Bot = z.infer<typeof BotSchema>;

export const ThreadKindSchema = z.enum(['dm', 'group']);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

export const ThreadSchema = z.object({
  id: z.string(),
  kind: ThreadKindSchema,
  title: z.string().default(''),
  memberBotIds: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  hidden: z.boolean().default(false),
  lastReadAt: z.number().default(0),
  createdAt: z.number(),
});
export type Thread = z.infer<typeof ThreadSchema>;

/** Cards render structured, non-prose content inside a message. */
export const CardSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool'),
    toolName: z.string(),
    summary: z.string(),
    input: z.unknown().optional(),
    result: z.string().optional(),
    status: z.enum(['running', 'ok', 'error', 'denied']),
  }),
  z.object({
    type: z.literal('file'),
    path: z.string(),
    name: z.string(),
    mime: z.string(),
    bytes: z.number(),
    action: z.enum(['created', 'modified']).default('created'),
  }),
  z.object({ type: z.literal('approval'), approvalId: z.string() }),
  z.object({ type: z.literal('handoff'), fromBotId: z.string(), toBotId: z.string(), note: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  /** A connector asked for a sign-in mid-turn. The link is the provider's; the bot never sees it. */
  z.object({ type: z.literal('signin'), serverName: z.string(), url: z.string() }),
]);
export type Card = z.infer<typeof CardSchema>;

export const AuthorKindSchema = z.enum(['user', 'bot', 'system']);
export type AuthorKind = z.infer<typeof AuthorKindSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  authorKind: AuthorKindSchema,
  authorBotId: z.string().nullable().default(null),
  replyToId: z.string().nullable().default(null),
  contentMd: z.string().default(''),
  cards: z.array(CardSchema).default([]),
  streaming: z.boolean().default(false),
  createdAt: z.number(),
});
export type Message = z.infer<typeof MessageSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  messageId: z.string().nullable(),
  path: z.string(),
  name: z.string(),
  mime: z.string(),
  bytes: z.number(),
  createdAt: z.number(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'allowed', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  botId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  inputSummary: z.string(),
  rawInput: z.unknown(),
  status: ApprovalStatusSchema.default('pending'),
  decidedBy: z.enum(['user', 'rule', 'auto_review']).nullable().default(null),
  reason: z.string().default(''),
  ruleId: z.string().nullable().default(null),
  createdAt: z.number(),
  decidedAt: z.number().nullable().default(null),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const RuleKindSchema = z.enum(['require', 'allow']);
export type RuleKind = z.infer<typeof RuleKindSchema>;

export const RuleSchema = z.object({
  id: z.string(),
  kind: RuleKindSchema,
  /** Glob over tool name, e.g. "Bash", "browser_*", "*" */
  toolPattern: z.string().default('*'),
  /** Optional regex tested against the serialized tool input. */
  inputPattern: z.string().default(''),
  scopeNote: z.string().default(''),
  builtin: z.boolean().default(false),
  enabled: z.boolean().default(true),
  createdAt: z.number(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().default(''),
  path: z.string(),
  source: z.enum(['user', 'taught', 'imported']).default('user'),
  createdAt: z.number(),
});
export type Skill = z.infer<typeof SkillSchema>;

/* ------------------------------ MCP connectors ------------------------------ */

/**
 * Connector names become the middle segment of every tool name the model sees:
 * `mcp__<name>__<tool>`. Underscores are banned outright because `toolNameAliases()`
 * splits on the first `__` pair — a name containing one would make a connector's tools
 * unmatchable by the rules that are supposed to gate them.
 */
export const CONNECTOR_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Taken by the built-in servers; a connector using one would overwrite it in the turn's server map. */
export const RESERVED_CONNECTOR_NAMES = ['antbot', 'browser'] as const;

/**
 * How to reach an MCP server. Mirrors the Agent SDK's own `McpServerConfig` minus the
 * in-process `sdk` variant, which only the built-in servers use.
 *
 * Secret values are never stored here. An env value or header may embed `{{secret:NAME}}`,
 * resolved against the keychain at mount time — see `daemon/src/bots/connectors.ts`.
 */
export const ConnectorConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    /** Optional allowlist passed through to the SDK. Omit to expose every tool the server offers. */
    tools: z.array(z.string()).optional(),
  }),
  z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    tools: z.array(z.string()).optional(),
  }),
]);
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export const ConnectorSchema = z.object({
  id: z.string(),
  name: z
    .string()
    .regex(CONNECTOR_NAME_RE, 'lowercase letters, digits and hyphens only, max 32 characters')
    .refine((n) => !(RESERVED_CONNECTOR_NAMES as readonly string[]).includes(n), {
      message: `"antbot" and "browser" are reserved for the built-in servers`,
    }),
  description: z.string().default(''),
  /** Account-wide switch. A disabled connector mounts for nobody, whatever the assignments say. */
  enabled: z.boolean().default(true),
  /**
   * `builtin` — served by the daemon itself (Gmail…), credentials held by the daemon, config
   * points at the daemon's own `/mcp/<name>`. `custom` — a command or URL the user added.
   */
  kind: z.enum(['custom', 'builtin']).default('custom'),
  config: ConnectorConfigSchema,
  /** Last verdict from a check or a turn: ready | needs-sign-in | needs-credential | unreachable | connected | failed… */
  lastStatus: z.string().nullable().default(null),
  lastError: z.string().nullable().default(null),
  checkedAt: z.number().nullable().default(null),
  createdAt: z.number(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

/** The verdict `POST /api/connectors/:id/check` returns, and what `add` prints. */
export const ConnectorCheckSchema = z.object({
  status: z.enum(['ready', 'needs-sign-in', 'needs-credential', 'unreachable']),
  /** For needs-sign-in: whether the provider lets ant-bot register itself (no client ID needed). */
  selfRegistration: z.boolean().optional(),
  /** Who is asking for the sign-in, when known — "Google", "accounts.example.com". */
  provider: z.string().optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
  detail: z.string().optional(),
  /**
   * A built-in that does the same job, when the URL is a provider's own MCP endpoint that admits
   * only clients the provider allowlisted (Google). Sign-in there can succeed and every call
   * still be refused, so the honest verdict names the way that works.
   */
  alternative: z.string().optional(),
});
export type ConnectorCheck = z.infer<typeof ConnectorCheckSchema>;

export const RoutineSchema = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string().min(1),
  cronExpr: z.string(),
  timezone: z.string().default('UTC'),
  instructionMd: z.string(),
  enabled: z.boolean().default(true),
  lastRunAt: z.number().nullable().default(null),
  nextRunAt: z.number().nullable().default(null),
  createdAt: z.number(),
});
export type Routine = z.infer<typeof RoutineSchema>;

export const RoutineRunSchema = z.object({
  id: z.string(),
  routineId: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable().default(null),
  status: z.enum(['running', 'ok', 'failed', 'interrupted']),
  summary: z.string().default(''),
  threadId: z.string().nullable().default(null),
  isTest: z.boolean().default(false),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

export const MailboxEntrySchema = z.object({
  id: z.string(),
  fromBotId: z.string(),
  toBotId: z.string(),
  contentMd: z.string(),
  hops: z.number().default(1),
  delivered: z.boolean().default(false),
  createdAt: z.number(),
});
export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;

export const UsageRowSchema = z.object({
  id: z.string(),
  botId: z.string(),
  turnId: z.string(),
  model: z.string(),
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  costEstimate: z.number().default(0),
  createdAt: z.number(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;

export const TurnOriginSchema = z.enum(['user', 'bot', 'routine', 'system']);
export type TurnOrigin = z.infer<typeof TurnOriginSchema>;
