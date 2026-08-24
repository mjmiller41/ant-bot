// The connectors ant-bot ships. `antbot mcp add gmail` with no command or URL resolves here.
//
// Each entry carries everything the guided setup needs to say, so the instructions live next to
// the code that depends on them rather than in prose that drifts. Google's endpoints are fixed
// and documented; hard-coding them removes a network round trip from a flow that already has
// enough of them, and means the sign-in works even when discovery would not.
import { gmailTools, type FetchLike } from './gmail.js';
import type { BuiltinTool } from './mcpServer.js';

export interface Provider {
  /** Shared client-credential key: one Google client serves Gmail, Calendar and Drive. */
  key: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Provider-specific authorize params. Google needs these to issue a refresh token at all. */
  authorizeExtras: Record<string, string>;
  /** Whether the provider lets an app register itself. Google does not. */
  dynamicRegistration: boolean;
  /** Numbered steps shown when a client ID is needed. `{redirectUri}` is substituted. */
  setupSteps: string[];
}

export const GOOGLE: Provider = {
  key: 'google',
  displayName: 'Google',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  authorizeExtras: { access_type: 'offline', prompt: 'consent' },
  dynamicRegistration: false,
  setupSteps: [
    'Open console.cloud.google.com → APIs & Services → Credentials → Create credentials → OAuth client ID.',
    'Application type: Web application. Under "Authorised redirect URIs" add exactly: {redirectUri}',
    'Enable the Gmail API for the project (APIs & Services → Library).',
    'Copy the Client ID and Client secret it shows you. One client works for every Google connector.',
  ],
};

export interface BuiltinConnector {
  name: string;
  displayName: string;
  description: string;
  provider: Provider;
  scopes: string[];
  tools: (fetchFn?: FetchLike) => BuiltinTool[];
}

export const BUILTIN_CATALOG: Record<string, BuiltinConnector> = {
  gmail: {
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Read, search and draft email in the signed-in Gmail account.',
    provider: GOOGLE,
    // modify covers read + draft + send; asking for less means a second consent screen later.
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    tools: gmailTools,
  },
};

export const isBuiltinName = (name: string): boolean => name in BUILTIN_CATALOG;

/**
 * The built-in to use instead, when a custom connector signs in at a provider whose own MCP
 * endpoint refuses third-party clients. Matched on the authorization host: a Google sign-in is
 * a Google sign-in whatever URL sits behind it.
 */
export function builtinAlternativeFor(authorizationHost: string): string | undefined {
  for (const [name, def] of Object.entries(BUILTIN_CATALOG)) {
    if (new URL(def.provider.authorizationEndpoint).host === authorizationHost && !def.provider.dynamicRegistration) return name;
  }
  return undefined;
}
