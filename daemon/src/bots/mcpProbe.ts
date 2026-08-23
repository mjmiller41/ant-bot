// A minimal MCP client, used only to answer "does this connector work, and what does it offer?"
//
// Advisory, never in the turn path: the Agent SDK does the real mounting. That is what makes a
// hand-rolled client acceptable here rather than a liability — if the protocol drifts, `antbot
// connector test` gets less useful, and nothing a bot depends on breaks. The alternative,
// depending on @modelcontextprotocol/sdk purely for a diagnostic, is a lot of surface for that.
//
// Everything is best-effort and bounded: any failure becomes `{ ok: false, error }`, and the
// child is always killed.
import { spawn } from 'node:child_process';
import { logger } from '../util/log.js';

const log = logger('mcp-probe');

/** The version we ask for; a server that prefers another one is free to say so and we accept it. */
const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProbeTool {
  name: string;
  description: string;
}

export interface ProbeResult {
  ok: boolean;
  tools: ProbeTool[];
  error?: string;
}

/** Tool descriptions can be enormous; a diagnostic listing does not need all of it. */
const MAX_DESCRIPTION = 200;

/** Pull the tool list out of a `tools/list` result, tolerating a server that omits fields. */
export function parseToolsResult(result: unknown): ProbeTool[] {
  const tools = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      name: String(t.name ?? ''),
      description: String(t.description ?? '').slice(0, MAX_DESCRIPTION),
    }))
    .filter((t) => t.name.length > 0);
}

const rpc = (id: number, method: string, params?: unknown): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`;

const notify = (method: string): string => `${JSON.stringify({ jsonrpc: '2.0', method })}\n`;

const failed = (error: string): ProbeResult => ({ ok: false, tools: [], error });

/** stdio: spawn the server and speak newline-delimited JSON-RPC on its pipes. */
async function probeStdio(
  cfg: { command: string; args?: string[]; env?: Record<string, string> },
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cfg.command, cfg.args ?? [], {
        // The server's own env plus the connector's — a connector that needs PATH still gets it.
        env: { ...process.env, ...(cfg.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve(failed((err as Error).message));
    }

    let settled = false;
    let stderr = '';
    let buffer = '';
    const finish = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always kill: a server that never answers must not outlive the probe.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(r);
    };

    const timer = setTimeout(
      () => finish(failed(`timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`)),
      timeoutMs,
    );

    child.on('error', (err) => finish(failed(err.message)));
    child.on('exit', (code) =>
      finish(failed(`server exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`)),
    );
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // servers do print the occasional stray line on stdout
        }
        if (msg.id === 1) {
          // Initialized; ask for the tools.
          try {
            child.stdin?.write(notify('notifications/initialized'));
            child.stdin?.write(rpc(2, 'tools/list'));
          } catch (err) {
            finish(failed((err as Error).message));
          }
        } else if (msg.id === 2) {
          if (msg.error) return finish(failed(JSON.stringify(msg.error).slice(0, 200)));
          finish({ ok: true, tools: parseToolsResult(msg.result) });
        }
      }
    });

    try {
      child.stdin?.write(
        rpc(1, 'initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ant-bot', version: '1.0.0' },
        }),
      );
    } catch (err) {
      finish(failed((err as Error).message));
    }
  });
}

/** Streamable HTTP: POST the same handshake, carrying the session id the server hands back. */
async function probeHttp(
  cfg: { url: string; headers?: Record<string, string> },
  timeoutMs: number,
): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const base = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(cfg.headers ?? {}),
  };

  // A streamable-HTTP server may answer with an SSE frame even for a single call.
  const readBody = async (res: Response): Promise<unknown> => {
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    try {
      return JSON.parse(line ? line.slice(5).trim() : text);
    } catch {
      return null;
    }
  };

  try {
    const initRes = await fetch(cfg.url, {
      method: 'POST', signal: ac.signal, headers: base,
      body: rpc(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ant-bot', version: '1.0.0' },
      }),
    });
    if (!initRes.ok) return failed(`initialize returned HTTP ${initRes.status}`);
    const session = initRes.headers.get('mcp-session-id');
    const withSession = session ? { ...base, 'mcp-session-id': session } : base;
    await readBody(initRes);

    await fetch(cfg.url, { method: 'POST', signal: ac.signal, headers: withSession, body: notify('notifications/initialized') })
      .catch(() => undefined); // some servers 202 or close this; not fatal

    const listRes = await fetch(cfg.url, {
      method: 'POST', signal: ac.signal, headers: withSession, body: rpc(2, 'tools/list'),
    });
    if (!listRes.ok) return failed(`tools/list returned HTTP ${listRes.status}`);
    const body = await readBody(listRes) as { result?: unknown; error?: unknown } | null;
    if (body?.error) return failed(JSON.stringify(body.error).slice(0, 200));
    return { ok: true, tools: parseToolsResult(body?.result) };
  } catch (err) {
    const e = err as Error;
    return failed(e.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connect to a connector's server and list its tools.
 *
 * Takes the already-substituted SDK config, so a caller must resolve secrets first — the probe
 * has no access to the keychain and no business holding one.
 */
export async function probeConnector(
  config: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const type = config.type as string | undefined;
  try {
    if (type === 'stdio') {
      return await probeStdio(config as { command: string; args?: string[]; env?: Record<string, string> }, timeoutMs);
    }
    if (type === 'http') {
      return await probeHttp(config as { url: string; headers?: Record<string, string> }, timeoutMs);
    }
    // SSE needs a persistent event stream and a separate POST endpoint the server advertises at
    // runtime — more client than a diagnostic justifies. Assign it and run a turn instead.
    if (type === 'sse') return failed('testing is not supported for sse connectors — assign it to a bot and run a turn');
    return failed(`unknown transport: ${String(type)}`);
  } catch (err) {
    log.warn('probe threw', err);
    return failed((err as Error).message);
  }
}
