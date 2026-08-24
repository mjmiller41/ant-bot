// A minimal MCP server, served by the daemon itself over streamable HTTP.
//
// This exists because some providers refuse every MCP client except their own allowlisted ones,
// which makes a self-contained ant-bot unable to use their MCP endpoint no matter how it signs in.
// The provider's plain REST API has no such rule. So ant-bot serves the connector: an MCP server
// whose tools are thin calls to that REST API, with the token held by the daemon and never handed
// to the agent runtime.
//
// Pure: `handleMcpRequest` maps one JSON-RPC request to one response with no I/O of its own. Tool
// handlers do the I/O, and they are injected. That is what makes the protocol layer testable
// against ant-bot's own probe client without a network.
import type { ZodType } from 'zod';

/** The MCP protocol revision this server speaks. Newer clients negotiate down; older ones match. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface ToolContext {
  /** A bearer for the provider's API, refreshed by the daemon before the call. */
  accessToken: string;
}

export interface BuiltinTool<A = unknown> {
  name: string;
  description: string;
  /** JSON Schema, as the client expects it. */
  inputSchema: Record<string, unknown>;
  /** Validates and types the arguments before the handler sees them. */
  parse: ZodType<A>;
  handler: (args: A, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 error codes the server uses. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
} as const;

const err = (id: string | number | null, code: number, message: string): JsonRpcResponse =>
  ({ jsonrpc: '2.0', id, error: { code, message } });
const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });

/** Text a tool returns when the provider call itself fails; never the raw response body. */
export const toolError = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });
export const toolText = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });

/**
 * Handle one request. Returns null for a notification (no id), which the HTTP layer answers with
 * 202 and no body, as the transport requires.
 */
export async function handleMcpRequest(
  body: unknown,
  server: { name: string; version: string; tools: BuiltinTool[] },
  ctx: () => Promise<ToolContext>,
): Promise<JsonRpcResponse | null> {
  const req = body as JsonRpcRequest | null;
  if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return err(null, RPC.INVALID_REQUEST, 'Expected a JSON-RPC 2.0 request');
  }
  const id = req.id ?? null;
  // Notifications carry no id and get no reply.
  if (req.id === undefined) return null;

  switch (req.method) {
    case 'initialize': {
      const asked = String(req.params?.protocolVersion ?? MCP_PROTOCOL_VERSION);
      return ok(id, {
        // Echo the client's version when it is one we can serve; the surface is small enough that
        // every revision since 2024-11-05 is compatible for these three methods.
        protocolVersion: asked,
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: server.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const tool = server.tools.find((t) => t.name === name);
      if (!tool) return err(id, RPC.INVALID_PARAMS, `Unknown tool: ${name}`);
      const parsed = tool.parse.safeParse(req.params?.arguments ?? {});
      if (!parsed.success) {
        return err(id, RPC.INVALID_PARAMS, `Invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      }
      let context: ToolContext;
      try {
        context = await ctx();
      } catch (e) {
        // Not signed in, or the token could not be refreshed. A tool error rather than an RPC
        // error, so the model reads a sentence instead of a code.
        return ok(id, toolError((e as Error).message));
      }
      try {
        return ok(id, await tool.handler(parsed.data, context));
      } catch (e) {
        return ok(id, toolError(`${name} failed: ${(e as Error).message}`));
      }
    }
    default:
      return err(id, RPC.METHOD_NOT_FOUND, `Method not supported: ${req.method}`);
  }
}
