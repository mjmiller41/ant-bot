import { describe, it, expect } from 'vitest';
import { splitCommand, buildConfigFromFlags } from './connector.js';

describe('splitCommand', () => {
  it('splits a plain command line', () => {
    expect(splitCommand('npx -y @scope/server')).toEqual({ command: 'npx', args: ['-y', '@scope/server'] });
  });

  // A path with a space is the ordinary reason someone quotes an argument.
  it('honours quotes so a path with a space survives', () => {
    expect(splitCommand('node "/my dir/server.mjs"')).toEqual({ command: 'node', args: ['/my dir/server.mjs'] });
    expect(splitCommand("node '/my dir/x.mjs'")).toEqual({ command: 'node', args: ['/my dir/x.mjs'] });
  });

  it('collapses extra whitespace', () => {
    expect(splitCommand('  npx   -y   srv ')).toEqual({ command: 'npx', args: ['-y', 'srv'] });
  });

  // Not a shell. The daemon spawns the command directly, so operators are inert text rather
  // than something that gets interpreted somewhere later.
  it('treats shell operators as ordinary arguments', () => {
    expect(splitCommand('srv && rm -rf /').args).toContain('&&');
  });

  it('reports an empty command rather than guessing', () => {
    expect(splitCommand('')).toEqual({ command: '', args: [] });
  });
});

describe('buildConfigFromFlags', () => {
  const ok = (r: ReturnType<typeof buildConfigFromFlags>) => {
    if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
    return r.config;
  };

  it('builds a stdio config with repeated --env pairs', () => {
    const c = ok(buildConfigFromFlags(['add', 'gh', '--stdio', 'npx -y srv', '--env', 'A=1', '--env', 'B=2']));
    expect(c).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1', B: '2' } });
  });

  it('keeps a secret reference verbatim for the daemon to resolve', () => {
    const c = ok(buildConfigFromFlags(['add', 'gh', '--stdio', 'srv', '--env', 'TOKEN={{secret:GH}}']));
    expect(c.env).toEqual({ TOKEN: '{{secret:GH}}' });
  });

  it('keeps an = inside the value', () => {
    const c = ok(buildConfigFromFlags(['add', 'x', '--stdio', 'srv', '--env', 'Q=a=b']));
    expect(c.env).toEqual({ Q: 'a=b' });
  });

  it('builds an http config, defaulting the transport', () => {
    const c = ok(buildConfigFromFlags(['add', 'r', '--url', 'https://x.dev/mcp', '--header', 'Authorization=Bearer {{secret:T}}']));
    expect(c).toEqual({
      transport: 'http', url: 'https://x.dev/mcp',
      headers: { Authorization: 'Bearer {{secret:T}}' },
    });
  });

  it('accepts sse and a comma-separated tool allowlist', () => {
    const c = ok(buildConfigFromFlags(['add', 'r', '--url', 'https://x.dev/sse', '--transport', 'sse', '--tools', 'a, b ,']));
    expect(c).toMatchObject({ transport: 'sse', tools: ['a', 'b'] });
  });

  it('omits tools entirely when the flag is absent', () => {
    expect(ok(buildConfigFromFlags(['add', 'r', '--url', 'https://x.dev/mcp']))).not.toHaveProperty('tools');
  });

  it('explains what is missing instead of building something half-formed', () => {
    expect(buildConfigFromFlags(['add', 'x'])).toMatchObject({ error: expect.stringContaining('--stdio') });
    expect(buildConfigFromFlags(['add', 'x', '--stdio', ''])).toMatchObject({ error: expect.stringContaining('command') });
    expect(buildConfigFromFlags(['add', 'x', '--stdio', 'a', '--url', 'https://b'])).toMatchObject({
      error: expect.stringContaining('not both'),
    });
    expect(buildConfigFromFlags(['add', 'x', '--url', 'https://b', '--transport', 'carrier-pigeon'])).toMatchObject({
      error: expect.stringContaining('http or sse'),
    });
  });
});
