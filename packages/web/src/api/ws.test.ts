import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerEvent } from '@antbot/shared';
import { createEventSocket } from './ws.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  triggerOpen() {
    this.onopen?.();
  }

  triggerMessage(event: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

describe('createEventSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches parsed server events via onEvent', () => {
    const onEvent = vi.fn();
    const setConnection = vi.fn();
    createEventSocket({
      url: 'ws://x/api/events',
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      getLastSeq: () => -1,
      onEvent,
      setConnection,
    });
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    const event: ServerEvent = {
      type: 'bot.state',
      seq: 1,
      threadId: null,
      botId: 'bot-1',
      state: 'running',
      attention: 'none',
    };
    ws.triggerMessage(event);
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(setConnection).toHaveBeenCalledWith('open');
  });

  it('sends a resume frame with the last seen seq on connect when seq >= 0', () => {
    createEventSocket({
      url: 'ws://x/api/events',
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      getLastSeq: () => 42,
      onEvent: vi.fn(),
      setConnection: vi.fn(),
    });
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resume', seq: 42 })]);
  });

  it('does not send a resume frame when there is no prior seq', () => {
    createEventSocket({
      url: 'ws://x/api/events',
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      getLastSeq: () => -1,
      onEvent: vi.fn(),
      setConnection: vi.fn(),
    });
    const ws = MockWebSocket.instances[0];
    ws.triggerOpen();
    expect(ws.sent).toEqual([]);
  });

  it('reconnects with exponential backoff after a close, capped at maxBackoffMs', () => {
    const setConnection = vi.fn();
    createEventSocket({
      url: 'ws://x/api/events',
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      getLastSeq: () => -1,
      onEvent: vi.fn(),
      setConnection,
      baseBackoffMs: 100,
      maxBackoffMs: 400,
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    MockWebSocket.instances[0].close();
    expect(setConnection).toHaveBeenCalledWith('closed');
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1].close();
    vi.advanceTimersByTime(199);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Third failure would back off 400ms (2^2 * 100 = 400, within cap).
    MockWebSocket.instances[2].close();
    vi.advanceTimersByTime(400);
    expect(MockWebSocket.instances).toHaveLength(4);

    // Fourth failure would be 800ms uncapped, but is capped at maxBackoffMs (400ms).
    MockWebSocket.instances[3].close();
    vi.advanceTimersByTime(400);
    expect(MockWebSocket.instances).toHaveLength(5);
  });

  it('stops reconnecting once close() is called on the controller', () => {
    const controller = createEventSocket({
      url: 'ws://x/api/events',
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      getLastSeq: () => -1,
      onEvent: vi.fn(),
      setConnection: vi.fn(),
      baseBackoffMs: 100,
      maxBackoffMs: 400,
    });
    controller.close();
    expect(MockWebSocket.instances[0].closed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('resets backoff to the base delay after a successful open', () => {
    createEventSocket({
      url: 'ws://x/api/events',
      WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      getLastSeq: () => -1,
      onEvent: vi.fn(),
      setConnection: vi.fn(),
      baseBackoffMs: 100,
      maxBackoffMs: 400,
    });
    MockWebSocket.instances[0].close();
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].triggerOpen();
    MockWebSocket.instances[1].close();
    vi.advanceTimersByTime(99);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });
});
