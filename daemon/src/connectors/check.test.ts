import { describe, it, expect } from 'vitest';
import { decideCheck, type CheckSignals } from './check.js';

const tools = [{ name: 'a', description: 'A' }];
const base: CheckSignals = { probe: { ok: true, tools }, challenge: 'none', missingSecrets: [] };
const as = (registrationEndpoint?: string) => ({
  resource: { authorizationServers: ['https://accounts.google.com/'], scopesSupported: [], resource: 'r' },
  authServer: { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 't', registrationEndpoint, scopesSupported: [] },
});

describe('decideCheck', () => {
  // The user's actual dead end: Google's MCP endpoint, a working sign-in, and every call refused.
  it('points a Google MCP URL at the built-in instead of a sign-in that cannot help', () => {
    const v = decideCheck({ ...base, challenge: 'auth', discovery: as() });
    expect(v.status).toBe('needs-sign-in');
    expect(v.alternative).toBe('gmail');
    expect(v.detail).toMatch(/antbot mcp add gmail/);
  });

  it('is ready when reachable and unchallenged', () => {
    expect(decideCheck(base)).toEqual({ status: 'ready', tools });
  });

  // The whole reason this exists: a server that lists its tools to anyone but refuses a real call
  // must not be called ready.
  it('is needs-sign-in when a real call was challenged, naming the provider', () => {
    const v = decideCheck({ ...base, challenge: 'auth', discovery: as() });
    expect(v).toMatchObject({ status: 'needs-sign-in', selfRegistration: false, provider: 'accounts.google.com' });
    expect(v.tools).toEqual(tools);
  });

  it('reports self-registration when the provider offers it', () => {
    expect(decideCheck({ ...base, challenge: 'auth', discovery: as('https://x/register') }).selfRegistration).toBe(true);
  });

  it('still says needs-sign-in when challenged with no discoverable provider', () => {
    expect(decideCheck({ ...base, challenge: 'auth', discovery: null })).toMatchObject({ status: 'needs-sign-in', selfRegistration: false });
  });

  it('is needs-credential before anything is even tried', () => {
    expect(decideCheck({ probe: null, challenge: 'none', missingSecrets: ['X'] })).toMatchObject({ status: 'needs-credential', detail: expect.stringContaining('X') });
  });

  it('is unreachable when the probe failed', () => {
    expect(decideCheck({ probe: { ok: false, tools: [], error: 'ECONNREFUSED' }, challenge: 'unreachable', missingSecrets: [] }))
      .toEqual({ status: 'unreachable', tools: [], detail: 'ECONNREFUSED' });
  });

  it('judges a built-in by whether the daemon holds a sign-in', () => {
    const g = { name: 'Google', dynamicRegistration: false };
    expect(decideCheck({ ...base, builtinProvider: g, builtinSignedIn: true })).toEqual({ status: 'ready', tools, provider: 'Google' });
    expect(decideCheck({ ...base, builtinProvider: g, builtinSignedIn: false })).toMatchObject({ status: 'needs-sign-in', selfRegistration: false, provider: 'Google' });
  });
});

describe('decideCheck — a sign-in older than the scopes now asked for', () => {
  const builtin = {
    probe: null,
    challenge: 'none' as const,
    missingSecrets: [],
    builtinProvider: { name: 'Google', dynamicRegistration: false },
  };

  // The trap: broadening the requested scopes changes nothing until the human signs in again,
  // and until then the connector looks perfectly healthy while every call needing the new
  // permission is refused.
  it('asks for a new sign-in when the stored token lacks a requested scope', () => {
    const v = decideCheck({ ...builtin, builtinSignedIn: true, builtinMissingScopes: ['https://mail.google.com/'] });
    expect(v.status).toBe('needs-sign-in');
    expect(v.detail).toMatch(/1 newer permission/);
  });

  it('stays ready when the token carries everything asked for', () => {
    expect(decideCheck({ ...builtin, builtinSignedIn: true, builtinMissingScopes: [] }).status).toBe('ready');
    expect(decideCheck({ ...builtin, builtinSignedIn: true }).status).toBe('ready');
  });

  it('still reports a plain needs-sign-in when there is no token at all', () => {
    const v = decideCheck({ ...builtin, builtinSignedIn: false, builtinMissingScopes: [] });
    expect(v.status).toBe('needs-sign-in');
    expect(v.detail).toBeUndefined();
  });
});
