import { useEffect, useState } from 'react';
import type { UsageSummary } from '@antbot/shared';
import { api } from '../api/client.js';

function Bar({ label, value, max, sublabel }: { label: string; value: number; max: number; sublabel?: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-(--color-text-muted)">{sublabel ?? value.toLocaleString()}</span>
      </div>
      <div className="h-2 rounded bg-(--color-bg)">
        <div className="h-2 rounded bg-(--color-accent)" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function UsageScreen() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    api.usage().then(setUsage);
  }, []);

  if (!usage) {
    return <p className="p-6 text-sm text-(--color-text-muted)">Loading usage…</p>;
  }

  const totalTokens = usage.totals.inputTokens + usage.totals.outputTokens;
  const maxByBot = Math.max(1, ...usage.byBot.map((b) => b.inputTokens + b.outputTokens));
  const maxByDay = Math.max(1, ...usage.byDay.map((d) => d.inputTokens + d.outputTokens));
  const maxByModel = Math.max(1, ...usage.byModel.map((m) => m.inputTokens + m.outputTokens));

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-lg font-semibold">Usage</h1>

      <section className="mb-6 grid grid-cols-3 gap-3">
        <div className="rounded-md border border-(--color-border) p-3">
          <div className="text-xs text-(--color-text-muted)">Input tokens</div>
          <div className="text-xl font-semibold">{usage.totals.inputTokens.toLocaleString()}</div>
        </div>
        <div className="rounded-md border border-(--color-border) p-3">
          <div className="text-xs text-(--color-text-muted)">Output tokens</div>
          <div className="text-xl font-semibold">{usage.totals.outputTokens.toLocaleString()}</div>
        </div>
        <div className="rounded-md border border-(--color-border) p-3">
          <div className="text-xs text-(--color-text-muted)">Cache-read tokens</div>
          <div className="text-xl font-semibold">{usage.totals.cacheReadTokens.toLocaleString()}</div>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">By bot</h2>
        {usage.byBot.length === 0 && <p className="text-xs text-(--color-text-muted)">No usage yet.</p>}
        {usage.byBot.map((b) => (
          <Bar key={b.botId} label={b.botName} value={b.inputTokens + b.outputTokens} max={maxByBot} />
        ))}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold">By day</h2>
        <div className="flex items-end gap-1" style={{ height: 96 }}>
          {usage.byDay.map((d) => {
            const total = d.inputTokens + d.outputTokens;
            const h = Math.max(2, Math.round((total / maxByDay) * 88));
            return (
              <div key={d.day} className="flex flex-1 flex-col items-center justify-end" title={`${d.day}: ${total.toLocaleString()} tokens`}>
                <div className="w-full rounded-t bg-(--color-accent)" style={{ height: h }} />
                <span className="mt-1 rotate-0 text-[9px] text-(--color-text-faint)">{d.day.slice(5)}</span>
              </div>
            );
          })}
        </div>
        {usage.byDay.length === 0 && <p className="text-xs text-(--color-text-muted)">No usage yet.</p>}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">By model</h2>
        {usage.byModel.length === 0 && <p className="text-xs text-(--color-text-muted)">No usage yet.</p>}
        {usage.byModel.map((m) => (
          <Bar
            key={m.model}
            label={m.model}
            value={m.inputTokens + m.outputTokens}
            max={maxByModel}
            sublabel={totalTokens > 0 ? `${Math.round(((m.inputTokens + m.outputTokens) / totalTokens) * 100)}%` : '0%'}
          />
        ))}
      </section>
    </div>
  );
}
