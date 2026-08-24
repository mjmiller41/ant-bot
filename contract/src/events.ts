import { z } from 'zod';
import { BotStateSchema, AttentionSchema, CardSchema, MessageSchema, ApprovalSchema, RoutineRunSchema } from './entities.js';

/** Every server→client event carries {threadId, botId, seq} for ordering/reconciliation. */
const base = { seq: z.number(), threadId: z.string().nullable(), botId: z.string().nullable() };

export const ServerEventSchema = z.discriminatedUnion('type', [
  /**
   * Connection handshake. Carries the current seq so a client can detect gaps, and `epoch` —
   * an id generated once per daemon process.
   *
   * The seq counter restarts at 1 on every boot, so after a restart a client that filters on
   * "seq greater than the last one I saw" silently drops everything the new process sends while
   * its socket still reports Connected. A changed epoch is how it knows the numbering is new.
   */
  z.object({ ...base, type: z.literal('hello'), epoch: z.string() }),
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

/* ------------------------- screencast input (client → server) ------------------------- */

/**
 * Human input forwarded over the screencast websocket while a screen is taken over.
 *
 * Coordinates are **normalised** (0–1, fractions of the rendered frame) rather than pixels: the
 * screencast is capped at 1280px wide and the browser then scales the image to fit the pane, so
 * the client cannot know the page's real viewport and the server cannot know the client's. Each
 * side converts against what it does know.
 *
 * The daemon dispatches these only while `takeOver()` is active for that bot — see
 * `docs/SECURITY.md`. Input is a human acting as themselves, so it does not pass the Permission
 * Gateway; the gateway governs what *bots* do.
 */
export const ScreencastInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    action: z.enum(['move', 'down', 'up', 'wheel']),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    button: z.enum(['left', 'middle', 'right']).default('left'),
    clickCount: z.number().int().min(0).max(3).default(1),
    /** Wheel deltas, in CSS pixels. Only read for `action: 'wheel'`. */
    deltaX: z.number().default(0),
    deltaY: z.number().default(0),
  }),
  z.object({
    kind: z.literal('key'),
    action: z.enum(['down', 'up']),
    /** A KeyboardEvent.key value — Playwright's keyboard maps these to the right key codes. */
    key: z.string().min(1).max(32),
  }),
  z.object({
    kind: z.literal('text'),
    /** Committed text (IME, paste, or a printable keypress), inserted verbatim. */
    text: z.string().min(1).max(4096),
  }),
]);
export type ScreencastInput = z.infer<typeof ScreencastInputSchema>;

/** Frames the client may send on the screencast socket. */
export const ScreencastClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), input: ScreencastInputSchema }),
  /**
   * Asks for the remote page's current text selection, so the human can copy out of it.
   *
   * A round trip is needed because the two clipboards are different: pressing Ctrl+C in the
   * viewer copies whatever is selected in *your* browser (nothing — the page is a JPEG), and
   * forwarding Ctrl+C to the page would write to the headless browser's clipboard, which you
   * have no way to read. So the daemon reads the selection and hands the text back for the
   * viewer to put on your clipboard.
   */
  z.object({ type: z.literal('selection-request') }),
]);
export type ScreencastClientFrame = z.infer<typeof ScreencastClientFrameSchema>;
