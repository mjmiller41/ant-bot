import { z } from 'zod';
import { BotStateSchema, AttentionSchema, CardSchema, MessageSchema, ApprovalSchema, RoutineRunSchema } from './entities.js';

/** Every server→client event carries {threadId, botId, seq} for ordering/reconciliation. */
const base = { seq: z.number(), threadId: z.string().nullable(), botId: z.string().nullable() };

export const ServerEventSchema = z.discriminatedUnion('type', [
  /** Connection handshake. Carries the current seq so a client can detect gaps. */
  z.object({ ...base, type: z.literal('hello') }),
  z.object({ ...base, type: z.literal('message.created'), message: MessageSchema }),
  z.object({ ...base, type: z.literal('message.delta'), messageId: z.string(), delta: z.string() }),
  z.object({ ...base, type: z.literal('message.done'), messageId: z.string(), contentMd: z.string() }),
  z.object({ ...base, type: z.literal('message.card'), messageId: z.string(), card: CardSchema, cardIndex: z.number() }),
  z.object({ ...base, type: z.literal('bot.state'), state: BotStateSchema, attention: AttentionSchema }),
  z.object({ ...base, type: z.literal('approval.pending'), approval: ApprovalSchema }),
  z.object({ ...base, type: z.literal('approval.resolved'), approval: ApprovalSchema }),
  z.object({ ...base, type: z.literal('routine.run'), run: RoutineRunSchema }),
  z.object({ ...base, type: z.literal('usage.tick'), inputTokens: z.number(), outputTokens: z.number(), model: z.string() }),
  z.object({ ...base, type: z.literal('notify'), title: z.string(), body: z.string(), level: z.enum(['info', 'warn', 'error']) }),
  z.object({ ...base, type: z.literal('secret.request'), requestId: z.string(), name: z.string(), reason: z.string() }),
  z.object({ ...base, type: z.literal('thread.updated'), threadId2: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];
