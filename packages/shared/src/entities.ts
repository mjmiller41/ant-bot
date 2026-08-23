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

export const ModelTierSchema = z.enum(['sonnet', 'opus', 'haiku']);
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
