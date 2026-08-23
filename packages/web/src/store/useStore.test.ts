import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerEvent, RosterEntry, Bot, Thread, Message, Approval } from '@antbot/shared';
import { useStore } from './useStore.js';

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    slug: 'bot-1',
    name: 'Bot One',
    title: '',
    description: '',
    avatarEmoji: '🤖',
    modelTier: 'sonnet',
    pinned: false,
    hidden: false,
    notifications: true,
    sessionId: null,
    state: 'idle',
    attention: 'none',
    threadId: 'thread-1',
    createdAt: Date.now(),
    deletedAt: null,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    kind: 'dm',
    title: '',
    memberBotIds: ['bot-1'],
    pinned: false,
    hidden: false,
    lastReadAt: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    authorKind: 'bot',
    authorBotId: 'bot-1',
    replyToId: null,
    contentMd: '',
    cards: [],
    streaming: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    botId: 'bot-1',
    threadId: 'thread-1',
    toolName: 'Bash',
    inputSummary: 'run rm -rf /tmp/x',
    rawInput: { command: 'rm -rf /tmp/x' },
    status: 'pending',
    decidedBy: null,
    reason: '',
    ruleId: null,
    createdAt: Date.now(),
    decidedAt: null,
    ...overrides,
  };
}

function reset() {
  useStore.setState({
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
  });
}

describe('useStore', () => {
  beforeEach(reset);

  it('setBots replaces the roster', () => {
    const roster: RosterEntry[] = [{ bot: makeBot(), thread: makeThread(), lastMessageAt: 0 }];
    useStore.getState().setBots(roster);
    expect(useStore.getState().bots).toEqual(roster);
  });

  it('message.created appends a message to its thread and advances lastSeq', () => {
    const msg = makeMessage();
    const event: ServerEvent = {
      type: 'message.created',
      seq: 1,
      threadId: 'thread-1',
      botId: 'bot-1',
      message: msg,
    };
    useStore.getState().handleServerEvent(event);
    expect(useStore.getState().messagesByThread['thread-1']).toEqual([msg]);
    expect(useStore.getState().lastSeq).toBe(1);
  });

  it('message.delta appends text to the matching message contentMd', () => {
    const msg = makeMessage({ contentMd: 'Hello' });
    useStore.setState({ messagesByThread: { 'thread-1': [msg] } });
    useStore.getState().handleServerEvent({
      type: 'message.delta',
      seq: 2,
      threadId: 'thread-1',
      botId: 'bot-1',
      messageId: 'msg-1',
      delta: ', world',
    });
    useStore.getState().handleServerEvent({
      type: 'message.delta',
      seq: 3,
      threadId: 'thread-1',
      botId: 'bot-1',
      messageId: 'msg-1',
      delta: '!',
    });
    expect(useStore.getState().messagesByThread['thread-1'][0].contentMd).toBe('Hello, world!');
  });

  it('message.done sets final contentMd and clears streaming', () => {
    const msg = makeMessage({ contentMd: 'partial', streaming: true });
    useStore.setState({ messagesByThread: { 'thread-1': [msg] } });
    useStore.getState().handleServerEvent({
      type: 'message.done',
      seq: 2,
      threadId: 'thread-1',
      botId: 'bot-1',
      messageId: 'msg-1',
      contentMd: 'final text',
    });
    const updated = useStore.getState().messagesByThread['thread-1'][0];
    expect(updated.contentMd).toBe('final text');
    expect(updated.streaming).toBe(false);
  });

  it('message.card inserts a card at cardIndex, padding as needed', () => {
    const msg = makeMessage({ cards: [] });
    useStore.setState({ messagesByThread: { 'thread-1': [msg] } });
    useStore.getState().handleServerEvent({
      type: 'message.card',
      seq: 2,
      threadId: 'thread-1',
      botId: 'bot-1',
      messageId: 'msg-1',
      cardIndex: 0,
      card: { type: 'tool', toolName: 'Bash', summary: 'run ls', status: 'ok' },
    });
    const updated = useStore.getState().messagesByThread['thread-1'][0];
    expect(updated.cards).toHaveLength(1);
    expect(updated.cards[0]).toMatchObject({ type: 'tool', toolName: 'Bash' });
  });

  it('message.card replaces an existing card at the same index', () => {
    const msg = makeMessage({
      cards: [{ type: 'tool', toolName: 'Bash', summary: 'run ls', status: 'running' }],
    });
    useStore.setState({ messagesByThread: { 'thread-1': [msg] } });
    useStore.getState().handleServerEvent({
      type: 'message.card',
      seq: 2,
      threadId: 'thread-1',
      botId: 'bot-1',
      messageId: 'msg-1',
      cardIndex: 0,
      card: { type: 'tool', toolName: 'Bash', summary: 'run ls', status: 'ok' },
    });
    const updated = useStore.getState().messagesByThread['thread-1'][0];
    expect(updated.cards).toHaveLength(1);
    expect(updated.cards[0]).toMatchObject({ status: 'ok' });
  });

  it('bot.state updates the matching bot state and attention', () => {
    useStore.setState({
      bots: [{ bot: makeBot({ state: 'idle', attention: 'none' }), thread: makeThread(), lastMessageAt: 0 }],
    });
    useStore.getState().handleServerEvent({
      type: 'bot.state',
      seq: 1,
      threadId: 'thread-1',
      botId: 'bot-1',
      state: 'waiting_approval',
      attention: 'needs_attention',
    });
    const bot = useStore.getState().bots[0].bot;
    expect(bot.state).toBe('waiting_approval');
    expect(bot.attention).toBe('needs_attention');
  });

  it('approval.pending adds a pending approval', () => {
    const approval = makeApproval();
    useStore.getState().handleServerEvent({
      type: 'approval.pending',
      seq: 1,
      threadId: 'thread-1',
      botId: 'bot-1',
      approval,
    });
    expect(useStore.getState().pendingApprovals).toEqual([approval]);
  });

  it('approval.resolved removes the approval from the pending list', () => {
    const approval = makeApproval();
    useStore.setState({ pendingApprovals: [approval] });
    useStore.getState().handleServerEvent({
      type: 'approval.resolved',
      seq: 2,
      threadId: 'thread-1',
      botId: 'bot-1',
      approval: { ...approval, status: 'allowed', decidedAt: Date.now() },
    });
    expect(useStore.getState().pendingApprovals).toEqual([]);
  });

  it('routine.run records the run keyed by routineId', () => {
    useStore.getState().handleServerEvent({
      type: 'routine.run',
      seq: 1,
      threadId: null,
      botId: 'bot-1',
      run: {
        id: 'run-1',
        routineId: 'routine-1',
        startedAt: Date.now(),
        finishedAt: null,
        status: 'running',
        summary: '',
        threadId: null,
        isTest: false,
      },
    });
    expect(useStore.getState().routineRuns['routine-1']).toHaveLength(1);
  });

  it('usage.tick accumulates token totals', () => {
    useStore.getState().handleServerEvent({
      type: 'usage.tick',
      seq: 1,
      threadId: null,
      botId: 'bot-1',
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-sonnet',
    });
    useStore.getState().handleServerEvent({
      type: 'usage.tick',
      seq: 2,
      threadId: null,
      botId: 'bot-1',
      inputTokens: 10,
      outputTokens: 5,
      model: 'claude-sonnet',
    });
    expect(useStore.getState().usageTotals).toEqual({ inputTokens: 110, outputTokens: 55 });
  });

  it('notify pushes a notification', () => {
    useStore.getState().handleServerEvent({
      type: 'notify',
      seq: 1,
      threadId: null,
      botId: null,
      title: 'Approval needed',
      body: 'Scout wants to run a command',
      level: 'warn',
    });
    expect(useStore.getState().notifications).toHaveLength(1);
    expect(useStore.getState().notifications[0]).toMatchObject({ title: 'Approval needed', level: 'warn' });
  });

  it('secret.request pushes a secret request', () => {
    useStore.getState().handleServerEvent({
      type: 'secret.request',
      seq: 1,
      threadId: null,
      botId: 'bot-1',
      requestId: 'req-1',
      name: 'GITHUB_TOKEN',
      reason: 'push to repo',
    });
    expect(useStore.getState().secretRequests).toEqual([{ requestId: 'req-1', name: 'GITHUB_TOKEN', reason: 'push to repo' }]);
  });

  it('ignores events with seq less than or equal to lastSeq (duplicate/out-of-order)', () => {
    const msg1 = makeMessage({ id: 'msg-1' });
    const msg2 = makeMessage({ id: 'msg-2' });
    useStore.getState().handleServerEvent({
      type: 'message.created',
      seq: 5,
      threadId: 'thread-1',
      botId: 'bot-1',
      message: msg1,
    });
    // Duplicate / stale seq should be dropped entirely.
    useStore.getState().handleServerEvent({
      type: 'message.created',
      seq: 5,
      threadId: 'thread-1',
      botId: 'bot-1',
      message: msg2,
    });
    useStore.getState().handleServerEvent({
      type: 'message.created',
      seq: 3,
      threadId: 'thread-1',
      botId: 'bot-1',
      message: msg2,
    });
    expect(useStore.getState().messagesByThread['thread-1']).toEqual([msg1]);
    expect(useStore.getState().lastSeq).toBe(5);
  });

  it('processes events in-order after an out-of-order duplicate is dropped', () => {
    useStore.getState().handleServerEvent({
      type: 'bot.state',
      seq: 10,
      threadId: 'thread-1',
      botId: 'bot-1',
      state: 'running',
      attention: 'none',
    });
    useStore.getState().handleServerEvent({
      type: 'bot.state',
      seq: 4,
      threadId: 'thread-1',
      botId: 'bot-1',
      state: 'idle',
      attention: 'none',
    });
    useStore.getState().handleServerEvent({
      type: 'bot.state',
      seq: 11,
      threadId: 'thread-1',
      botId: 'bot-1',
      state: 'idle',
      attention: 'unread',
    });
    expect(useStore.getState().lastSeq).toBe(11);
  });
});
