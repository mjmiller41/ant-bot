import { describe, it, expect } from 'vitest';
import { EventBus } from './bus.js';
import type { ServerEvent } from '@antbot/shared';

const notify = (body: string) => ({
  type: 'notify' as const, threadId: null, botId: null, title: 't', body, level: 'info' as const,
});

describe('EventBus', () => {
  it('publish assigns strictly increasing seq starting at 1 and returns the full event', () => {
    const bus = new EventBus();
    const e1 = bus.publish(notify('one'));
    const e2 = bus.publish(notify('two'));
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.type).toBe('notify');
    if (e1.type === 'notify') expect(e1.body).toBe('one');
    expect(bus.currentSeq).toBe(2);
  });

  it('subscribers receive published events; the returned unsubscribe function stops delivery', () => {
    const bus = new EventBus();
    const received: ServerEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));

    bus.publish(notify('a'));
    expect(received.length).toBe(1);

    unsubscribe();
    bus.publish(notify('b'));
    expect(received.length).toBe(1);
  });

  it('since(n) replays only events with seq > n', () => {
    const bus = new EventBus();
    bus.publish(notify('1'));
    bus.publish(notify('2'));
    bus.publish(notify('3'));

    const fromZero = bus.since(0);
    expect(fromZero.length).toBe(3);

    const fromOne = bus.since(1);
    expect(fromOne.length).toBe(2);
    expect(fromOne.every((e) => e.seq > 1)).toBe(true);

    const fromThree = bus.since(3);
    expect(fromThree.length).toBe(0);
  });

  it('the ring buffer caps at 500: publishing 600 events keeps only the most recent 500', () => {
    const bus = new EventBus();
    for (let i = 1; i <= 600; i++) bus.publish(notify(String(i)));

    const all = bus.since(0);
    expect(all.length).toBe(500);
    expect(all[0].seq).toBe(101);
    expect(all[all.length - 1].seq).toBe(600);
  });

  it('multiple subscribers all receive the same event', () => {
    const bus = new EventBus();
    const receivedA: ServerEvent[] = [];
    const receivedB: ServerEvent[] = [];
    bus.subscribe((e) => receivedA.push(e));
    bus.subscribe((e) => receivedB.push(e));

    const published = bus.publish(notify('shared'));

    expect(receivedA.length).toBe(1);
    expect(receivedB.length).toBe(1);
    expect(receivedA[0]).toEqual(published);
    expect(receivedB[0]).toEqual(published);
  });
});
