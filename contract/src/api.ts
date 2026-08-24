import { z } from 'zod';
import {
  BotSchema, ThreadSchema, MessageSchema, ApprovalSchema, RuleSchema,
  SkillSchema, RoutineSchema, RoutineRunSchema, UsageRowSchema, ModelTierSchema,
  ConnectorSchema, ConnectorConfigSchema, type Connector,
} from './entities.js';

export const CreateBotRequest = z.object({
  name: z.string().min(1).max(60),
  title: z.string().max(120).optional(),
  description: z.string().max(8000).optional(),
  avatarEmoji: z.string().max(8).optional(),
  modelTier: ModelTierSchema.optional(),
});
export type CreateBotRequest = z.infer<typeof CreateBotRequest>;

export const UpdateBotRequest = CreateBotRequest.partial().extend({
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  notifications: z.boolean().optional(),
});
export type UpdateBotRequest = z.infer<typeof UpdateBotRequest>;

export const CreateThreadRequest = z.object({
  kind: z.enum(['dm', 'group']),
  title: z.string().optional(),
  memberBotIds: z.array(z.string()),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

export const PostMessageRequest = z.object({
  contentMd: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  replyToId: z.string().nullable().optional(),
  /** explicit @-mention targets resolved by the client */
  mentionBotIds: z.array(z.string()).optional(),
  mentionEveryone: z.boolean().optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequest>;

export const ApprovalDecisionRequest = z.object({
  decision: z.enum(['allow', 'deny']),
  alwaysRule: z
    .object({ toolPattern: z.string(), inputPattern: z.string().default(''), scopeNote: z.string().default('') })
    .optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const CreateRuleRequest = z.object({
  kind: z.enum(['require', 'allow']),
  toolPattern: z.string().min(1),
  inputPattern: z.string().default(''),
  scopeNote: z.string().default(''),
});
export type CreateRuleRequest = z.infer<typeof CreateRuleRequest>;

export const CreateRoutineRequest = z.object({
  botId: z.string(),
  name: z.string().min(1),
  cronExpr: z.string().min(1),
  timezone: z.string().optional(),
  instructionMd: z.string().min(1),
  enabled: z.boolean().optional(),
});
export type CreateRoutineRequest = z.infer<typeof CreateRoutineRequest>;

export const CreateSkillRequest = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  bodyMd: z.string().min(1),
  source: z.enum(['user', 'taught', 'imported']).optional(),
});
export type CreateSkillRequest = z.infer<typeof CreateSkillRequest>;

export const CreateConnectorRequest = z.object({
  name: ConnectorSchema.shape.name,
  description: z.string().default(''),
  config: ConnectorConfigSchema,
  enabled: z.boolean().optional(),
});
export type CreateConnectorRequest = z.infer<typeof CreateConnectorRequest>;

/**
 * No `name`: renaming a connector renames every tool the model and the rules see
 * (`mcp__<name>__<tool>`), silently orphaning any rule written against the old one.
 * Delete and re-add instead.
 */
export const UpdateConnectorRequest = z.object({
  description: z.string().optional(),
  config: ConnectorConfigSchema.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateConnectorRequest = z.infer<typeof UpdateConnectorRequest>;

/**
 * A connector as the API returns it. `missingSecrets` names the `{{secret:…}}` references
 * that have nothing behind them — surfaced so a connector that will silently fail to mount
 * says so in the UI before a turn runs, rather than going quiet at turn time.
 */
export type ApiConnector = Connector & { missingSecrets: string[] };

/**
 * What `POST /api/connectors/:id/test` reports. Tool names and descriptions only — never config.
 *
 * `ok` means the server answered and advertised tools. It does **not** mean a bot can use them:
 * many servers list their tools to anyone and only demand credentials on the first real call, so
 * authentication is verified at mount time, not here. `authHint` carries that caveat when the
 * probe has reason to suspect it.
 */
export interface ConnectorProbeResult {
  ok: boolean;
  tools: { name: string; description: string }[];
  error?: string;
  authHint?: string;
}

/**
 * Field types, declared once and without defaults. `SettingsSchema` layers the
 * defaults on for reads; `SettingsPatchSchema` deliberately leaves them off.
 */
const settingsFields = {
  timezone: z.string(),
  maxConcurrentSessions: z.number().min(1).max(8),
  autoReviewEnabled: z.boolean(),
  theme: z.enum(['system', 'light', 'dark']),
  localExecution: z.enum(['ask', 'always', 'never']),
  dailyTokenBudget: z.number(),
  notificationsEnabled: z.boolean(),
  billingMode: z.enum(['subscription', 'api']),
  computerMode: z.enum(['host', 'container']),
};

export const SettingsSchema = z.object({
  timezone: settingsFields.timezone.default('UTC'),
  maxConcurrentSessions: settingsFields.maxConcurrentSessions.default(2),
  autoReviewEnabled: settingsFields.autoReviewEnabled.default(true),
  theme: settingsFields.theme.default('system'),
  localExecution: settingsFields.localExecution.default('ask'),
  dailyTokenBudget: settingsFields.dailyTokenBudget.default(0),
  notificationsEnabled: settingsFields.notificationsEnabled.default(true),
  billingMode: settingsFields.billingMode.default('subscription'),
  computerMode: settingsFields.computerMode.default('host'),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Body schema for `PATCH /api/settings`. It must NOT carry defaults: parsing a
 * one-field patch through a defaulted schema yields a complete object, and
 * persisting that would reset every setting the client didn't mention — including
 * `localExecution`, which is a security control (see docs/SECURITY.md).
 */
export const SettingsPatchSchema = z.object(settingsFields).partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const SearchResultSchema = z.object({
  kind: z.enum(['message', 'file', 'routine', 'bot']),
  id: z.string(),
  threadId: z.string().nullable(),
  botId: z.string().nullable(),
  title: z.string(),
  snippet: z.string(),
  createdAt: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export type ApiBot = z.infer<typeof BotSchema>;
export type ApiThread = z.infer<typeof ThreadSchema>;
export type ApiMessage = z.infer<typeof MessageSchema>;
export type ApiApproval = z.infer<typeof ApprovalSchema>;
export type ApiRule = z.infer<typeof RuleSchema>;
export type ApiSkill = z.infer<typeof SkillSchema>;
export type ApiRoutine = z.infer<typeof RoutineSchema>;
export type ApiRoutineRun = z.infer<typeof RoutineRunSchema>;
export type ApiUsageRow = z.infer<typeof UsageRowSchema>;

export interface RosterEntry { bot: ApiBot; thread: ApiThread | null; lastMessageAt: number }
export interface ThreadWithMessages { thread: ApiThread; messages: ApiMessage[] }
export interface UsageSummary {
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  byBot: Array<{ botId: string; botName: string; inputTokens: number; outputTokens: number }>;
  byDay: Array<{ day: string; inputTokens: number; outputTokens: number }>;
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number }>;
}
