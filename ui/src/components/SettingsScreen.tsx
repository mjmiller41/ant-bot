import { useEffect, useState, type ReactNode } from 'react';
import type { Settings } from '@antbot/contract';
import { api } from '../api/client.js';

export interface SettingsScreenProps {
  onSettingsChange?: (settings: Settings) => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-3 flex items-center justify-between gap-4 border-b border-(--color-border) py-2 text-sm">
      <span className="text-(--color-text-muted)">{label}</span>
      {children}
    </label>
  );
}

export function SettingsScreen({ onSettingsChange }: SettingsScreenProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings.get().then((s) => {
      setSettings(s);
      onSettingsChange?.(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patch(partial: Partial<Settings>) {
    if (!settings) return;
    const optimistic = { ...settings, ...partial };
    setSettings(optimistic);
    setSaving(true);
    try {
      const saved = await api.settings.update(partial);
      setSettings(saved);
      onSettingsChange?.(saved);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return <p className="p-6 text-sm text-(--color-text-muted)">Loading settings…</p>;
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        {saving && <span className="text-xs text-(--color-text-muted)">Saving…</span>}
      </div>

      <Field label="Timezone">
        <input
          className="w-48 rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={settings.timezone}
          onChange={(e) => patch({ timezone: e.target.value })}
        />
      </Field>

      <Field label="Max concurrent sessions">
        <input
          type="number"
          min={1}
          max={8}
          className="w-20 rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={settings.maxConcurrentSessions}
          onChange={(e) => patch({ maxConcurrentSessions: Math.min(8, Math.max(1, Number(e.target.value) || 1)) })}
        />
      </Field>

      <Field label="Auto-review (Haiku triage of tool calls)">
        <input
          type="checkbox"
          checked={settings.autoReviewEnabled}
          onChange={(e) => patch({ autoReviewEnabled: e.target.checked })}
        />
      </Field>

      <Field label="Theme">
        <select
          className="rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={settings.theme}
          onChange={(e) => patch({ theme: e.target.value as Settings['theme'] })}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Field>

      <Field label="Local execution (run commands on this machine)">
        <select
          className="rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={settings.localExecution}
          onChange={(e) => patch({ localExecution: e.target.value as Settings['localExecution'] })}
        >
          <option value="ask">Ask</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select>
      </Field>

      <Field label="Daily token budget (0 = unlimited)">
        <input
          type="number"
          min={0}
          className="w-32 rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={settings.dailyTokenBudget}
          onChange={(e) => patch({ dailyTokenBudget: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>

      <Field label="Desktop notifications">
        <input
          type="checkbox"
          checked={settings.notificationsEnabled}
          onChange={(e) => patch({ notificationsEnabled: e.target.checked })}
        />
      </Field>

      <Field label="Billing mode">
        <select
          className="rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={settings.billingMode}
          onChange={(e) => patch({ billingMode: e.target.value as Settings['billingMode'] })}
        >
          <option value="subscription">Subscription</option>
          <option value="api">API (metered)</option>
        </select>
      </Field>

      <Field label="Computer mode">
        <select
          className="rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={settings.computerMode}
          onChange={(e) => patch({ computerMode: e.target.value as Settings['computerMode'] })}
        >
          <option value="host">Host</option>
          <option value="container">Container</option>
        </select>
      </Field>
    </div>
  );
}
