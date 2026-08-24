import { describe, it, expect } from 'vitest';
import type { Connector } from '@antbot/contract';
import { ConnectorAuthService, tokenSecretName, clientSecretName, redirectUri, type TokenStore } from './auth.js';

function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const store: TokenStore = {
    async set(n, v) { map.set(n, v); },
    async remove(n) { map.delete(n); },
    async resolve(names) { return new Map(names.map((n) => [n, map.get(n) ?? null])); },
    list() { return [...map.keys()]; },
  };
  return { store, map };
}

const httpConnector = (over: Partial<Connector> = {}): Connector => ({
  id: 'c1', name: 'gmail', description: '', enabled: true, createdAt: 0,
  config: { transport: 'http', url: 'https://x.dev/mcp', headers: {} }, ...over,
});

describe('token storage', () => {
  // Namespaced so a connector's tokens can never collide with, or be mistaken for, a secret the
  // human created for a {{secret:NAME}} reference.
  it('namespaces the keychain entry', () => {
    expect(tokenSecretName('gmail')).toBe('antbot:oauth:gmail');
  });

  // Separate key from the tokens: client credentials are registered once and outlive them, so a
  // second sign-in after an expiry or a failed exchange does not ask for them again.
  it('stores client credentials under their own key', () => {
    expect(clientSecretName('gmail')).toBe('antbot:oauth-client:gmail');
    expect(clientSecretName('gmail')).not.toBe(tokenSecretName('gmail'));
  });

  it('builds a loopback redirect on the daemon port', () => {
    expect(redirectUri(4780)).toBe('http://127.0.0.1:4780/api/connectors/oauth/callback');
  });
});

describe('isAuthorized', () => {
  it('reports on names alone, without reading a token', () => {
    const { store } = fakeStore({ 'antbot:oauth:gmail': '{}' });
    let read = false;
    const spy: TokenStore = { ...store, async resolve(n) { read = true; return store.resolve(n); } };
    const svc = new ConnectorAuthService(spy, 4780);
    expect(svc.isAuthorized('gmail')).toBe(true);
    expect(svc.isAuthorized('other')).toBe(false);
    expect(read).toBe(false);
  });
});

describe('authHeader', () => {
  const tokens = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ accessToken: 'at', tokenEndpoint: 'https://a.dev/token', clientId: 'cid', ...over });

  it('returns a bearer for a signed-in connector', async () => {
    const { store } = fakeStore({ 'antbot:oauth:gmail': tokens() });
    expect(await new ConnectorAuthService(store, 4780).authHeader('gmail'))
      .toEqual({ Authorization: 'Bearer at' });
  });

  // Not an error: most connectors use a static credential or none at all.
  it('returns null when the connector was never signed in', async () => {
    const { store } = fakeStore();
    expect(await new ConnectorAuthService(store, 4780).authHeader('gmail')).toBeNull();
  });

  it('treats an unreadable blob as not signed in', async () => {
    const { store } = fakeStore({ 'antbot:oauth:gmail': 'not json' });
    expect(await new ConnectorAuthService(store, 4780).authHeader('gmail')).toBeNull();
  });

  // Mounting with a token known to be dead produces an opaque 401 in the middle of a bot's work;
  // refusing to mount reports it once, where someone can act on it.
  it('returns null rather than a stale token when refresh is impossible', async () => {
    const { store } = fakeStore({
      'antbot:oauth:gmail': tokens({ expiresAt: 1, refreshToken: undefined }),
    });
    expect(await new ConnectorAuthService(store, 4780).authHeader('gmail')).toBeNull();
  });

  it('does not refresh a token with no stated expiry', async () => {
    const { store } = fakeStore({ 'antbot:oauth:gmail': tokens() });
    expect(await new ConnectorAuthService(store, 4780).authHeader('gmail')).toEqual({ Authorization: 'Bearer at' });
  });
});

describe('signOut', () => {
  it('drops the stored tokens', async () => {
    const { store, map } = fakeStore({ 'antbot:oauth:gmail': '{}' });
    const svc = new ConnectorAuthService(store, 4780);
    await svc.signOut('gmail');
    expect(map.has('antbot:oauth:gmail')).toBe(false);
    expect(svc.isAuthorized('gmail')).toBe(false);
  });
});

describe('completeLogin', () => {
  // The state is the CSRF guard: a callback we did not start must never mint a token.
  it('refuses a state it did not issue', async () => {
    const { store } = fakeStore();
    await expect(new ConnectorAuthService(store, 4780).completeLogin('forged', 'code'))
      .rejects.toThrow(/no longer valid/);
  });
});

describe('beginLogin', () => {
  it('refuses a stdio connector, which takes credentials in env instead', async () => {
    const { store } = fakeStore();
    const stdio = httpConnector({ config: { transport: 'stdio', command: 'x', args: [], env: {} } });
    await expect(new ConnectorAuthService(store, 4780).beginLogin(stdio))
      .rejects.toThrow(/http and sse/);
  });
});

describe('forgetClient', () => {
  it('drops the registered client without touching the tokens', async () => {
    const { store, map } = fakeStore({
      'antbot:oauth-client:gmail': '{"clientId":"cid"}',
      'antbot:oauth:gmail': '{"accessToken":"at"}',
    });
    await new ConnectorAuthService(store, 4780).forgetClient('gmail');
    expect(map.has('antbot:oauth-client:gmail')).toBe(false);
    expect(map.has('antbot:oauth:gmail')).toBe(true);
  });
});
