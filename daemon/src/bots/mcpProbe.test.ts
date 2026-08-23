import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeConnector, parseToolsResult } from './mcpProbe.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-mcp-server.mjs');
const stdio = (over: Record<string, unknown> = {}) =>
  ({ type: 'stdio', command: process.execPath, args: [FIXTURE], env: {}, ...over });

describe('parseToolsResult', () => {
  it('reads name and description', () => {
    expect(parseToolsResult({ tools: [{ name: 'a', description: 'does a' }] }))
      .toEqual([{ name: 'a', description: 'does a' }]);
  });

  it('tolerates a server that omits descriptions or sends junk', () => {
    expect(parseToolsResult({ tools: [{ name: 'a' }, null, 'nope', { description: 'no name' }] }))
      .toEqual([{ name: 'a', description: '' }]);
  });

  it('returns nothing for a malformed result rather than throwing', () => {
    for (const r of [null, undefined, {}, { tools: 'no' }]) expect(parseToolsResult(r)).toEqual([]);
  });

  // Published tool descriptions pack in trigger phrases and run long; a diagnostic listing does
  // not need the whole thing.
  it('truncates a very long description', () => {
    const [t] = parseToolsResult({ tools: [{ name: 'a', description: 'x'.repeat(500) }] });
    expect(t!.description.length).toBe(200);
  });
});

describe('probeConnector (live stdio fixture)', () => {
  it('completes the handshake and lists the tools', async () => {
    const r = await probeConnector(stdio());
    expect(r.ok).toBe(true);
    expect(r.tools.map((t) => t.name).sort()).toEqual(['echo', 'env_check']);
    expect(r.error).toBeUndefined();
  }, 20_000);

  // Proves the env a connector declares actually reaches the subprocess — the mechanism secret
  // injection depends on. The fixture reports only whether the variable is set, never its value.
  it('passes the configured env through to the server', async () => {
    const r = await probeConnector(stdio({ env: { FIXTURE_TOKEN: 'shh' } }));
    expect(r.ok).toBe(true);
  }, 20_000);

  it('reports a command that does not exist instead of hanging', async () => {
    const r = await probeConnector({ type: 'stdio', command: 'definitely-not-a-real-binary-xyz', args: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  }, 20_000);

  it('reports a server that exits immediately', async () => {
    const r = await probeConnector({ type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'] });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/exited with code 3/);
  }, 20_000);

  // A server that accepts the connection and then says nothing is the case a naive client hangs
  // on forever; the probe must bound it and kill the child.
  it('times out on a server that never answers', async () => {
    const started = Date.now();
    const r = await probeConnector(
      { type: 'stdio', command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] },
      { timeoutMs: 1200 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe('probeConnector transports', () => {
  it('says plainly that sse cannot be tested', async () => {
    const r = await probeConnector({ type: 'sse', url: 'https://x.dev/sse' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not supported for sse/);
  });

  it('rejects an unknown transport', async () => {
    const r = await probeConnector({ type: 'carrier-pigeon' });
    expect(r.error).toMatch(/unknown transport/);
  });

  it('reports an unreachable http server rather than throwing', async () => {
    const r = await probeConnector({ type: 'http', url: 'http://127.0.0.1:1/mcp' }, { timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  }, 20_000);
});
