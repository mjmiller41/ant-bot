import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ComputerView } from './ComputerView.js';

const takeover = vi.fn();
const returnControl = vi.fn();

vi.mock('../api/client.js', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    computer: {
      status: async () => ({ available: true, mode: 'host', pages: [{ botId: 'b1', url: 'https://x', title: 'X' }] }),
      takeover: (id: string) => takeover(id),
      returnControl: (id: string) => returnControl(id),
    },
  },
}));

/** Captures what the component sends on the screencast socket. */
const sent: unknown[] = [];
let sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    sockets.push(this);
  }
  send(raw: string) {
    sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
  }
  /** Push a frame in, the way the daemon does. */
  frame() {
    this.onmessage?.({ data: JSON.stringify({ type: 'frame', data: 'AAAA', w: 1280, h: 720 }) });
  }
  /** Reply to a selection-request, the way the daemon does. */
  selection(text: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'selection', text }) });
  }
}

beforeEach(() => {
  sent.length = 0;
  sockets = [];
  takeover.mockResolvedValue({ ok: true, message: 'Acting through the screencast view.' });
  returnControl.mockResolvedValue({ ok: true });
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

async function renderWithFrame() {
  render(<ComputerView />);
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  sockets[0]!.frame();
  return await screen.findByAltText('Agent computer screencast');
}

const frames = () => sent as { type: string }[];
const inputs = () => sent.filter((m): m is { type: string; input: Record<string, unknown> } =>
  typeof m === 'object' && m !== null && (m as { type?: string }).type === 'input').map((m) => m.input);

describe('ComputerView — takeover surface', () => {
  it('shows the explanation the daemon returns instead of silently flipping the button', async () => {
    await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(await screen.findByText(/Acting through the screencast view/)).toBeInTheDocument();
  });

  // The original bug: takeover left focus on the button it was clicked with, so every keystroke
  // went to the button and nothing reached the page. Keys "worked" only after clicking the image.
  it('moves focus to the surface on takeover, so typing works without clicking first', async () => {
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await screen.findByRole('button', { name: 'Return control' });

    const surface = img.parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(surface));

    fireEvent.keyDown(surface, { key: 'a' });
    expect(inputs()).toContainEqual({ kind: 'text', text: 'a' });
  });

  it('sends named keys, not just printable ones', async () => {
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const surface = img.parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(surface));

    fireEvent.keyDown(surface, { key: 'Backspace' });
    fireEvent.keyUp(surface, { key: 'Backspace' });
    expect(inputs()).toContainEqual({ kind: 'key', action: 'down', key: 'Backspace' });
    expect(inputs()).toContainEqual({ kind: 'key', action: 'up', key: 'Backspace' });
  });

  // Ctrl+V must reach the browser's own paste event. Swallowing the keydown suppressed it, and
  // forwarding Ctrl+V to the page would paste the *headless browser's* clipboard, not the user's.
  it('lets Ctrl+V through so the native paste event fires', async () => {
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const surface = img.parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(surface));

    const ev = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true });
    surface.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(inputs().some((i) => i.kind === 'key' && i.key === 'v')).toBe(false);
  });

  it('forwards pasted text as text', async () => {
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const surface = img.parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(surface));

    fireEvent.paste(surface, { clipboardData: { getData: () => 'pasted text' } });
    expect(inputs()).toContainEqual({ kind: 'text', text: 'pasted text' });
  });

  // Copy-out has to round-trip: your browser's own selection is a JPEG, and the page's clipboard
  // belongs to the headless browser. Ctrl+C must ask the daemon instead of copying locally.
  it('asks the daemon for the page selection on Ctrl+C and writes it to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const surface = img.parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(surface));

    const ev = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    surface.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(frames()).toContainEqual({ type: 'selection-request' });

    sockets[0]!.selection('text from the page');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('text from the page'));
    expect(await screen.findByText(/Copied 18 characters/)).toBeInTheDocument();
  });

  it('says so when nothing is selected rather than silently doing nothing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn() } });
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(document.activeElement).toBe(img.parentElement));

    sockets[0]!.selection('');
    expect(await screen.findByText(/Nothing is selected/)).toBeInTheDocument();
  });

  it('reports a refused clipboard instead of pretending it copied', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(document.activeElement).toBe(img.parentElement));

    sockets[0]!.selection('some text');
    expect(await screen.findByText(/refused clipboard access/)).toBeInTheDocument();
  });

  // Cut must both copy out and delete, and only the page can delete.
  it('forwards the key on Ctrl+X as well as asking for the selection', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn() } });
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const surface = img.parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(surface));

    fireEvent.keyDown(surface, { key: 'x', ctrlKey: true });
    expect(frames()).toContainEqual({ type: 'selection-request' });
    expect(inputs()).toContainEqual({ kind: 'key', action: 'down', key: 'x' });
  });

  it('sends nothing at all before takeover', async () => {
    const img = await renderWithFrame();
    const surface = img.parentElement!;
    fireEvent.keyDown(surface, { key: 'a' });
    fireEvent.pointerDown(img, { clientX: 10, clientY: 10, button: 0 });
    expect(inputs()).toHaveLength(0);
  });

  it('stops sending once control is returned', async () => {
    const img = await renderWithFrame();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    const surface = img.parentElement!;
    await waitFor(() => expect(document.activeElement).toBe(surface));
    fireEvent.click(screen.getByRole('button', { name: 'Return control' }));
    await screen.findByRole('button', { name: 'Take over' });

    sent.length = 0;
    fireEvent.keyDown(surface, { key: 'a' });
    expect(inputs()).toHaveLength(0);
  });
});
