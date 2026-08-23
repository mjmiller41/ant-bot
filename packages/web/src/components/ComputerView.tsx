import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

interface ComputerStatus {
  available: boolean;
  mode: string;
  pages: { botId: string; url: string; title: string }[];
}

export function ComputerView() {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [frame, setFrame] = useState<{ data: string; w: number; h: number } | null>(null);
  const [controlledByUser, setControlledByUser] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    api.computer.status().then((s) => {
      setStatus(s);
      if (s.pages.length > 0) setSelectedBotId(s.pages[0].botId);
    });
  }, []);

  useEffect(() => {
    setFrame(null);
    wsRef.current?.close();
    if (!selectedBotId || !status?.available) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/computer/screencast/${selectedBotId}`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; data: string; w: number; h: number };
        if (msg.type === 'frame') setFrame({ data: msg.data, w: msg.w, h: msg.h });
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, [selectedBotId, status?.available]);

  async function takeover() {
    if (!selectedBotId) return;
    const res = await api.computer.takeover(selectedBotId);
    setControlledByUser(res.ok);
  }

  async function returnControl() {
    if (!selectedBotId) return;
    await api.computer.returnControl(selectedBotId);
    setControlledByUser(false);
  }

  if (!status) {
    return <p className="p-6 text-sm text-(--color-text-muted)">Checking the computer service…</p>;
  }

  if (!status.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium">The agent computer isn&apos;t available right now.</p>
        <p className="max-w-sm text-xs text-(--color-text-muted)">
          Bots can still browse the web and use tools — you just won&apos;t see a live screencast until the computer
          service starts.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-(--color-border) p-3">
        <select
          className="rounded border border-(--color-border) bg-(--color-bg) px-2 py-1 text-sm"
          value={selectedBotId ?? ''}
          onChange={(e) => setSelectedBotId(e.target.value || null)}
        >
          {status.pages.length === 0 && <option value="">No active pages</option>}
          {status.pages.map((p) => (
            <option key={p.botId} value={p.botId}>
              {p.title || p.url}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          {controlledByUser ? (
            <button type="button" onClick={returnControl} className="rounded bg-(--color-accent) px-3 py-1.5 text-xs font-medium text-(--color-accent-fg)">
              Return control
            </button>
          ) : (
            <button
              type="button"
              onClick={takeover}
              disabled={!selectedBotId}
              className="rounded border border-(--color-border) px-3 py-1.5 text-xs font-medium hover:bg-(--color-bg-hover) disabled:opacity-40"
            >
              Take over
            </button>
          )}
        </div>
      </div>

      <p className="border-b border-(--color-border) bg-(--color-amber)/10 px-3 py-2 text-xs text-(--color-amber)">
        Never paste passwords or one-time codes into chat — use takeover.
      </p>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-3">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            width={frame.w}
            height={frame.h}
            alt="Agent computer screencast"
            className="max-h-full max-w-full rounded border border-(--color-border)"
          />
        ) : (
          <p className="text-sm text-(--color-text-muted)">Waiting for a screencast frame…</p>
        )}
      </div>
    </div>
  );
}
