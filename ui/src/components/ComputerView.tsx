import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { ScreencastInput, ScreencastClientFrame } from '@antbot/contract';

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
  const [takeoverNote, setTakeoverNote] = useState<string | null>(null);
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
    // The server explains what taking over actually did — headless has no window to raise, and
    // the screencast does not forward input. Dropping this message is what makes takeover look
    // broken: the button flips and nothing tells you the view is still read-only.
    setTakeoverNote(res.message ?? null);
  }

  async function returnControl() {
    if (!selectedBotId) return;
    await api.computer.returnControl(selectedBotId);
    setControlledByUser(false);
    setTakeoverNote(null);
  }

  /** Send input on the screencast socket. No-ops unless we hold control — the daemon refuses
   *  anyway, but there is no reason to make it say so on every mouse move. */
  function sendInput(input: ScreencastInput): void {
    const ws = wsRef.current;
    if (!controlledByUser || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'input', input } satisfies ScreencastClientFrame));
    } catch { /* socket went away mid-gesture */ }
  }

  /** Pointer position as a fraction of the rendered image — see ScreencastInputSchema for why
   *  this is normalised rather than pixels. */
  function normPoint(e: React.PointerEvent<HTMLImageElement> | React.WheelEvent<HTMLImageElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }

  const BUTTONS = ['left', 'middle', 'right'] as const;

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

      {takeoverNote && (
        <p className="border-b border-(--color-border) bg-(--color-bg-elevated) px-3 py-2 text-xs text-(--color-text-muted)">
          {takeoverNote}
        </p>
      )}

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-3">
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            width={frame.w}
            height={frame.h}
            alt="Agent computer screencast"
            // tabIndex makes the image focusable so it can receive key events at all.
            tabIndex={controlledByUser ? 0 : -1}
            draggable={false}
            onPointerMove={(e) => { const p = normPoint(e); if (p) sendInput({ kind: 'mouse', action: 'move', ...p, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0 }); }}
            onPointerDown={(e) => {
              const p = normPoint(e);
              if (!p) return;
              e.currentTarget.focus();
              sendInput({ kind: 'mouse', action: 'down', ...p, button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, deltaX: 0, deltaY: 0 });
            }}
            onPointerUp={(e) => { const p = normPoint(e); if (p) sendInput({ kind: 'mouse', action: 'up', ...p, button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, deltaX: 0, deltaY: 0 }); }}
            onWheel={(e) => { const p = normPoint(e); if (p) sendInput({ kind: 'mouse', action: 'wheel', ...p, button: 'left', clickCount: 1, deltaX: e.deltaX, deltaY: e.deltaY }); }}
            onContextMenu={(e) => { if (controlledByUser) e.preventDefault(); }}
            onKeyDown={(e) => {
              if (!controlledByUser) return;
              // Keep the gesture out of the host page: Tab would move focus out of the view and
              // Space/arrows would scroll the pane instead of the remote page.
              e.preventDefault();
              // A printable character is sent as text so the page receives the right glyph
              // regardless of keyboard layout; everything else goes as a named key.
              if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sendInput({ kind: 'text', text: e.key });
              else sendInput({ kind: 'key', action: 'down', key: e.key });
            }}
            onKeyUp={(e) => {
              if (!controlledByUser) return;
              e.preventDefault();
              if (!(e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) sendInput({ kind: 'key', action: 'up', key: e.key });
            }}
            onPaste={(e) => {
              if (!controlledByUser) return;
              e.preventDefault();
              const text = e.clipboardData.getData('text');
              if (text) sendInput({ kind: 'text', text: text.slice(0, 4096) });
            }}
            className={`max-h-full max-w-full rounded border border-(--color-border) ${
              controlledByUser ? 'cursor-crosshair outline-2 outline-(--color-accent)' : 'pointer-events-none select-none'
            }`}
          />
        ) : (
          <p className="text-sm text-(--color-text-muted)">Waiting for a screencast frame…</p>
        )}
      </div>
    </div>
  );
}
