// The connector sign-in flow: discovery, an authorize URL for the human, the callback, and the
// token refresh that keeps a signed-in connector working afterwards.
//
// Tokens live in the same keychain as every other secret and never touch the database or any
// route response — the same rule the `{{secret:NAME}}` references follow. What is stored is one
// JSON blob per connector, because a refresh needs the client id, the token endpoint and the
// resource alongside the tokens themselves.
import crypto from 'node:crypto';
import type { Connector } from '@antbot/contract';
import { logger } from '../util/log.js';
import {
  discoverAuth, registerClient, exchangeCode, refreshTokens, createPkce, buildAuthorizeUrl,
  needsRefresh, OAuthError, type StoredTokens, type DiscoveryResult,
} from './oauth.js';

const log = logger('connector-auth');

/** Keychain key for one connector's tokens. Namespaced so it cannot collide with a user secret. */
export const tokenSecretName = (connectorName: string): string => `antbot:oauth:${connectorName}`;

/**
 * Keychain key for a connector's OAuth client credentials.
 *
 * Kept separate from the tokens because it outlives them: a client id and secret are registered
 * once with the provider, while tokens come and go. Storing them means a second `login` — after
 * an expiry, a revocation, or a failed first attempt — does not ask for them again.
 */
export const clientSecretName = (connectorName: string): string => `antbot:oauth-client:${connectorName}`;

interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
}

/** Where the authorization server sends the human back. Must be registered with the provider. */
export const redirectUri = (port: number): string => `http://127.0.0.1:${port}/api/connectors/oauth/callback`;

interface PendingLogin {
  connectorId: string;
  connectorName: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource?: string;
  redirectUri: string;
  startedAt: number;
}

/** Minimal secrets surface, so this module is testable without a keychain. */
export interface TokenStore {
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
  resolve(names: string[]): Promise<Map<string, string | null>>;
  list(): string[];
}

/** A sign-in that has been started and is waiting for the human to come back. */
const LOGIN_TTL_MS = 10 * 60 * 1000;

export class ConnectorAuthService {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly secrets: TokenStore,
    /** Read lazily: the listening port is settled after this service is built. */
    private readonly portOf: () => number,
  ) {}
  private get port(): number {
    return this.portOf();
  }

  /** Has this connector been signed in? Names only — never reads a value to answer. */
  isAuthorized(connectorName: string): boolean {
    return this.secrets.list().includes(tokenSecretName(connectorName));
  }

  private async read(connectorName: string): Promise<StoredTokens | null> {
    const key = tokenSecretName(connectorName);
    const found = (await this.secrets.resolve([key])).get(key);
    if (!found) return null;
    try {
      return JSON.parse(found) as StoredTokens;
    } catch {
      // A corrupt blob is the same as not signed in; the human can sign in again.
      log.warn(`stored tokens for "${connectorName}" are unreadable`);
      return null;
    }
  }

  private async write(connectorName: string, tokens: StoredTokens): Promise<void> {
    await this.secrets.set(tokenSecretName(connectorName), JSON.stringify(tokens));
  }

  async signOut(connectorName: string): Promise<void> {
    await this.secrets.remove(tokenSecretName(connectorName));
  }

  /** Forget the tokens *and* the registered client. Used when the credentials themselves are wrong. */
  async forgetClient(connectorName: string): Promise<void> {
    await this.secrets.remove(clientSecretName(connectorName));
  }

  private async readClient(clientKey: string): Promise<ClientCredentials | null> {
    const key = clientSecretName(clientKey);
    const found = (await this.secrets.resolve([key])).get(key);
    if (!found) return null;
    try {
      return JSON.parse(found) as ClientCredentials;
    } catch {
      return null;
    }
  }

  /**
   * Begin a sign-in. Returns the URL the human must open.
   *
   * `clientId` is required only when the authorization server does not support dynamic client
   * registration — Google being the notable case, where the human supplies one from their own
   * cloud console. Everything else registers ant-bot automatically.
   */
  async beginLogin(
    connector: Connector,
    opts: { clientId?: string; clientSecret?: string; scopes?: string[] } = {},
  ): Promise<{ authorizeUrl: string; discovery: DiscoveryResult }> {
    if (connector.config.transport === 'stdio') {
      throw new OAuthError('Sign-in applies to http and sse connectors; a stdio server takes its credentials in env.');
    }
    const discovery = await discoverAuth(connector.config.url);
    const authorizeUrl = await this.beginLoginWith(
      {
        connectorId: connector.id,
        connectorName: connector.name,
        clientKey: connector.name,
        authorizationEndpoint: discovery.authServer.authorizationEndpoint,
        tokenEndpoint: discovery.authServer.tokenEndpoint,
        registrationEndpoint: discovery.authServer.registrationEndpoint,
        resource: discovery.resource.resource,
        scopes: opts.scopes?.length ? opts.scopes : discovery.resource.scopesSupported,
        // Without these Google issues no refresh token, and the connector dies in an hour. Harmless
        // for providers that ignore them.
        extras: { access_type: 'offline', prompt: 'consent' },
      },
      opts,
    );
    return { authorizeUrl, discovery };
  }

  /**
   * Begin a sign-in against a known authorization server. Used directly by built-in connectors,
   * whose provider endpoints are fixed and whose client credentials are shared under one
   * `clientKey` — one Google client serves Gmail, Calendar and Drive.
   */
  async beginLoginWith(
    target: {
      connectorId: string;
      connectorName: string;
      clientKey: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      registrationEndpoint?: string;
      resource?: string;
      scopes: string[];
      extras?: Record<string, string>;
      /** Shown when a client ID is needed and none is known. */
      providerName?: string;
    },
    opts: { clientId?: string; clientSecret?: string } = {},
  ): Promise<string> {
    const redirect = redirectUri(this.port);

    // Given now, else remembered from last time, else registered automatically. The remembered
    // path is what makes a retry after a failed exchange painless.
    const remembered = await this.readClient(target.clientKey);
    let clientId = opts.clientId ?? remembered?.clientId;
    let clientSecret = opts.clientSecret ?? (opts.clientId ? undefined : remembered?.clientSecret);
    if (!clientId && target.registrationEndpoint) {
      const registered = await registerClient(target.registrationEndpoint, redirect);
      clientId = registered?.clientId;
      clientSecret = registered?.clientSecret;
    }
    if (!clientId) {
      const who = target.providerName ?? new URL(target.authorizationEndpoint).host;
      throw new OAuthError(
        `${who} does not support automatic app registration, so it needs a client ID you create yourself. ` +
          `Register one with that provider, add "${redirect}" as an authorised redirect URI, and pass the client ID with --client-id.`,
      );
    }

    // Remember before sending the human to the provider, so a failed exchange does not lose them.
    if (opts.clientId || opts.clientSecret || !remembered) {
      await this.secrets.set(clientSecretName(target.clientKey), JSON.stringify({ clientId, clientSecret }));
    }

    const pkce = createPkce();
    const state = crypto.randomBytes(16).toString('base64url');
    this.pending.set(state, {
      connectorId: target.connectorId,
      connectorName: target.connectorName,
      verifier: pkce.verifier,
      clientId,
      clientSecret,
      tokenEndpoint: target.tokenEndpoint,
      resource: target.resource,
      redirectUri: redirect,
      startedAt: Date.now(),
    });
    this.sweep();

    return buildAuthorizeUrl({
      authorizationEndpoint: target.authorizationEndpoint,
      clientId,
      redirectUri: redirect,
      scopes: target.scopes,
      state,
      challenge: pkce.challenge,
      resource: target.resource,
      extra: target.extras,
    });
  }

  /** Whether client credentials are on file for a key (a connector name or a provider key). */
  hasClient(clientKey: string): boolean {
    return this.secrets.list().includes(clientSecretName(clientKey));
  }

  /** Finish a sign-in from the redirect. Returns the connector that was authorised. */
  async completeLogin(state: string, code: string): Promise<{ connectorId: string; connectorName: string }> {
    const p = this.pending.get(state);
    // Unknown state is the CSRF guard: a callback we did not start is not ours to act on.
    if (!p) throw new OAuthError('This sign-in link is no longer valid. Start the sign-in again.');
    this.pending.delete(state);

    let tokens;
    try {
      tokens = await exchangeCode({
        tokenEndpoint: p.tokenEndpoint,
        code,
        verifier: p.verifier,
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        redirectUri: p.redirectUri,
        resource: p.resource,
      });
    } catch (err) {
      const message = (err as Error).message;
      // Google's "Web application" client type authenticates at the token endpoint, so the id
      // alone is not enough. Its own wording does not say what to do about it.
      if (/client_secret/i.test(message)) {
        throw new OAuthError(
          'This provider requires a client secret as well as a client ID. Add the secret from the ' +
            "same OAuth client (in Google's console: the client's \"Client secret\") and sign in again.",
        );
      }
      throw err;
    }
    await this.write(p.connectorName, tokens);
    log.info(`connector "${p.connectorName}" signed in`);
    return { connectorId: p.connectorId, connectorName: p.connectorName };
  }

  /**
   * The Authorization header for a mounted connector, refreshing first if the token is close to
   * expiry. Returns null when the connector was never signed in, which is not an error — most
   * connectors use a static credential or none.
   */
  async authHeader(connectorName: string): Promise<Record<string, string> | null> {
    let tokens = await this.read(connectorName);
    if (!tokens) return null;
    if (needsRefresh(tokens, Date.now())) {
      try {
        tokens = await refreshTokens(tokens);
        await this.write(connectorName, tokens);
      } catch (err) {
        // Refusing to mount beats mounting with a token known to be expired: the failure is
        // reported once, here, instead of as an opaque 401 in the middle of a bot's work.
        log.warn(`could not refresh tokens for "${connectorName}": ${(err as Error).message}`);
        return null;
      }
    }
    return { Authorization: `Bearer ${tokens.accessToken}` };
  }

  private sweep(): void {
    const cutoff = Date.now() - LOGIN_TTL_MS;
    for (const [state, p] of this.pending) if (p.startedAt < cutoff) this.pending.delete(state);
  }
}
