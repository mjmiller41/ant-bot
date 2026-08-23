import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../db/db.js';
import { Store } from '../db/store.js';
import { EventBus } from '../util/bus.js';
import {
  Scheduler, nextRunAt, cronToHuman, checkAwayGuard, buildRoutinePrompt,
  type SchedulerEnqueueArgs, type SchedulerManager,
} from './scheduler.js';
import type { Settings } from '@antbot/shared';

const settings: Settings = {
  timezone: 'UTC', maxConcurrentSessions: 2, autoReviewEnabled: true, theme: 'system',
  localExecution: 'ask', dailyTokenBudget: 0, notificationsEnabled: true,
  billingMode: 'subscription', computerMode: 'host',
};

describe('nextRunAt', () => {
  it('every 5 minutes rounds up to the next multiple of 5', () => {
    const from = Date.UTC(2026, 7, 20, 10, 2, 0);
    expect(nextRunAt('*/5 * * * *', 'UTC', from)).toBe(Date.UTC(2026, 7, 20, 10, 5, 0));
  });

  it('weekdays at 08:00 skips the weekend once today has already passed', () => {
    // Friday 2026-08-21 09:00 UTC — today's 08:00 fire already happened.
    const from = Date.UTC(2026, 7, 21, 9, 0, 0);
    expect(nextRunAt('0 8 * * 1-5', 'UTC', from)).toBe(Date.UTC(2026, 7, 24, 8, 0, 0)); // Monday
  });

  it('monthly on the 1st at midnight rolls to next month', () => {
    const from = Date.UTC(2026, 7, 20, 10, 0, 0); // Aug 20
    expect(nextRunAt('0 0 1 * *', 'UTC', from)).toBe(Date.UTC(2026, 8, 1, 0, 0, 0)); // Sep 1
  });

  it('weekly on Sunday at 09:30 finds the next Sunday', () => {
    const from = Date.UTC(2026, 7, 20, 10, 0, 0); // Thursday
    expect(nextRunAt('30 9 * * 0', 'UTC', from)).toBe(Date.UTC(2026, 7, 23, 9, 30, 0)); // Sunday
  });

  it('supports a stepped range (a-b/n)', () => {
    const from = Date.UTC(2026, 7, 20, 10, 5, 0);
    // minutes 10,20,30,40 within the hour
    expect(nextRunAt('10-40/10 * * * *', 'UTC', from)).toBe(Date.UTC(2026, 7, 20, 10, 10, 0));
  });

  it('honors an explicit non-UTC timezone', () => {
    // 2026-01-15 10:00 UTC == 05:00 EST; the next 09:00 EST fire is later the same day.
    const from = Date.UTC(2026, 0, 15, 10, 0, 0);
    expect(nextRunAt('0 9 * * *', 'America/New_York', from)).toBe(Date.UTC(2026, 0, 15, 14, 0, 0));
  });

  it('rolls to the next day once the timezone-local time has passed', () => {
    // 2026-01-15 15:00 UTC == 10:00 EST, so 09:00 EST already happened today.
    const from = Date.UTC(2026, 0, 15, 15, 0, 0);
    expect(nextRunAt('0 9 * * *', 'America/New_York', from)).toBe(Date.UTC(2026, 0, 16, 14, 0, 0));
  });
});

describe('cronToHuman', () => {
  it.each([
    ['*/5 * * * *', 'Every 5 minutes'],
    ['0 8 * * 1-5', 'Every weekday at 08:00'],
    ['0 0 1 * *', 'Monthly on day 1 at 00:00'],
    ['30 9 * * 0', 'Every Sunday at 09:30'],
    ['0 0 * * *', 'Every day at 00:00'],
  ])('%s -> %s', (expr, human) => {
    expect(cronToHuman(expr)).toBe(human);
  });

  it('falls back to the raw expression for unrecognized shapes', () => {
    expect(cronToHuman('*/7 3,4 * * *')).toBe('*/7 3,4 * * *');
  });
});

describe('checkAwayGuard', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('is ok with no gap at all', () => {
    expect(checkAwayGuard(0, 0)).toBe('ok');
  });
  it('is ok exactly at the 7 day boundary', () => {
    expect(checkAwayGuard(0, 7 * DAY)).toBe('ok');
  });
  it('asks just past the 7 day boundary', () => {
    expect(checkAwayGuard(0, 7 * DAY + 1)).toBe('ask');
  });
  it('still asks exactly at the 14 day boundary', () => {
    expect(checkAwayGuard(0, 14 * DAY)).toBe('ask');
  });
  it('pauses just past the 14 day boundary', () => {
    expect(checkAwayGuard(0, 14 * DAY + 1)).toBe('pause');
  });
});

describe('buildRoutinePrompt', () => {
  it('includes the routine name and the stale-data doctrine for a live run', () => {
    const prompt = buildRoutinePrompt(
      { id: 'r1', botId: 'b1', name: 'Weekly report', cronExpr: '0 8 * * 1', timezone: 'UTC', instructionMd: 'Build it.', enabled: true, lastRunAt: null, nextRunAt: null, createdAt: 0 },
      false,
    );
    expect(prompt).toContain('Weekly report');
    expect(prompt).toContain('scheduled run');
    expect(prompt).toContain('report the failure instead of using old data');
    expect(prompt).toContain('Build it.');
  });

  it('labels a test run differently from a live run', () => {
    const prompt = buildRoutinePrompt(
      { id: 'r1', botId: 'b1', name: 'Weekly report', cronExpr: '0 8 * * 1', timezone: 'UTC', instructionMd: 'Build it.', enabled: true, lastRunAt: null, nextRunAt: null, createdAt: 0 },
      true,
    );
    expect(prompt).toContain('test run');
  });
});

describe('Scheduler', () => {
  let store: Store;
  let bus: EventBus;
  let manager: SchedulerManager & { enqueue: ReturnType<typeof vi.fn> };
  let scheduler: Scheduler;
  let botId: string;
  let routineId: string;

  beforeEach(() => {
    store = new Store(openDb(':memory:'));
    bus = new EventBus();
    manager = {
      enqueue: vi.fn((job: SchedulerEnqueueArgs) => ({ id: 'job-1', ...job })),
    };
    scheduler = new Scheduler({ store, bus, manager, getSettings: () => settings });
    const bot = store.createBot({ name: 'Reporter' });
    botId = bot.id;
    const routine = store.createRoutine({
      botId, name: 'Weekly report', cronExpr: '0 8 * * 1', instructionMd: 'Build the report.',
    });
    routineId = routine.id;
  });

  afterEach(() => {
    scheduler.stop();
  });

  it('testRun starts a running, isTest run row and enqueues a routine turn', () => {
    const runId = scheduler.testRun(routineId);
    const run = store.getRun(runId);
    expect(run?.status).toBe('running');
    expect(run?.isTest).toBe(true);
    expect(manager.enqueue).toHaveBeenCalledTimes(1);

    const job = manager.enqueue.mock.calls[0]![0] as SchedulerEnqueueArgs;
    expect(job.botId).toBe(botId);
    expect(job.origin).toBe('routine');
    expect(job.priority).toBe(10);
    expect(job.prompt).toContain('Weekly report');
    expect(job.prompt).toContain('report the failure instead of using old data');
  });

  it('finishes the run ok when the turn succeeds', () => {
    const runId = scheduler.testRun(routineId);
    const job = manager.enqueue.mock.calls[0]![0] as SchedulerEnqueueArgs;
    job.onDone?.('done: report posted', true);
    const run = store.getRun(runId);
    expect(run?.status).toBe('ok');
    expect(run?.summary).toBe('done: report posted');
    expect(run?.finishedAt).not.toBeNull();
  });

  it('finishes the run failed when the turn fails', () => {
    const runId = scheduler.testRun(routineId);
    const job = manager.enqueue.mock.calls[0]![0] as SchedulerEnqueueArgs;
    job.onDone?.('boom', false);
    const run = store.getRun(runId);
    expect(run?.status).toBe('failed');
    expect(run?.summary).toBe('boom');
  });

  it('publishes routine.run events on start and on finish', () => {
    const statuses: string[] = [];
    bus.subscribe((e) => {
      if (e.type === 'routine.run') statuses.push(e.run.status);
    });
    const runId = scheduler.testRun(routineId);
    const job = manager.enqueue.mock.calls[0]![0] as SchedulerEnqueueArgs;
    job.onDone?.('ok', true);
    expect(statuses).toEqual(['running', 'ok']);
    expect(store.getRun(runId)?.status).toBe('ok');
  });

  it('fails the run instead of enqueuing when the owning bot row is gone', () => {
    // Simulate a dangling routine->bot reference directly (Store.deleteBot itself cascades
    // and removes the routine too, so this exercises the scheduler's own defensive guard).
    store.db.prepare('DELETE FROM bots WHERE id=?').run(botId);
    const runId = scheduler.testRun(routineId);
    expect(manager.enqueue).not.toHaveBeenCalled();
    expect(store.getRun(runId)?.status).toBe('failed');
  });

  it('throws testRun-ing an unknown routine id', () => {
    expect(() => scheduler.testRun('does-not-exist')).toThrow(/Unknown routine/);
  });

  it('keeps only the 20 most recent run records per routine', () => {
    for (let n = 0; n < 25; n++) {
      scheduler.testRun(routineId);
      const job = manager.enqueue.mock.calls[manager.enqueue.mock.calls.length - 1]![0] as SchedulerEnqueueArgs;
      job.onDone?.(`run ${n}`, true);
    }
    expect(store.listRuns(routineId)).toHaveLength(20);
  });

  it('schedules enabled routines on start() and records nextRunAt', () => {
    scheduler.start();
    const routine = store.getRoutine(routineId);
    expect(routine?.nextRunAt).not.toBeNull();
    expect(routine!.nextRunAt!).toBeGreaterThan(Date.now());
  });

  it('does not schedule a disabled routine', () => {
    store.updateRoutine(routineId, { enabled: false });
    scheduler.start();
    const routine = store.getRoutine(routineId);
    expect(routine?.nextRunAt).toBeNull();
  });

  it('reload re-syncs a single routine after it is disabled', () => {
    scheduler.start();
    store.updateRoutine(routineId, { enabled: false });
    expect(() => scheduler.reload(routineId)).not.toThrow();
    expect(store.getRoutine(routineId)?.enabled).toBe(false);
  });

  it('syncAll rebuilds every schedule without throwing', () => {
    scheduler.start();
    expect(() => scheduler.syncAll()).not.toThrow();
  });

  it('pauseAll / resumeAll toggle without throwing', () => {
    scheduler.start();
    expect(() => scheduler.pauseAll()).not.toThrow();
    expect(() => scheduler.resumeAll()).not.toThrow();
  });

  it('checkAndApplyAwayGuard pauses after 14+ days away', () => {
    scheduler.start();
    const now = Date.now();
    const result = scheduler.checkAndApplyAwayGuard(now - 15 * 24 * 60 * 60 * 1000, now);
    expect(result).toBe('pause');
  });

  it('checkAndApplyAwayGuard publishes a notify event after 7+ days away', () => {
    const notifies: Array<{ title: string; level: string }> = [];
    bus.subscribe((e) => {
      if (e.type === 'notify') notifies.push({ title: e.title, level: e.level });
    });
    const now = Date.now();
    const result = scheduler.checkAndApplyAwayGuard(now - 8 * 24 * 60 * 60 * 1000, now);
    expect(result).toBe('ask');
    expect(notifies).toHaveLength(1);
    expect(notifies[0]?.level).toBe('warn');
  });

  it('checkAndApplyAwayGuard is silent and does not pause when recently active', () => {
    const notifies: number = 0;
    bus.subscribe(() => {
      throw new Error('should not publish for a fresh activity gap');
    });
    const now = Date.now();
    const result = scheduler.checkAndApplyAwayGuard(now - 1000, now);
    expect(result).toBe('ok');
    expect(notifies).toBe(0);
  });
});
