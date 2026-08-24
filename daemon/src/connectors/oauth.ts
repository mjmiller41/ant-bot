// OAuth for MCP servers, owned by ant-bot rather than borrowed from the `claude` CLI.
//
// Many useful MCP servers will not take a static token in a header — they want an interactive
// sign-in. Without this, those servers can be registered, assigned, and still hand a bot nothing.
//
// The flow is the one the MCP spec adopts: RFC 9728 discovery from the server's own 401, then
// OAuth 2.1 authorization-code with PKCE against whatever authorization server it names.
//
// Two paths, because the field is split:
//   - the server's authorization server supports RFC 7591 dynamic client registration, and
//     ant-bot registers itself; or
//   - it does not (Google, notably), and the human supplies a client id from their own console.
//
// Pure parsing and URL building live at the top and are tested without a network; the I/O below
// is a thin shell over them.
import crypto from 'node:crypto';

/** What a server's 401 points at, per RFC 9728. */
export function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate);
  return m ? m[1]! : null;
}

export interface ProtectedResourceMetadata {
  authorizationServers: string[];
  scopesSupported: string[];
  resource?: string;
}

export function parseProtectedResourceMetadata(body: unknown): ProtectedResourceMetadata | null {
  const b = body as Record<string, unknown> | null;
  const servers = b?.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0) return null;
  return {
    authorizationServers: servers.map(String),
    scopesSupported: Array.isArray(b?.scopes_supported) ? (b!.scopes_supported as unknown[]).map(String) : [],
    resource: typeof b?.resource === 'string' ? b.resource : undefined,
  };
}

export interface AuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
}

export function parseAuthServerMetadata(body: unknown): AuthServerMetadata | null {
  const b = body as Record<string, unknown> | null;
  const auth = b?.authorization_endpoint;
  const token = b?.token_endpoint;
  if (typeof auth !== 'string' || typeof token !== 'string') return null;
  return {
    authorizationEndpoint: auth,
    tokenEndpoint: token,
    registrationEndpoint: typeof b?.registration_endpoint === 'string' ? b.registration_endpoint : undefined,
    scopesSupported: Array.isArray(b?.scopes_supported) ? (b!.scopes_supported as unknown[]).map(String) : [],
  };
}

/** The well-known locations an authorization server's metadata may live at, most specific first. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  const base = `${u.protocol}//${u.host}`;
  return [
    `${base}/.well-known/oauth-authorization-server${path}`,
    `${base}/.well-known/openid-configuration${path}`,
    `${base}${path}/.well-known/oauth-authorization-server`,
    `${base}${path}/.well-known/openid-configuration`,
  ];
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256. The verifier never leaves the daemon; only its hash goes in the URL. */
export function createPkce(): Pkce {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
  /** RFC 8707 — binds the token to this MCP server so it cannot be replayed elsewhere. */
  resource?: string;
  /** Google needs these to return a refresh token at all. */
  extra?: Record<string, string>;
}

export function buildAuthorizeUrl(i: AuthorizeUrlInput): string {
  const u = new URL(i.authorizationEndpoint);
  const p = u.searchParams;
  p.set('response_type', 'code');
  p.set('client_id', i.clientId);
  p.set('redirect_uri', i.redirectUri);
  p.set('state', i.state);
  p.set('code_challenge', i.challenge);
  p.set('code_challenge_method', 'S256');
  if (i.scopes.length) p.set('scope', i.scopes.join(' '));
  if (i.resource) p.set('resource', i.resource);
  for (const [k, v] of Object.entries(i.extra ?? {})) p.set(k, v);
  return u.toString();
}

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Absent when the server did not say, in which case we do not pre-emptively refresh. */
  expiresAt?: number;
  scope?: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
}

/** Parse a token endpoint response into what we store. `now` is injected so expiry is testable. */
export function parseTokenResponse(
  body: unknown,
  ctx: { tokenEndpoint: string; clientId: string; clientSecret?: string; resource?: string; previousRefresh?: string },
  now: number,
): StoredTokens | null {
  const b = body as Record<string, unknown> | null;
  if (typeof b?.access_token !== 'string') return null;
  const expiresIn = typeof b.expires_in === 'number' ? b.expires_in : undefined;
  return {
    accessToken: b.access_token,
    // A refresh response often omits refresh_token, meaning "keep using the one you have".
    refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : ctx.previousRefresh,
    expiresAt: expiresIn ? now + expiresIn * 1000 : undefined,
    scope: typeof b.scope === 'string' ? b.scope : undefined,
    tokenEndpoint: ctx.tokenEndpoint,
    clientId: ctx.clientId,
    clientSecret: ctx.clientSecret,
    resource: ctx.resource,
  };
}

/**
 * Whether a token should be refreshed before use.
 *
 * The skew matters: a token that expires during the turn it was checked for is worse than one
 * refreshed a minute early, because the failure surfaces as an opaque 401 mid-task.
 */
export function needsRefresh(tokens: StoredTokens, now: number, skewMs = 60_000): boolean {
  if (!tokens.expiresAt) return false;
  return now + skewMs >= tokens.expiresAt;
}

/* --------------------------------- I/O shell --------------------------------- */

const JSON_HEADERS = { accept: 'application/json' };
const FETCH_TIMEOUT_MS = 15_000;

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: JSON_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface DiscoveryResult {
  resource: ProtectedResourceMetadata;
  authServer: AuthServerMetadata;
}

/**
 * Where a server's protected-resource metadata might be, most authoritative first.
 *
 * RFC 9728 forms the URL by inserting the well-known segment *before the resource path*, which
 * is what makes candidate 2 the standard one. The hint from `WWW-Authenticate` is tried first
 * because a server is allowed to put it anywhere — but it is not always usable: Google answers a
 * `tools/call` challenge with a metadata URL scoped to the tool that was called, so probing with
 * a name that does not exist yields a hint that 404s. Falling through to the standard location
 * covers that without ever invoking one of the server's real tools.
 */
export function resourceMetadataCandidates(mcpUrl: string, wwwAuthenticate: string | null): string[] {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/$/, '');
  const out: string[] = [];
  const hint = parseResourceMetadataUrl(wwwAuthenticate);
  if (hint) out.push(hint);
  out.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(out)];
}

async function firstResourceMetadata(
  mcpUrl: string,
  wwwAuthenticate: string | null,
): Promise<ProtectedResourceMetadata | null> {
  for (const url of resourceMetadataCandidates(mcpUrl, wwwAuthenticate)) {
    const meta = parseProtectedResourceMetadata(await getJson(url));
    if (meta) return meta;
  }
  return null;
}

/**
 * Ask the server itself what it wants, starting from its 401.
 *
 * A `tools/call` rather than `initialize`, because servers commonly answer the handshake to
 * anyone and only challenge on real work — which is exactly the case that made a connector look
 * healthy while giving a bot nothing.
 */
export async function discoverAuth(mcpUrl: string, headers: Record<string, string> = {}): Promise<DiscoveryResult> {
  let challenge: string | null;
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: '__antbot_auth_probe__', arguments: {} } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    challenge = res.headers.get('www-authenticate');
  } catch (err) {
    throw new OAuthError(`Could not reach ${mcpUrl}: ${(err as Error).message}`);
  }

  const found = await firstResourceMetadata(mcpUrl, challenge);
  if (!found) {
    throw new OAuthError(
      'This server did not advertise an authorization server, so ant-bot cannot sign in to it. ' +
        'If it takes a static token, add one as an Authorization header instead.',
    );
  }

  const resourceMeta = found;
  for (const issuer of resourceMeta.authorizationServers) {
    for (const url of authServerMetadataUrls(issuer)) {
      const meta = parseAuthServerMetadata(await getJson(url));
      if (meta) return { resource: resourceMeta, authServer: meta };
    }
  }
  throw new OAuthError(`Could not read authorization server metadata for ${resourceMeta.authorizationServers.join(', ')}`);
}

/** RFC 7591. Returns null when the authorization server does not offer registration. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string } | null> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...JSON_HEADERS },
      body: JSON.stringify({
        client_name: 'ant-bot',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as Record<string, unknown>;
    return typeof b.client_id === 'string'
      ? { clientId: b.client_id, clientSecret: typeof b.client_secret === 'string' ? b.client_secret : undefined }
      : null;
  } catch {
    return null;
  }
}

async function postForm(endpoint: string, form: Record<string, string>): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...JSON_HEADERS },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body as Record<string, unknown> | null;
    throw new OAuthError(String(e?.error_description ?? e?.error ?? `token endpoint returned HTTP ${res.status}`));
  }
  return body;
}

export async function exchangeCode(input: {
  tokenEndpoint: string;
  code: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  resource?: string;
  now?: number;
}): Promise<StoredTokens> {
  const body = await postForm(input.tokenEndpoint, {
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
  });
  const tokens = parseTokenResponse(body, input, input.now ?? Date.now());
  if (!tokens) throw new OAuthError('The authorization server did not return an access token.');
  return tokens;
}

export async function refreshTokens(tokens: StoredTokens, now = Date.now()): Promise<StoredTokens> {
  if (!tokens.refreshToken) throw new OAuthError('No refresh token — sign in again.');
  const body = await postForm(tokens.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
    ...(tokens.clientSecret ? { client_secret: tokens.clientSecret } : {}),
    ...(tokens.resource ? { resource: tokens.resource } : {}),
  });
  const next = parseTokenResponse(body, { ...tokens, previousRefresh: tokens.refreshToken }, now);
  if (!next) throw new OAuthError('The authorization server did not return a refreshed access token.');
  return next;
}
