import { describe, it, expect } from 'vitest';
import {
  splitCommand,
  looksLikeUrl,
  collectFlag,
  flagValue,
  planPairs,
  secretNameFor,
  resolveBots,
  describeVerdict,
} from './mcp.js';

describe('splitCommand', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommand('npx -y @modelcontextprotocol/server-github')).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    });
    expect(splitCommand(`node "/a dir/server.js" --flag 'x y'`)).toEqual({
      command: 'node',
      args: ['/a dir/server.js', '--flag', 'x y'],
    });
  });

  it('returns an empty command for blank input', () => {
    expect(splitCommand('   ').command).toBe('');
  });
});

describe('looksLikeUrl', () => {
  it('recognises http(s) and nothing else', () => {
    expect(looksLikeUrl('https://mcp.vercel.com')).toBe(true);
    expect(looksLikeUrl('  http://127.0.0.1:8000/mcp')).toBe(true);
    expect(looksLikeUrl('npx -y server')).toBe(false);
    expect(looksLikeUrl('ftp://x')).toBe(false);
  });
});

describe('flags', () => {
  it('collects a repeatable flag in order', () => {
    expect(collectFlag(['--env', 'A=1', '--bots', 'all', '--env', 'TOKEN'], '--env')).toEqual(['A=1', 'TOKEN']);
  });
  it('reads a single flag value', () => {
    expect(flagValue(['add', 'x', '--bots', 'all'], '--bots')).toBe('all');
    expect(flagValue(['add', 'x'], '--bots')).toBeUndefined();
  });
});

describe('planPairs', () => {
  // The rule that keeps a token off the command line and out of the config: a bare key means
  // "prompt me", and the stored value is a keychain reference.
  it('treats KEY=value as a literal and a bare KEY as a secret to prompt for', () => {
    expect(planPairs(['PORT=8080', 'GITHUB_TOKEN'])).toEqual([
      { key: 'PORT', value: '8080', secret: false },
      { key: 'GITHUB_TOKEN', value: '', secret: true },
    ]);
  });
  it('keeps an = inside the value', () => {
    expect(planPairs(['URL=https://x?a=b'])[0]).toEqual({ key: 'URL', value: 'https://x?a=b', secret: false });
  });
  it('namespaces the secret under the connector so two servers with the same var do not collide', () => {
    expect(secretNameFor('github', 'TOKEN')).toBe('mcp/github/TOKEN');
  });
});

describe('resolveBots', () => {
  const roster = [
    { bot: { id: '1', name: 'Scout', slug: 'scout' } },
    { bot: { id: '2', name: 'Personal Assistant', slug: 'personal-assistant' } },
  ];
  it('asks when the flag is absent', () => {
    expect(resolveBots(undefined, roster)).toBe('ask');
  });
  it('maps all, none, slugs and names', () => {
    expect(resolveBots('all', roster)).toEqual(['1', '2']);
    expect(resolveBots('none', roster)).toBeNull();
    expect(resolveBots('scout,Personal Assistant', roster)).toEqual(['1', '2']);
    expect(resolveBots('personal-assistant', roster)).toEqual(['2']);
  });
  it('drops names it does not know rather than guessing', () => {
    expect(resolveBots('nobody', roster)).toEqual([]);
  });
});

describe('describeVerdict', () => {
  const tools = [{ name: 'a', description: '' }, { name: 'b', description: '' }];
  it('says what to do next for each verdict', () => {
    expect(describeVerdict('x', { status: 'ready', tools })).toMatch(/ready, 2 tools/);
    expect(describeVerdict('x', { status: 'needs-sign-in', provider: 'Google', tools })).toMatch(/needs sign-in \(Google\)/);
    expect(describeVerdict('x', { status: 'needs-credential', tools: [], detail: 'missing secret mcp/x/TOKEN' })).toMatch(/missing secret/);
    expect(describeVerdict('x', { status: 'unreachable', tools: [], detail: 'ECONNREFUSED' })).toMatch(/unreachable — ECONNREFUSED/);
  });
  it('names the built-in instead of a sign-in that cannot help', () => {
    const v = describeVerdict('gmail-mcp', { status: 'needs-sign-in', provider: 'accounts.google.com', tools, alternative: 'gmail', detail: 'Use the built-in instead: antbot mcp add gmail' });
    expect(v).toMatch(/✗ gmail-mcp: Use the built-in instead: antbot mcp add gmail/);
  });

  it('singularises one tool', () => {
    expect(describeVerdict('x', { status: 'ready', tools: [tools[0]!] })).toMatch(/1 tool$/);
  });
});
