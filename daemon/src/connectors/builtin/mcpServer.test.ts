import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { handleMcpRequest, toolText, MCP_PROTOCOL_VERSION, RPC, type BuiltinTool } from './mcpServer.js';

const echo: BuiltinTool<any> = {
  name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  parse: z.object({ text: z.string() }),
  handler: async (a, ctx) => toolText(`${ctx.accessToken}:${a.text}`),
};
const boom: BuiltinTool<any> = {
  name: 'boom', description: 'throws', inputSchema: { type: 'object' }, parse: z.object({}),
  handler: async () => { throw new Error('provider exploded'); },
};
const server = { name: 'test', version: '1', tools: [echo, boom] };
const ctx = async () => ({ accessToken: 'tok' });
const rpc = (method: string, params?: unknown, id: string | number | null = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

describe('handleMcpRequest', () => {
  it('answers initialize with the negotiated version and tool capability', async () => {
    const r = await handleMcpRequest(rpc('initialize', { protocolVersion: '2024-11-05' }), server, ctx);
    expect(r).toMatchObject({ id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'test' } } });
    const r2 = await handleMcpRequest(rpc('initialize'), server, ctx);
    expect((r2!.result as any).protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  // The transport answers a notification with 202 and no body; null is the signal for that.
  it('returns null for a notification', async () => {
    expect(await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, server, ctx)).toBeNull();
  });

  it('lists tools with their schemas', async () => {
    const r = await handleMcpRequest(rpc('tools/list'), server, ctx);
    expect((r!.result as any).tools.map((t: any) => t.name)).toEqual(['echo', 'boom']);
    expect((r!.result as any).tools[0].inputSchema).toEqual(echo.inputSchema);
  });

  it('calls a tool with parsed arguments and the context token', async () => {
    const r = await handleMcpRequest(rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }), server, ctx);
    expect(r!.result).toEqual({ content: [{ type: 'text', text: 'tok:hi' }] });
  });

  it('rejects an unknown tool and bad arguments as invalid params', async () => {
    const a = await handleMcpRequest(rpc('tools/call', { name: 'nope' }), server, ctx);
    expect(a!.error?.code).toBe(RPC.INVALID_PARAMS);
    const b = await handleMcpRequest(rpc('tools/call', { name: 'echo', arguments: { text: 7 } }), server, ctx);
    expect(b!.error?.code).toBe(RPC.INVALID_PARAMS);
  });

  // A model reads tool results, not RPC codes: failures inside a call become isError text.
  it('turns a thrown handler into a tool error, not an RPC error', async () => {
    const r = await handleMcpRequest(rpc('tools/call', { name: 'boom', arguments: {} }), server, ctx);
    expect(r!.error).toBeUndefined();
    expect(r!.result).toMatchObject({ isError: true });
    expect((r!.result as any).content[0].text).toContain('provider exploded');
  });

  it('reports a missing sign-in as a tool error with the reason', async () => {
    const r = await handleMcpRequest(rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }), server,
      async () => { throw new Error('gmail is not signed in'); });
    expect(r!.result).toMatchObject({ isError: true });
    expect((r!.result as any).content[0].text).toMatch(/not signed in/);
  });

  it('rejects malformed requests and unknown methods', async () => {
    expect((await handleMcpRequest('junk', server, ctx))!.error?.code).toBe(RPC.INVALID_REQUEST);
    expect((await handleMcpRequest({ jsonrpc: '1.0', id: 1, method: 'ping' }, server, ctx))!.error?.code).toBe(RPC.INVALID_REQUEST);
    expect((await handleMcpRequest(rpc('resources/list'), server, ctx))!.error?.code).toBe(RPC.METHOD_NOT_FOUND);
  });

  it('answers ping and preserves string ids', async () => {
    expect(await handleMcpRequest(rpc('ping', undefined, 'abc'), server, ctx)).toEqual({ jsonrpc: '2.0', id: 'abc', result: {} });
  });
});
