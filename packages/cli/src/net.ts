import net from 'node:net';

export interface HealthResult {
  ok: boolean;
  version?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** TCP-connect probe: does anything answer on this port right now? */
export function probePort(port: number, host = '127.0.0.1'): Promise<'free' | 'occupied'> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (state: 'free' | 'occupied') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done('occupied'));
    socket.once('timeout', () => done('free'));
    socket.once('error', () => done('free'));
  });
}

export async function getHealth(port: number): Promise<HealthResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json().catch(() => null)) as { version?: string } | null;
    return { ok: true, version: typeof body?.version === 'string' ? body.version : undefined };
  } catch {
    return { ok: false };
  }
}

export async function getBotCount(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/bots`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    if (Array.isArray(body)) return body.length;
    if (body && typeof body === 'object' && Array.isArray((body as { bots?: unknown[] }).bots)) {
      return (body as { bots: unknown[] }).bots.length;
    }
    return null;
  } catch {
    return null;
  }
}

export async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const health = await getHealth(port);
    if (health.ok) return true;
    await sleep(300);
  } while (Date.now() < deadline);
  return false;
}

/* --------------------------- generic JSON helpers --------------------------- */

const BASE = (port: number): string => `http://127.0.0.1:${port}`;

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function getJson<T>(port: number, path: string): Promise<T> {
  return unwrap<T>(await fetch(`${BASE(port)}${path}`, { signal: AbortSignal.timeout(10_000) }));
}

export async function postJson<T>(port: number, path: string, body: unknown): Promise<T> {
  return unwrap<T>(
    await fetch(`${BASE(port)}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Cloning a repository can take a while on a slow link.
      signal: AbortSignal.timeout(180_000),
    }),
  );
}

export async function deleteJson<T>(port: number, path: string): Promise<T> {
  return unwrap<T>(
    await fetch(`${BASE(port)}${path}`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }),
  );
}
