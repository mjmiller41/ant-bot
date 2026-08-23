import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@antbot/contract';

/** Distributive omit so the discriminated union survives (a plain Omit collapses it). */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Emitted = DistOmit<ServerEvent, 'seq'> & { seq?: number };

/** In-process event bus. Assigns a monotonic seq so the UI can order/reconcile. */
export class EventBus {
  private emitter = new EventEmitter();
  private seq = 0;
  private ring: ServerEvent[] = [];
  private readonly ringMax = 500;

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(e: Emitted): ServerEvent {
    const full = { ...e, seq: ++this.seq } as ServerEvent;
    this.ring.push(full);
    if (this.ring.length > this.ringMax) this.ring.shift();
    this.emitter.emit('event', full);
    return full;
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  /** Replay events after a given seq (client reconnect). */
  since(seq: number): ServerEvent[] {
    return this.ring.filter((e) => e.seq > seq);
  }

  get currentSeq(): number {
    return this.seq;
  }
}
