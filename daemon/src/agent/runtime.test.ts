import { describe, it, expect } from 'vitest';
import { ClaudeRuntime, type MountedConnector } from './runtime.js';

const stdio: MountedConnector = { type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' } };
const http: MountedConnector = { type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } };

describe('ClaudeRuntime.mountConnectors', () => {
  it('passes each connector through under its own name', () => {
    const out = new ClaudeRuntime().mountConnectors({ a: stdio, b: http });
    expect(Object.keys(out)).toEqual(['a', 'b']);
    expect(out.a).toMatchObject(stdio);
    expect(out.b).toMatchObject(http);
  });

  // Without alwaysLoad the SDK defers MCP tools behind ToolSearch, and a connector that failed to
  // mount is indistinguishable from one the model simply had not searched for yet.
  it('marks every connector alwaysLoad so its tools are in the prompt', () => {
    const out = new ClaudeRuntime().mountConnectors({ a: stdio, b: http });
    for (const v of Object.values(out)) expect(v).toMatchObject({ alwaysLoad: true });
  });

  it('does not mutate what it was given', () => {
    const input = { a: { ...stdio } };
    new ClaudeRuntime().mountConnectors(input);
    expect(input.a).not.toHaveProperty('alwaysLoad');
  });

  it('is empty for no connectors', () => {
    expect(new ClaudeRuntime().mountConnectors({})).toEqual({});
  });
});
