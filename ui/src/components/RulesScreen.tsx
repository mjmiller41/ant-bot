import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { Rule, RuleKind } from '@antbot/contract';
import { api, ApiError } from '../api/client.js';

function KindBadge({ kind }: { kind: RuleKind }) {
  return (
    <span
      className={clsx(
        'rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        kind === 'require' ? 'bg-(--color-red)/15 text-(--color-red)' : 'bg-(--color-green)/15 text-(--color-green)',
      )}
    >
      {kind === 'require' ? 'Require approval' : 'Always allow'}
    </span>
  );
}

function AddRuleForm({ onCreated }: { onCreated: (r: Rule) => void }) {
  const [kind, setKind] = useState<RuleKind>('require');
  const [toolPattern, setToolPattern] = useState('');
  const [inputPattern, setInputPattern] = useState('');
  const [scopeNote, setScopeNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!toolPattern.trim()) return;
    try {
      const rule = await api.rules.create({ kind, toolPattern: toolPattern.trim(), inputPattern, scopeNote });
      onCreated(rule);
      setToolPattern('');
      setInputPattern('');
      setScopeNote('');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create rule');
    }
  }

  return (
    <div className="mb-4 space-y-2 rounded-md border border-(--color-border) p-3">
      <div className="flex gap-2">
        {(['require', 'allow'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={clsx(
              'rounded px-3 py-1 text-xs font-medium',
              kind === k ? 'bg-(--color-accent) text-(--color-accent-fg)' : 'border border-(--color-border) text-(--color-text-muted)',
            )}
          >
            {k === 'require' ? 'Require approval' : 'Always allow'}
          </button>
        ))}
      </div>
      <input
        className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 font-mono text-sm"
        placeholder="Tool pattern (e.g. Bash, browser_*, *)"
        value={toolPattern}
        onChange={(e) => setToolPattern(e.target.value)}
      />
      <input
        className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 font-mono text-sm"
        placeholder="Input pattern (optional regex)"
        value={inputPattern}
        onChange={(e) => setInputPattern(e.target.value)}
      />
      <input
        className="w-full rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
        placeholder="Scope note (why this rule exists)"
        value={scopeNote}
        onChange={(e) => setScopeNote(e.target.value)}
      />
      {error && <p className="text-xs text-(--color-red)">{error}</p>}
      <button type="button" onClick={submit} className="rounded bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-fg)">
        Add rule
      </button>
    </div>
  );
}

export function RulesScreen() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.rules
      .list()
      .then(setRules)
      .finally(() => setLoading(false));
  }, []);

  async function toggle(rule: Rule) {
    const updated = await api.rules.update(rule.id, !rule.enabled);
    setRules((cur) => cur.map((r) => (r.id === updated.id ? updated : r)));
  }

  async function remove(rule: Rule) {
    if (rule.builtin) return;
    if (!window.confirm(`Delete rule for "${rule.toolPattern}"?`)) return;
    await api.rules.remove(rule.id);
    setRules((cur) => cur.filter((r) => r.id !== rule.id));
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 text-lg font-semibold">Rules</h1>
      <p className="mb-4 text-sm text-(--color-text-muted)">
        Require Approval always wins over Always Allow.
      </p>

      <AddRuleForm onCreated={(r) => setRules((cur) => [r, ...cur])} />

      {loading && <p className="text-sm text-(--color-text-muted)">Loading…</p>}
      {!loading && rules.length === 0 && <p className="text-sm text-(--color-text-muted)">No rules yet.</p>}

      <div className="space-y-2">
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-center justify-between gap-3 rounded-md border border-(--color-border) p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <KindBadge kind={rule.kind} />
                {rule.builtin && (
                  <span title="Built-in rule" aria-label="Built-in rule" className="text-(--color-text-faint)">
                    🔒
                  </span>
                )}
                <span className="truncate font-mono text-sm">{rule.toolPattern}</span>
              </div>
              {rule.inputPattern && <div className="mt-0.5 truncate font-mono text-xs text-(--color-text-muted)">{rule.inputPattern}</div>}
              {rule.scopeNote && <div className="mt-0.5 truncate text-xs text-(--color-text-faint)">{rule.scopeNote}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-(--color-text-muted)">
                <input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule)} />
                Enabled
              </label>
              <button
                type="button"
                onClick={() => remove(rule)}
                disabled={rule.builtin}
                className="rounded border border-(--color-red)/50 px-2 py-1 text-xs text-(--color-red) disabled:cursor-not-allowed disabled:opacity-30"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
