import { useEffect, useState } from 'react';
import type { SearchResult } from '@antbot/contract';
import { api } from '../api/client.js';

export type PaletteTarget =
  | { kind: 'thread'; id: string }
  | { kind: 'newBot' }
  | { kind: 'settings' }
  | { kind: 'rules' }
  | { kind: 'usage' }
  | { kind: 'workspace' };

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (target: PaletteTarget) => void;
}

const STATIC_ACTIONS: { label: string; target: PaletteTarget }[] = [
  { label: 'New bot', target: { kind: 'newBot' } },
  { label: 'Open settings', target: { kind: 'settings' } },
  { label: 'Open rules', target: { kind: 'rules' } },
  { label: 'Open usage', target: { kind: 'usage' } },
  { label: 'Open workspace', target: { kind: 'workspace' } },
];

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
    }
  }, [open]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      api.search(query).then((r) => {
        if (!cancelled) setResults(r);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  if (!open) return null;

  const actions = STATIC_ACTIONS.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()));

  function go(target: PaletteTarget) {
    onNavigate(target);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-(--color-border) bg-(--color-bg-elevated) shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
          placeholder="Search bots, threads, messages, files… or run a command"
          className="w-full border-b border-(--color-border) bg-transparent px-4 py-3 text-sm outline-none"
        />
        <div className="max-h-96 overflow-y-auto p-1.5">
          {actions.length > 0 && (
            <div className="mb-1">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-(--color-text-faint)">Actions</div>
              {actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => go(a.target)}
                  className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm hover:bg-(--color-bg-hover)"
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {results.length > 0 && (
            <div>
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-(--color-text-faint)">Results</div>
              {results.map((r) => (
                <button
                  key={`${r.kind}-${r.id}`}
                  type="button"
                  onClick={() => r.threadId && go({ kind: 'thread', id: r.threadId })}
                  className="flex w-full flex-col items-start rounded px-2.5 py-1.5 text-left text-sm hover:bg-(--color-bg-hover)"
                >
                  <span className="flex items-center gap-2">
                    <span className="rounded bg-(--color-border) px-1 text-[10px] uppercase text-(--color-text-muted)">{r.kind}</span>
                    <span className="truncate font-medium">{r.title}</span>
                  </span>
                  {r.snippet && <span className="truncate text-xs text-(--color-text-muted)">{r.snippet}</span>}
                </button>
              ))}
            </div>
          )}
          {query.trim() && actions.length === 0 && results.length === 0 && (
            <p className="px-2.5 py-4 text-center text-sm text-(--color-text-muted)">No results.</p>
          )}
        </div>
      </div>
    </div>
  );
}
