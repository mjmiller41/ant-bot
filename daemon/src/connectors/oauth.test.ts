import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  parseResourceMetadataUrl, parseProtectedResourceMetadata, parseAuthServerMetadata,
  authServerMetadataUrls, resourceMetadataCandidates, createPkce, buildAuthorizeUrl,
  parseTokenResponse, needsRefresh,
} from './oauth.js';

describe('parseResourceMetadataUrl', () => {
  it('reads the hint out of a WWW-Authenticate challenge', () => {
    expect(parseResourceMetadataUrl('Bearer resource_metadata="https://x.dev/.well-known/oauth-protected-resource"'))
      .toBe('https://x.dev/.well-known/oauth-protected-resource');
  });

  it('returns null for a challenge without one, or no challenge at all', () => {
    expect(parseResourceMetadataUrl('Bearer realm="x"')).toBeNull();
    expect(parseResourceMetadataUrl(null)).toBeNull();
  });
});

describe('resourceMetadataCandidates', () => {
  // RFC 9728 inserts the well-known segment *before* the resource path. Google's challenge points
  // at a per-tool path instead, which 404s when the probe used a tool name that does not exist —
  // so the standard location has to be tried too.
  it('tries the challenge hint first, then the standard location', () => {
    const c = resourceMetadataCandidates(
      'https://gmailmcp.googleapis.com/mcp/v1',
      'Bearer resource_metadata="https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/list_drafts"',
    );
    expect(c[0]).toContain('/list_drafts');
    expect(c[1]).toBe('https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1');
    expect(c[2]).toBe('https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource');
  });

  it('still produces candidates with no challenge', () => {
    expect(resourceMetadataCandidates('https://x.dev/mcp', null)).toEqual([
      'https://x.dev/.well-known/oauth-protected-resource/mcp',
      'https://x.dev/.well-known/oauth-protected-resource',
    ]);
  });

  it('does not repeat a candidate', () => {
    const c = resourceMetadataCandidates('https://x.dev/', 'Bearer resource_metadata="https://x.dev/.well-known/oauth-protected-resource"');
    expect(new Set(c).size).toBe(c.length);
  });
});

describe('metadata parsing', () => {
  it('reads a protected-resource document', () => {
    const m = parseProtectedResourceMetadata({
      authorization_servers: ['https://accounts.google.com/'],
      scopes_supported: ['a', 'b'],
      resource: 'https://x.dev/mcp',
    });
    expect(m).toEqual({ authorizationServers: ['https://accounts.google.com/'], scopesSupported: ['a', 'b'], resource: 'https://x.dev/mcp' });
  });

  it('rejects a document naming no authorization server', () => {
    expect(parseProtectedResourceMetadata({ scopes_supported: ['a'] })).toBeNull();
    expect(parseProtectedResourceMetadata({ authorization_servers: [] })).toBeNull();
    expect(parseProtectedResourceMetadata(null)).toBeNull();
  });

  it('reads an authorization-server document and notices missing registration', () => {
    const m = parseAuthServerMetadata({
      authorization_endpoint: 'https://a.dev/auth', token_endpoint: 'https://a.dev/token',
    });
    expect(m).toMatchObject({ authorizationEndpoint: 'https://a.dev/auth', tokenEndpoint: 'https://a.dev/token' });
    expect(m!.registrationEndpoint).toBeUndefined();
  });

  it('rejects a document missing either endpoint', () => {
    expect(parseAuthServerMetadata({ authorization_endpoint: 'https://a.dev/auth' })).toBeNull();
    expect(parseAuthServerMetadata({ token_endpoint: 'https://a.dev/token' })).toBeNull();
  });
});

describe('authServerMetadataUrls', () => {
  it('covers both well-known forms, path-aware', () => {
    expect(authServerMetadataUrls('https://accounts.google.com/')).toContain(
      'https://accounts.google.com/.well-known/openid-configuration',
    );
    const withPath = authServerMetadataUrls('https://id.dev/tenant1');
    expect(withPath).toContain('https://id.dev/.well-known/oauth-authorization-server/tenant1');
    expect(withPath).toContain('https://id.dev/tenant1/.well-known/openid-configuration');
  });
});

describe('createPkce', () => {
  // The verifier is the secret half and must never be derivable from what goes in the URL.
  it('produces an S256 challenge of its verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });

  it('is different every time', () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });

  it('is url-safe', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('buildAuthorizeUrl', () => {
  const base = {
    authorizationEndpoint: 'https://a.dev/auth',
    clientId: 'cid', redirectUri: 'http://127.0.0.1:4780/api/connectors/oauth/callback',
    scopes: ['s1', 's2'], state: 'st', challenge: 'ch',
  };

  it('sets the authorization-code + PKCE parameters', () => {
    const u = new URL(buildAuthorizeUrl(base));
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge')).toBe('ch');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toBe('s1 s2');
    expect(u.searchParams.get('state')).toBe('st');
  });

  // The verifier is the half that proves we started the flow; putting it in the URL would defeat
  // the point of PKCE entirely.
  it('never puts the verifier in the URL', () => {
    const { verifier, challenge } = createPkce();
    expect(buildAuthorizeUrl({ ...base, challenge })).not.toContain(verifier);
  });

  // RFC 8707: binds the token to this MCP server so it cannot be replayed against another.
  it('passes the resource through when known', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, resource: 'https://x.dev/mcp' }));
    expect(u.searchParams.get('resource')).toBe('https://x.dev/mcp');
  });

  it('carries provider-specific extras', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, extra: { access_type: 'offline', prompt: 'consent' } }));
    expect(u.searchParams.get('access_type')).toBe('offline');
  });

  it('omits scope entirely when none are known', () => {
    expect(new URL(buildAuthorizeUrl({ ...base, scopes: [] })).searchParams.has('scope')).toBe(false);
  });
});

describe('parseTokenResponse', () => {
  const ctx = { tokenEndpoint: 'https://a.dev/token', clientId: 'cid' };

  it('reads tokens and computes an absolute expiry', () => {
    const t = parseTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }, ctx, 1_000_000);
    expect(t).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000_000 + 3_600_000 });
  });

  // A refresh response usually omits refresh_token, meaning "keep the one you have". Dropping it
  // would silently turn a renewable connector into one that dies at the next expiry.
  it('keeps the previous refresh token when the response omits one', () => {
    const t = parseTokenResponse({ access_token: 'new' }, { ...ctx, previousRefresh: 'old-rt' }, 0);
    expect(t!.refreshToken).toBe('old-rt');
  });

  it('leaves expiry unset when the server does not say', () => {
    expect(parseTokenResponse({ access_token: 'at' }, ctx, 0)!.expiresAt).toBeUndefined();
  });

  it('rejects a response with no access token', () => {
    expect(parseTokenResponse({ error: 'invalid_grant' }, ctx, 0)).toBeNull();
    expect(parseTokenResponse(null, ctx, 0)).toBeNull();
  });
});

describe('needsRefresh', () => {
  const t = { accessToken: 'a', tokenEndpoint: 'e', clientId: 'c' };

  it('refreshes shortly before expiry rather than after', () => {
    expect(needsRefresh({ ...t, expiresAt: 100_000 }, 100_000 - 30_000)).toBe(true);
    expect(needsRefresh({ ...t, expiresAt: 100_000 }, 100_000 - 120_000)).toBe(false);
  });

  it('treats an already-expired token as needing refresh', () => {
    expect(needsRefresh({ ...t, expiresAt: 1 }, 2)).toBe(true);
  });

  // No expiry means the server never said; guessing would refresh a perfectly good token forever.
  it('does not refresh a token with no stated expiry', () => {
    expect(needsRefresh(t, Date.now())).toBe(false);
  });
});
