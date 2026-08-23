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
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [surfaceFocused, setSurfaceFocused] = useState(false);
  const [actionNote, setActionNote] = useState<string | null>(null);

  useEffect(() => {
    api.computer.status().then((s) => {
      setStatus(s);
      if (s.pages.length > 0) setSelectedBotId(s.pages[0].botId);
    });
  }, []);

  /**
   * Put text the daemon read from the remote page onto the user's clipboard.
   *
   * `navigator.clipboard` needs a secure context, which `127.0.0.1` counts as, and recent user
   * activation — the Ctrl+C keypress that started this. It can still be refused, so failure is
   * reported rather than swallowed: silently not copying is what made the last round of this
   * feel broken.
   */
  async function writeClipboard(text: string): Promise<void> {
    if (!text) {
      setActionNote('Nothing is selected on the remote page.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setActionNote(`Copied ${text.length.toLocaleString()} character${text.length === 1 ? '' : 's'} from the page.`);
    } catch {
      setActionNote('The browser refused clipboard access, so the selection was not copied.');
    }
  }

  useEffect(() => {
    setFrame(null);
    wsRef.current?.close();
    if (!selectedBotId || !status?.available) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/computer/screencast/${selectedBotId}`);
    wsRef.current = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; data: string; w: number; h: number; text?: string; message?: string };
        if (msg.type === 'frame') setFrame({ data: msg.data, w: msg.w, h: msg.h });
        // Copy-out: the daemon read the remote page's selection; put it on the real clipboard.
        else if (msg.type === 'selection') void writeClipboard(msg.text ?? '');
        else if (msg.type === 'input-error') setActionNote(msg.message ?? 'Input was rejected.');
      } catch {
        // ignore malformed frames
      }
    };
    return () => ws.close();
  }, [selectedBotId, status?.available]);

  // Notes are transient — a stale "Copied 12 characters" is worse than none.
  useEffect(() => {
    if (!actionNote) return;
    const t = setTimeout(() => setActionNote(null), 4000);
    return () => clearTimeout(t);
  }, [actionNote]);

  // Taking over leaves focus on the button that was clicked, so keystrokes go to the button and
  // nothing reaches the page. Moving focus to the surface is what makes the keyboard work at all
  // without the user first guessing that they need to click the image.
  useEffect(() => {
    if (controlledByUser) surfaceRef.current?.focus();
  }, [controlledByUser]);

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
  function sendFrame(frame: ScreencastClientFrame): void {
    const ws = wsRef.current;
    if (!controlledByUser || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch { /* socket went away mid-gesture */ }
  }

  function sendInput(input: ScreencastInput): void {
    sendFrame({ type: 'input', input });
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

      <div
        ref={surfaceRef}
        // The focusable host is this wrapper, not the image: an <img> is not a keyboard control,
        // and focus has to survive the image element being re-rendered on every frame.
        tabIndex={controlledByUser ? 0 : -1}
        onFocus={() => setSurfaceFocused(true)}
        onBlur={() => setSurfaceFocused(false)}
        onKeyDown={(e) => {
          if (!controlledByUser) return;
          // Paste is the one shortcut we must NOT swallow. The remote page's clipboard is the
          // headless browser's, not yours, so forwarding Ctrl+V would paste nothing. Letting the
          // native paste event through instead delivers your clipboard to onPaste below.
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;

          // Copy and cut have to round-trip. Your browser would copy its own selection, which is
          // an image; the page's own copy would land on the headless browser's clipboard, which
          // you cannot read. So ask the daemon for the page's selection and write that instead.
          if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
            e.preventDefault();
            sendFrame({ type: 'selection-request' });
            // Cut also has to remove the text, and only the page can do that — so the keys still
            // go through. Copy needs nothing further.
            if (e.key.toLowerCase() === 'x') sendInput({ kind: 'key', action: 'down', key: e.key });
            return;
          }

          // Everything else is kept out of the host page: Tab would move focus off the surface,
          // Space and the arrows would scroll this pane instead of the remote one.
          e.preventDefault();
          // A printable character goes as text so the page gets the right glyph whatever the
          // keyboard layout; named keys and modifiers go as key events, which is what lets
          // Playwright reconstruct combinations like Ctrl+A on the far side.
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sendInput({ kind: 'text', text: e.key });
          else sendInput({ kind: 'key', action: 'down', key: e.key });
        }}
        onKeyUp={(e) => {
          if (!controlledByUser) return;
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
          e.preventDefault();
          if (!(e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)) sendInput({ kind: 'key', action: 'up', key: e.key });
        }}
        onPaste={(e) => {
          if (!controlledByUser) return;
          e.preventDefault();
          const text = e.clipboardData.getData('text');
          if (text) sendInput({ kind: 'text', text: text.slice(0, 4096) });
        }}
        className={`flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-3 outline-none ${
          controlledByUser && !surfaceFocused ? 'ring-2 ring-(--color-amber) ring-inset' : ''
        }`}
      >
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.data}`}
            width={frame.w}
            height={frame.h}
            alt="Agent computer screencast"
            draggable={false}
            onPointerMove={(e) => { const p = normPoint(e); if (p) sendInput({ kind: 'mouse', action: 'move', ...p, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0 }); }}
            onPointerDown={(e) => {
              const p = normPoint(e);
              if (!p) return;
              surfaceRef.current?.focus();
              sendInput({ kind: 'mouse', action: 'down', ...p, button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, deltaX: 0, deltaY: 0 });
            }}
            onPointerUp={(e) => { const p = normPoint(e); if (p) sendInput({ kind: 'mouse', action: 'up', ...p, button: BUTTONS[e.button] ?? 'left', clickCount: e.detail || 1, deltaX: 0, deltaY: 0 }); }}
            onWheel={(e) => { const p = normPoint(e); if (p) sendInput({ kind: 'mouse', action: 'wheel', ...p, button: 'left', clickCount: 1, deltaX: e.deltaX, deltaY: e.deltaY }); }}
            onContextMenu={(e) => { if (controlledByUser) e.preventDefault(); }}
            className={`max-h-full max-w-full rounded border border-(--color-border) ${
              controlledByUser ? 'cursor-crosshair' : 'pointer-events-none select-none'
            }`}
          />
        ) : (
          <p className="text-sm text-(--color-text-muted)">Waiting for a screencast frame…</p>
        )}
      </div>

      {controlledByUser && !surfaceFocused && (
        <p className="border-t border-(--color-border) bg-(--color-amber)/10 px-3 py-2 text-xs text-(--color-amber)">
          Click the screen to send keystrokes to it.
        </p>
      )}

      {actionNote && (
        <p className="border-t border-(--color-border) bg-(--color-bg-elevated) px-3 py-2 text-xs text-(--color-text-muted)">
          {actionNote}
        </p>
      )}
    </div>
  );
}
