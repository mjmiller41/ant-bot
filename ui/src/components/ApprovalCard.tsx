import { useState } from 'react';
import type { Approval } from '@antbot/contract';

export interface AlwaysAllowScope {
  toolPattern: string;
  inputPattern: string;
  scopeNote: string;
}

export interface ApprovalCardProps {
  approval: Approval;
  onAllow: () => void;
  onDeny: () => void;
  onAlwaysAllow: (scope: AlwaysAllowScope) => void;
}

export function ApprovalCard({ approval, onAllow, onDeny, onAlwaysAllow }: ApprovalCardProps) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const [toolPattern, setToolPattern] = useState(approval.toolName);
  const [inputPattern, setInputPattern] = useState('');
  const [scopeNote, setScopeNote] = useState('');
  const resolved = approval.status !== 'pending';

  return (
    <div className="rounded-md border border-(--color-border) border-l-4 border-l-(--color-amber) bg-(--color-bg-elevated) p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-(--color-amber)/15 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-(--color-amber)">
            Approval needed
          </span>
          <span className="font-mono text-sm font-semibold">{approval.toolName}</span>
        </div>
        {resolved && (
          <span className="text-xs text-(--color-text-muted)">
            {approval.status === 'allowed' ? 'Allowed' : approval.status === 'denied' ? 'Denied' : approval.status}
          </span>
        )}
      </div>

      <p className="mt-1.5 text-sm text-(--color-text)">{approval.inputSummary}</p>

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-(--color-text-muted) select-none">Raw input</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded border border-(--color-border) bg-(--color-bg) p-2 font-mono">
          {JSON.stringify(approval.rawInput, null, 2)}
        </pre>
      </details>

      {!resolved && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onAllow}
            className="rounded bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-fg) hover:opacity-90"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={onDeny}
            className="rounded border border-(--color-red) px-3 py-1.5 text-sm font-medium text-(--color-red) hover:bg-(--color-red)/10"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            className="rounded border border-(--color-border) px-3 py-1.5 text-sm font-medium text-(--color-text) hover:bg-(--color-bg-hover)"
          >
            Always allow…
          </button>
        </div>
      )}

      {scopeOpen && !resolved && (
        <form
          className="mt-3 space-y-2 rounded border border-(--color-border) bg-(--color-bg) p-3"
          onSubmit={(e) => {
            e.preventDefault();
            onAlwaysAllow({ toolPattern, inputPattern, scopeNote });
            setScopeOpen(false);
          }}
        >
          <label className="block text-xs">
            <span className="mb-1 block text-(--color-text-muted)">Tool pattern</span>
            <input
              className="w-full rounded border border-(--color-border) bg-(--color-bg-elevated) px-2 py-1 font-mono text-sm"
              value={toolPattern}
              onChange={(e) => setToolPattern(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block text-(--color-text-muted)">Input pattern (optional, regex)</span>
            <input
              className="w-full rounded border border-(--color-border) bg-(--color-bg-elevated) px-2 py-1 font-mono text-sm"
              value={inputPattern}
              onChange={(e) => setInputPattern(e.target.value)}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block text-(--color-text-muted)">Scope note</span>
            <input
              className="w-full rounded border border-(--color-border) bg-(--color-bg-elevated) px-2 py-1 text-sm"
              value={scopeNote}
              onChange={(e) => setScopeNote(e.target.value)}
              placeholder="Why is this safe to always allow?"
            />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-(--color-text-muted) hover:bg-(--color-bg-hover)"
              onClick={() => setScopeOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-fg) hover:opacity-90"
            >
              Save rule
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
