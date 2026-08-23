import type { ServerEvent } from '@antbot/contract';
import { useStore, type ConnectionState } from '../store/useStore.js';

const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 10000;

export interface EventSocketOptions {
  url?: string;
  WebSocketImpl?: typeof WebSocket;
  getLastSeq?: () => number;
  onEvent?: (event: ServerEvent) => void;
  setConnection?: (state: ConnectionState) => void;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface EventSocketController {
  close: () => void;
}

function defaultUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/events`;
}

/**
 * Opens a single resilient WebSocket connection to /api/events, dispatching typed
 * ServerEvents into the store and reconnecting with exponential backoff (capped) on
 * disconnect, resending the last-seen seq via a {type:'resume'} frame so the server
 * can replay missed events.
 */
export function createEventSocket(options: EventSocketOptions = {}): EventSocketController {
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const getLastSeq = options.getLastSeq ?? (() => useStore.getState().lastSeq);
  const onEvent = options.onEvent ?? ((event: ServerEvent) => useStore.getState().handleServerEvent(event));
  const setConnection = options.setConnection ?? ((state: ConnectionState) => useStore.getState().setConnection(state));
  const url = options.url ?? defaultUrl();
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let attempt = 0;
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (closed) return;
    setConnection('connecting');
    const ws = new WebSocketImpl(url);
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      setConnection('open');
      const lastSeq = getLastSeq();
      if (lastSeq >= 0) {
        ws.send(JSON.stringify({ type: 'resume', seq: lastSeq }));
      }
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data as string) as ServerEvent;
        onEvent(data);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => {
      setConnection('closed');
      socket = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
