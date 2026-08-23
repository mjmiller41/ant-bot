import cron, { type ScheduledTask } from 'node-cron';
import type { Store } from '../db/store.js';
import type { EventBus } from '../util/bus.js';
import { logger } from '../util/log.js';
import type { Routine, Settings, TurnOrigin } from '@antbot/shared';

const log = logger('scheduler');

/**
 * The subset of BotManager.enqueue the scheduler needs. Kept minimal and structural (rather than
 * importing BotManager directly) so tests can inject a fake manager without spawning real turns.
 */
export interface SchedulerEnqueueArgs {
  botId: string;
  threadId: string;
  prompt: string;
  origin: TurnOrigin;
  hops: number;
  priority?: number;
  onDone?: (summary: string, ok: boolean) => void;
}
export interface SchedulerManager {
  enqueue(job: SchedulerEnqueueArgs): { id: string };
}

export interface SchedulerDeps {
  store: Store;
  bus: EventBus;
  manager: SchedulerManager;
  getSettings: () => Settings;
}

/* ------------------------------- cron parsing ------------------------------- */

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseCronFieldPart(field: string, min: number, max: number): CronField {
  const trimmed = field.trim();
  if (trimmed === '*') {
    const values = new Set<number>();
    for (let v = min; v <= max; v++) values.add(v);
    return { values, wildcard: true };
  }
  const values = new Set<number>();
  for (const part of trimmed.split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`Invalid cron field: "${part}"`);
    const [, startStr, endStr, stepStr] = m;
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let start: number;
    let end: number;
    if (startStr === '*') {
      start = min;
      end = max;
    } else {
      start = parseInt(startStr!, 10);
      end = endStr !== undefined ? parseInt(endStr, 10) : stepStr ? max : start;
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, wildcard: false };
}

/** Parse a standard 5-field cron expression (minute hour dom month dow). Pure, no I/O. */
export function parseCronExpr(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields: "${expr}"`);
  const [minute, hour, dayOfMonth, month, dayOfWeekRaw] = parts as [string, string, string, string, string];
  const dayOfWeek = parseCronFieldPart(dayOfWeekRaw, 0, 7);
  // normalize 7 (alt-Sunday) into 0
  if (dayOfWeek.values.has(7)) {
    dayOfWeek.values.delete(7);
    dayOfWeek.values.add(0);
  }
  return {
    minute: parseCronFieldPart(minute, 0, 59),
    hour: parseCronFieldPart(hour, 0, 23),
    dayOfMonth: parseCronFieldPart(dayOfMonth, 1, 31),
    month: parseCronFieldPart(month, 1, 12),
    dayOfWeek,
  };
}

interface TzParts {
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function makeTzFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
}

function tzParts(dtf: Intl.DateTimeFormat, ms: number): TzParts {
  const parts = dtf.formatToParts(new Date(ms));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  let hour = parseInt(map.hour ?? '0', 10);
  if (hour === 24) hour = 0; // some ICU builds report midnight as "24" under hour12:false
  return {
    month: parseInt(map.month ?? '1', 10),
    day: parseInt(map.day ?? '1', 10),
    hour,
    minute: parseInt(map.minute ?? '0', 10),
    weekday: WEEKDAY_INDEX[map.weekday ?? 'Sun'] ?? 0,
  };
}

const MAX_LOOKAHEAD_MINUTES = 366 * 24 * 60;

/**
 * Compute the next fire time (ms, strictly after `fromMs`) for a 5-field cron expression in a
 * given IANA timezone. Implemented by iterating minute-by-minute over a bounded window — no
 * dependency on node-cron internals. Returns null if nothing matches within 366 days.
 */
export function nextRunAt(cronExpr: string, timezone: string, fromMs: number): number | null {
  const fields = parseCronExpr(cronExpr);
  const dtf = makeTzFormatter(timezone);
  const bothWildcard = fields.dayOfMonth.wildcard && fields.dayOfWeek.wildcard;

  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++, t += 60000) {
    const p = tzParts(dtf, t);
    if (!fields.minute.values.has(p.minute)) continue;
    if (!fields.hour.values.has(p.hour)) continue;
    if (!fields.month.values.has(p.month)) continue;
    const domMatch = fields.dayOfMonth.values.has(p.day);
    const dowMatch = fields.dayOfWeek.values.has(p.weekday);
    const dayOk = bothWildcard
      ? true
      : fields.dayOfMonth.wildcard
        ? dowMatch
        : fields.dayOfWeek.wildcard
          ? domMatch
          : domMatch || dowMatch;
    if (!dayOk) continue;
    return t;
  }
  return null;
}

/* ------------------------------- human summary ------------------------------- */

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Render a short human string for common cron shapes; falls back to the raw expression. */
export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const pad = (n: string): string => n.padStart(2, '0');

  if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${min.slice(2)} minutes`;
  }
  if (hour.startsWith('*/') && min === '0' && dom === '*' && month === '*' && dow === '*') {
    return `Every ${hour.slice(2)} hours`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${pad(hour)}:${pad(min)}`;
    if (dom === '*' && month === '*') {
      if (dow === '*') return `Every day at ${time}`;
      if (dow === '1-5') return `Every weekday at ${time}`;
      if (dow === '0,6' || dow === '6,0') return `Every weekend day at ${time}`;
      if (/^\d$/.test(dow)) return `Every ${DOW_NAMES[parseInt(dow, 10)]} at ${time}`;
    }
    if (/^\d+$/.test(dom) && month === '*' && dow === '*') {
      return `Monthly on day ${dom} at ${time}`;
    }
  }
  return expr;
}

/* --------------------------------- away guard --------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Outline §8: after a long absence, ask whether to keep routines running, and pause if there's
 * no response. `ok` under 7 days away, `ask` between 7 and 14 days, `pause` beyond 14 days.
 */
export function checkAwayGuard(lastUserActivityMs: number, nowMs: number): 'ok' | 'ask' | 'pause' {
  const gap = nowMs - lastUserActivityMs;
  if (gap > 14 * DAY_MS) return 'pause';
  if (gap > 7 * DAY_MS) return 'ask';
  return 'ok';
}

/* --------------------------------- prompt shape --------------------------------- */

/** Build the turn prompt for a routine fire, per outline §8 (naming + stale-data doctrine). */
export function buildRoutinePrompt(routine: Routine, isTest: boolean): string {
  const header = isTest
    ? `This is a **test run** of your routine "${routine.name}". Test runs perform real work — treat it like a live run, and flag anything before doing something irreversible.`
    : `This is a **scheduled run** of your routine "${routine.name}" (${routine.cronExpr}, ${routine.timezone}).`;
  return [
    header,
    '',
    'If the source data is unavailable, report the failure instead of using old data.',
    '',
    '---',
    '',
    routine.instructionMd,
  ].join('\n');
}

/* ---------------------------------- scheduler ---------------------------------- */

export class Scheduler {
  private tasks = new Map<string, ScheduledTask>();
  private paused = false;

  constructor(private deps: SchedulerDeps) {}

  /** Load every enabled routine and schedule it with node-cron. */
  start(): void {
    for (const routine of this.deps.store.listRoutines()) {
      if (routine.enabled) this.scheduleRoutine(routine);
    }
  }

  /** Cancel all scheduled tasks and release their timers. */
  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
      void task.destroy();
    }
    this.tasks.clear();
  }

  /** Re-sync a single routine (call after create/update/delete/enable-toggle). */
  reload(routineId: string): void {
    this.unschedule(routineId);
    const routine = this.deps.store.getRoutine(routineId);
    if (routine?.enabled && !this.paused) this.scheduleRoutine(routine);
  }

  /** Re-sync every routine from scratch. */
  syncAll(): void {
    this.stop();
    this.start();
  }

  /** Pause every scheduled routine without forgetting its schedule (outline §8 away-guard). */
  pauseAll(): void {
    this.paused = true;
    for (const task of this.tasks.values()) task.stop();
  }

  /** Resume every scheduled routine after a pause. */
  resumeAll(): void {
    this.paused = false;
    for (const task of this.tasks.values()) task.start();
  }

  private unschedule(routineId: string): void {
    const task = this.tasks.get(routineId);
    if (!task) return;
    task.stop();
    void task.destroy();
    this.tasks.delete(routineId);
  }

  private scheduleRoutine(routine: Routine): void {
    if (!cron.validate(routine.cronExpr)) {
      log.warn(`routine ${routine.id} has an invalid cron expression: "${routine.cronExpr}"`);
      return;
    }
    const task = cron.schedule(
      routine.cronExpr,
      () => {
        this.fire(routine.id, false);
      },
      { timezone: routine.timezone, unref: true },
    );
    if (this.paused) task.stop();
    this.tasks.set(routine.id, task);
    this.updateNextRunAt(routine);
  }

  private updateNextRunAt(routine: Routine): void {
    const next = nextRunAt(routine.cronExpr, routine.timezone, Date.now());
    this.deps.store.updateRoutine(routine.id, { nextRunAt: next });
  }

  /** Fire a routine now: starts a run record, publishes events, and enqueues the turn. */
  private fire(routineId: string, isTest: boolean): string {
    const { store, bus, manager } = this.deps;
    const routine = store.getRoutine(routineId);
    if (!routine) throw new Error(`Unknown routine: ${routineId}`);

    const bot = store.getBot(routine.botId);
    const run = store.startRun(routineId, isTest, bot?.threadId ?? undefined);
    bus.publish({ type: 'routine.run', threadId: bot?.threadId ?? null, botId: routine.botId, run });

    const next = isTest ? routine.nextRunAt : nextRunAt(routine.cronExpr, routine.timezone, Date.now());
    store.updateRoutine(routineId, { lastRunAt: run.startedAt, nextRunAt: next });

    if (!bot || !bot.threadId) {
      const failed = store.finishRun(run.id, 'failed', 'Owning bot no longer exists.');
      if (failed) bus.publish({ type: 'routine.run', threadId: null, botId: routine.botId, run: failed });
      return run.id;
    }

    manager.enqueue({
      botId: bot.id,
      threadId: bot.threadId,
      prompt: buildRoutinePrompt(routine, isTest),
      origin: 'routine',
      hops: 0,
      priority: 10,
      onDone: (summary, ok) => {
        const finished = store.finishRun(run.id, ok ? 'ok' : 'failed', summary);
        if (finished) bus.publish({ type: 'routine.run', threadId: bot.threadId, botId: routine.botId, run: finished });
      },
    });

    return run.id;
  }

  /** Fire a routine immediately as a test run (real work, marked `isTest`). Returns the run id. */
  testRun(routineId: string): string {
    return this.fire(routineId, true);
  }

  /**
   * Apply the outline §8 away-guard: pause all routines beyond 14 days of inactivity, or notify
   * asking whether to keep them running between 7 and 14 days.
   */
  checkAndApplyAwayGuard(lastUserActivityMs: number, nowMs = Date.now()): 'ok' | 'ask' | 'pause' {
    const result = checkAwayGuard(lastUserActivityMs, nowMs);
    if (result === 'pause') {
      this.pauseAll();
    } else if (result === 'ask') {
      this.deps.bus.publish({
        type: 'notify',
        threadId: null,
        botId: null,
        title: 'Still away?',
        body: "It's been a while since you were last active. Keep routines running, or pause them?",
        level: 'warn',
      });
    }
    return result;
  }
}
