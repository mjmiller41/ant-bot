#!/usr/bin/env node
// A minimal, dependency-free MCP server over stdio, for testing the probe and connector mounting.
//
// Deliberately not built on @modelcontextprotocol/sdk: the point is to exercise our own client
// against the wire protocol, and a fixture that shares a library with the code under test proves
// less. Newline-delimited JSON-RPC on stdin/stdout, which is what the transport is.
//
// `env_check` reports *whether* a variable is set, never its value — so a test can prove a secret
// reached the subprocess without that secret appearing in test output or CI logs.
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns the text it was given.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'env_check',
    description: 'Reports whether an environment variable is set, without revealing its value.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });

function callTool(params) {
  const { name, arguments: args = {} } = params ?? {};
  if (name === 'echo') return { content: [{ type: 'text', text: String(args.text ?? '') }] };
  if (name === 'env_check') {
    const set = Boolean(process.env[String(args.name ?? '')]);
    return { content: [{ type: 'text', text: set ? 'SET' : 'UNSET' }] };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // a malformed frame is the client's problem, not a reason to die
  }
  // Notifications carry no id and get no reply.
  if (msg.id === undefined) return;

  switch (msg.method) {
    case 'initialize':
      return ok(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-fixture', version: '1.0.0' },
      });
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS });
    case 'tools/call':
      return ok(msg.id, callTool(msg.params));
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  }
});
