import { create } from 'zustand';
import type {
  RosterEntry,
  Thread,
  Message,
  Approval,
  RoutineRun,
  Settings,
  ServerEvent,
  ApprovalDecisionRequest,
} from '@antbot/contract';
import { api } from '../api/client.js';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'warn' | 'error';
  ts: number;
}

export interface SecretRequestItem {
  requestId: string;
  name: string;
  reason: string;
}

export interface StoreState {
  bots: RosterEntry[];
  threads: Record<string, Thread>;
  messagesByThread: Record<string, Message[]>;
  activeThreadId: string | null;
  pendingApprovals: Approval[];
  settings: Settings | null;
  connection: ConnectionState;
  lastSeq: number;
  usageTotals: { inputTokens: number; outputTokens: number };
  notifications: NotificationItem[];
  secretRequests: SecretRequestItem[];
  routineRuns: Record<string, RoutineRun[]>;

  setBots: (bots: RosterEntry[]) => void;
  setThreads: (threads: Thread[]) => void;
  upsertThread: (thread: Thread) => void;
  setThreadMessages: (threadId: string, messages: Message[]) => void;
  /** Bumped when a thread's transcript changes wholesale (today: "Start fresh"). */
  threadEpoch: number;
  /** Optimistically appends/replaces a message outside the seq-ordered event stream
   *  (e.g. the REST response for a message the user just sent). */
  appendLocalMessage: (threadId: string, message: Message) => void;
  setActiveThreadId: (id: string | null) => void;
  setPendingApprovals: (approvals: Approval[]) => void;
  setSettings: (settings: Settings) => void;
  setConnection: (connection: ConnectionState) => void;
  dismissNotification: (id: string) => void;
  resolveSecretRequest: (requestId: string) => void;
  decideApproval: (id: string, body: ApprovalDecisionRequest) => Promise<void>;
  handleServerEvent: (event: ServerEvent) => void;
}

function findMessage(messages: Message[] | undefined, id: string): number {
  if (!messages) return -1;
  return messages.findIndex((m) => m.id === id);
}

export const useStore = create<StoreState>((set, get) => ({
  bots: [],
  threads: {},
  messagesByThread: {},
  activeThreadId: null,
  pendingApprovals: [],
  settings: null,
  connection: 'connecting',
  lastSeq: -1,
  usageTotals: { inputTokens: 0, outputTokens: 0 },
  notifications: [],
  secretRequests: [],
  routineRuns: {},

  setBots: (bots) => set({ bots }),

  setThreads: (list) => {
    const threads: Record<string, Thread> = {};
    for (const t of list) threads[t.id] = t;
    set({ threads });
  },

  upsertThread: (thread) => set((s) => ({ threads: { ...s.threads, [thread.id]: thread } })),

  threadEpoch: 0,

  setThreadMessages: (threadId, messages) =>
    set((s) => ({ messagesByThread: { ...s.messagesByThread, [threadId]: messages } })),

  appendLocalMessage: (threadId, message) =>
    set((s) => {
      const existing = s.messagesByThread[threadId] ?? [];
      const idx = findMessage(existing, message.id);
      const next = idx === -1 ? [...existing, message] : existing.map((m, i) => (i === idx ? message : m));
      return { messagesByThread: { ...s.messagesByThread, [threadId]: next } };
    }),

  setActiveThreadId: (id) => set({ activeThreadId: id }),

  setPendingApprovals: (approvals) => set({ pendingApprovals: approvals }),

  setSettings: (settings) => set({ settings }),

  setConnection: (connection) => set({ connection }),

  dismissNotification: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),

  resolveSecretRequest: (requestId) =>
    set((s) => ({ secretRequests: s.secretRequests.filter((r) => r.requestId !== requestId) })),

  decideApproval: async (id, body) => {
    // Optimistically drop it from the pending list; the WS approval.resolved event will
    // also arrive and is a no-op if we've already removed it.
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((a) => a.id !== id) }));
    try {
      await api.approvals.decide(id, body);
    } catch (err) {
      set((s) => ({
        notifications: [
          ...s.notifications,
          {
            id: `local-${Date.now()}`,
            title: 'Approval decision failed',
            body: err instanceof Error ? err.message : String(err),
            level: 'error',
            ts: Date.now(),
          },
        ],
      }));
    }
  },

  handleServerEvent: (event) => {
    const { lastSeq } = get();
    if (event.seq <= lastSeq) return; // duplicate or stale (out-of-order)

    switch (event.type) {
      case 'message.created': {
        const threadId = event.threadId ?? event.message.threadId;
        set((s) => {
          const existing = s.messagesByThread[threadId] ?? [];
          const idx = findMessage(existing, event.message.id);
          const next = idx === -1 ? [...existing, event.message] : existing.map((m, i) => (i === idx ? event.message : m));
          return { messagesByThread: { ...s.messagesByThread, [threadId]: next } };
        });
        break;
      }
      case 'message.delta': {
        const threadId = event.threadId;
        if (!threadId) break;
        set((s) => {
          const existing = s.messagesByThread[threadId] ?? [];
          const idx = findMessage(existing, event.messageId);
          if (idx === -1) return {};
          const next = existing.slice();
          next[idx] = { ...next[idx], contentMd: next[idx].contentMd + event.delta, streaming: true };
          return { messagesByThread: { ...s.messagesByThread, [threadId]: next } };
        });
        break;
      }
      case 'message.done': {
        const threadId = event.threadId;
        if (!threadId) break;
        set((s) => {
          const existing = s.messagesByThread[threadId] ?? [];
          const idx = findMessage(existing, event.messageId);
          if (idx === -1) return {};
          const next = existing.slice();
          next[idx] = { ...next[idx], contentMd: event.contentMd, streaming: false };
          return { messagesByThread: { ...s.messagesByThread, [threadId]: next } };
        });
        break;
      }
      case 'message.card': {
        const threadId = event.threadId;
        if (!threadId) break;
        set((s) => {
          const existing = s.messagesByThread[threadId] ?? [];
          const idx = findMessage(existing, event.messageId);
          if (idx === -1) return {};
          const msg = existing[idx];
          const cards = msg.cards.slice();
          while (cards.length <= event.cardIndex) cards.push(event.card);
          cards[event.cardIndex] = event.card;
          const next = existing.slice();
          next[idx] = { ...msg, cards };
          return { messagesByThread: { ...s.messagesByThread, [threadId]: next } };
        });
        break;
      }
      case 'bot.state': {
        if (!event.botId) break;
        set((s) => ({
          bots: s.bots.map((entry) =>
            entry.bot.id === event.botId
              ? { ...entry, bot: { ...entry.bot, state: event.state, attention: event.attention } }
              : entry,
          ),
        }));
        break;
      }
      case 'approval.pending': {
        set((s) => {
          const idx = s.pendingApprovals.findIndex((a) => a.id === event.approval.id);
          if (idx === -1) return { pendingApprovals: [...s.pendingApprovals, event.approval] };
          const next = s.pendingApprovals.slice();
          next[idx] = event.approval;
          return { pendingApprovals: next };
        });
        break;
      }
      case 'approval.resolved': {
        set((s) => ({
          pendingApprovals: s.pendingApprovals.filter((a) => a.id !== event.approval.id),
        }));
        break;
      }
      case 'routine.run': {
        set((s) => {
          const existing = s.routineRuns[event.run.routineId] ?? [];
          const idx = existing.findIndex((r) => r.id === event.run.id);
          const next = idx === -1 ? [event.run, ...existing] : existing.map((r, i) => (i === idx ? event.run : r));
          return { routineRuns: { ...s.routineRuns, [event.run.routineId]: next.slice(0, 20) } };
        });
        break;
      }
      case 'usage.tick': {
        set((s) => ({
          usageTotals: {
            inputTokens: s.usageTotals.inputTokens + event.inputTokens,
            outputTokens: s.usageTotals.outputTokens + event.outputTokens,
          },
        }));
        break;
      }
      case 'notify': {
        set((s) => ({
          notifications: [
            ...s.notifications,
            { id: `${event.seq}`, title: event.title, body: event.body, level: event.level, ts: Date.now() },
          ],
        }));
        break;
      }
      case 'secret.request': {
        set((s) => ({
          secretRequests: [...s.secretRequests, { requestId: event.requestId, name: event.name, reason: event.reason }],
        }));
        break;
      }
      case 'hello': {
        // Handshake only. Connection state is tracked from the socket lifecycle,
        // and `lastSeq` is updated below, so there is nothing to reduce here.
        break;
      }
      case 'thread.updated': {
        // Drop the cached transcript so the open view refetches. The daemon publishes this when a
        // thread's messages changed out from under the client — today that means "Start fresh",
        // which clears them. Treating it as a no-op is what made that action look like it did
        // nothing: the rows were gone and the screen kept showing them.
        set((s) => {
          const next = { ...s.messagesByThread };
          delete next[event.threadId2];
          // The epoch is what an open view watches: dropping the cache alone would leave a
          // component that already read it holding stale rows until something else re-rendered.
          return { messagesByThread: next, threadEpoch: s.threadEpoch + 1 };
        });
        break;
      }
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }

    set({ lastSeq: event.seq });
  },
}));
