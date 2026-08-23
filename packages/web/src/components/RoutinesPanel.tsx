import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { Routine, RoutineRun } from '@antbot/shared';
import { api, ApiError } from '../api/client.js';

const STATUS_COLOR: Record<RoutineRun['status'], string> = {
  running: 'text-(--color-blue)',
  ok: 'text-(--color-green)',
  failed: 'text-(--color-red)',
  interrupted: 'text-(--color-amber)',
};

function RoutineForm({ botId, onCreated }: { botId: string; onCreated: (r: Routine) => void }) {
  const [name, setName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [instructionMd, setInstructionMd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || !cronExpr.trim() || !instructionMd.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const routine = await api.routines.create({ botId, name, cronExpr, timezone, instructionMd });
      onCreated(routine);
      setName('');
      setInstructionMd('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create routine');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-(--color-border) p-3">
      <div className="text-xs font-semibold text-(--color-text-muted)">New routine</div>
      <input
        className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 font-mono text-sm"
          placeholder="Cron expression (e.g. 0 9 * * *)"
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
        />
        <input
          className="w-40 rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          placeholder="Timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        />
      </div>
      <textarea
        className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
        placeholder="Instructions for this run…"
        rows={3}
        value={instructionMd}
        onChange={(e) => setInstructionMd(e.target.value)}
      />
      {error && <p className="text-xs text-(--color-red)">{error}</p>}
      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="rounded bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-fg) disabled:opacity-40"
      >
        Create routine
      </button>
    </div>
  );
}

function RoutineRow({ routine, onChanged, onDeleted }: { routine: Routine; onChanged: (r: Routine) => void; onDeleted: (id: string) => void }) {
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [showRuns, setShowRuns] = useState(false);
  const [testWarningOpen, setTestWarningOpen] = useState(false);
  const [running, setRunning] = useState(false);

  async function loadRuns() {
    const list = await api.routines.runs(routine.id);
    setRuns(list.slice(0, 20));
  }

  async function toggleShowRuns() {
    const next = !showRuns;
    setShowRuns(next);
    if (next) await loadRuns();
  }

  async function toggleEnabled() {
    const updated = await api.routines.update(routine.id, { enabled: !routine.enabled });
    onChanged(updated);
  }

  async function remove() {
    if (!window.confirm(`Delete routine "${routine.name}"?`)) return;
    await api.routines.remove(routine.id);
    onDeleted(routine.id);
  }

  async function confirmTestRun() {
    setRunning(true);
    setTestWarningOpen(false);
    try {
      await api.routines.testRun(routine.id);
      await loadRuns();
      setShowRuns(true);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-md border border-(--color-border) p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{routine.name}</div>
          <div className="font-mono text-xs text-(--color-text-muted)">
            {routine.cronExpr} · {routine.timezone}
          </div>
          {routine.nextRunAt && (
            <div className="text-xs text-(--color-text-faint)">Next run: {new Date(routine.nextRunAt).toLocaleString()}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-(--color-text-muted)">
            <input type="checkbox" checked={routine.enabled} onChange={toggleEnabled} />
            Enabled
          </label>
          <button
            type="button"
            onClick={() => setTestWarningOpen(true)}
            disabled={running}
            className="rounded border border-(--color-border) px-2 py-1 text-xs hover:bg-(--color-bg-hover)"
          >
            Test run
          </button>
          <button type="button" onClick={remove} className="rounded border border-(--color-red)/50 px-2 py-1 text-xs text-(--color-red)">
            Delete
          </button>
        </div>
      </div>

      {testWarningOpen && (
        <div className="mt-2 rounded border border-(--color-amber)/50 bg-(--color-amber)/10 p-2 text-xs">
          <p className="text-(--color-amber)">
            A test run performs real work — it can navigate websites, change files and call connected tools.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={confirmTestRun} className="rounded bg-(--color-amber) px-2 py-1 font-medium text-(--color-bg)">
              Run anyway
            </button>
            <button type="button" onClick={() => setTestWarningOpen(false)} className="rounded px-2 py-1 text-(--color-text-muted)">
              Cancel
            </button>
          </div>
        </div>
      )}

      <button type="button" onClick={toggleShowRuns} className="mt-2 text-xs text-(--color-text-muted) hover:underline">
        {showRuns ? 'Hide run history' : 'Show run history'}
      </button>
      {showRuns && (
        <ul className="mt-1 space-y-1">
          {runs.length === 0 && <li className="text-xs text-(--color-text-faint)">No runs yet.</li>}
          {runs.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              <span className={clsx('font-medium', STATUS_COLOR[r.status])}>{r.status}</span>
              <span className="text-(--color-text-faint)">{new Date(r.startedAt).toLocaleString()}</span>
              {r.isTest && <span className="rounded bg-(--color-border) px-1 text-[10px]">test</span>}
              {r.summary && <span className="truncate text-(--color-text-muted)">{r.summary}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RoutinesPanel({ botId }: { botId: string }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.routines
      .list(botId)
      .then((list) => {
        if (!cancelled) setRoutines(list);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  return (
    <div className="space-y-3">
      <RoutineForm botId={botId} onCreated={(r) => setRoutines((cur) => [r, ...cur])} />
      {loading && <p className="text-xs text-(--color-text-muted)">Loading routines…</p>}
      {!loading && routines.length === 0 && <p className="text-xs text-(--color-text-muted)">No routines yet.</p>}
      {routines.map((r) => (
        <RoutineRow
          key={r.id}
          routine={r}
          onChanged={(updated) => setRoutines((cur) => cur.map((x) => (x.id === updated.id ? updated : x)))}
          onDeleted={(id) => setRoutines((cur) => cur.filter((x) => x.id !== id))}
        />
      ))}
    </div>
  );
}
