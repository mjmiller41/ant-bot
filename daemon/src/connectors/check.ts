// One honest verdict on a connector, replacing `test` and the guesswork around it.
//
// `tools/list` is the wrong question: servers answer it to anyone and refuse the first real
// call, which is how a connector looked healthy while giving a bot nothing. The auth verdict here
// comes from a deliberately failing `tools/call` — what `discoverAuth` already does — and the
// tool list is attached only once the server has been reached. Pure decision at the top, thin
// I/O below, so every verdict is testable without a network.
import type { Connector, ConnectorCheck } from '@antbot/contract';
import { builtinAlternativeFor } from './builtin/catalog.js';
import { discoverAuth, OAuthError, type DiscoveryResult } from './oauth.js';
import { probeConnector, type ProbeResult } from '../bots/mcpProbe.js';
import type { MountedConnector } from '../agent/runtime.js';

export interface CheckSignals {
  /** The probe result, when the server was reachable enough to run it. */
  probe: ProbeResult | null;
  /** What a real call provoked: nothing, or an auth challenge (with discovery), or a hard failure. */
  challenge: 'none' | 'auth' | 'unreachable';
  discovery?: DiscoveryResult | null;
  /** For built-ins: whether the daemon holds a sign-in already. */
  builtinSignedIn?: boolean;
  /** Scopes the connector asks for that the stored sign-in does not carry. */
  builtinMissingScopes?: string[];
  builtinProvider?: { name: string; dynamicRegistration: boolean };
  /** Missing `{{secret:…}}` references, if any. */
  missingSecrets: string[];
}

/** Pure: signals in, verdict out. */
export function decideCheck(signals: CheckSignals): ConnectorCheck {
  if (signals.builtinProvider) {
    // Signed in, but with a token minted before the connector asked for these. It will keep
    // failing on whatever needs them, while every other signal says healthy.
    if (signals.builtinSignedIn && signals.builtinMissingScopes?.length) {
      return {
        status: 'needs-sign-in',
        selfRegistration: signals.builtinProvider.dynamicRegistration,
        provider: signals.builtinProvider.name,
        tools: signals.probe?.tools ?? [],
        detail: `signed in, but without ${signals.builtinMissingScopes.length} newer permission(s) — sign in again to grant them`,
      };
    }
    return signals.builtinSignedIn
      ? { status: 'ready', tools: signals.probe?.tools ?? [], provider: signals.builtinProvider.name }
      : {
          status: 'needs-sign-in',
          selfRegistration: signals.builtinProvider.dynamicRegistration,
          provider: signals.builtinProvider.name,
          tools: signals.probe?.tools ?? [],
        };
  }
  if (signals.missingSecrets.length) {
    return { status: 'needs-credential', tools: [], detail: `missing secret(s): ${signals.missingSecrets.join(', ')}` };
  }
  if (signals.challenge === 'auth') {
    const as = signals.discovery?.authServer;
    const host = as ? new URL(as.authorizationEndpoint).host : undefined;
    // Google's own MCP endpoint admits only clients Google allowlisted: the sign-in succeeds and
    // every call is then refused with "The caller does not have permission". Saying so here is
    // the difference between a dead end and the one command that works.
    const alternative = host ? builtinAlternativeFor(host) : undefined;
    return {
      status: 'needs-sign-in',
      selfRegistration: Boolean(as?.registrationEndpoint),
      provider: host,
      tools: signals.probe?.tools ?? [],
      ...(alternative
        ? {
            alternative,
            detail: `${host} does not accept third-party MCP clients here, so a sign-in would not help. Use the built-in instead: antbot mcp add ${alternative}`,
          }
        : {}),
    };
  }
  if (signals.challenge === 'unreachable' || (signals.probe && !signals.probe.ok)) {
    return { status: 'unreachable', tools: [], detail: signals.probe?.error };
  }
  return { status: 'ready', tools: signals.probe?.tools ?? [] };
}

/**
 * Gather the signals for a custom connector. `mounted` is the already-substituted config (so a
 * static header credential is exercised), which the caller builds — this module never touches the
 * keychain.
 */
export async function gatherCustomSignals(
  connector: Connector,
  mounted: MountedConnector | null,
  missingSecrets: string[],
): Promise<CheckSignals> {
  if (missingSecrets.length || !mounted) return { probe: null, challenge: 'none', missingSecrets };
  const probe = await probeConnector(mounted as unknown as Record<string, unknown>, { timeoutMs: 8000 });
  if (mounted.type === 'stdio') return { probe, challenge: probe.ok ? 'none' : 'unreachable', missingSecrets };
  if (!probe.ok) return { probe, challenge: 'unreachable', missingSecrets };
  // Reachable. Now the question that matters: does it accept us? A real call, with whatever
  // headers the config carries, either passes or provokes the 401 discovery starts from.
  try {
    const discovery = await discoverAuth(mounted.url, mounted.headers);
    return { probe, challenge: 'auth', discovery, missingSecrets };
  } catch (err) {
    // discoverAuth throws when the server did NOT challenge (no 401 to follow) — that is success —
    // or when it challenged but named no authorization server, which is still "needs sign-in".
    const msg = (err as Error).message;
    if (err instanceof OAuthError && /did not advertise an authorization server/.test(msg)) {
      return { probe, challenge: 'auth', discovery: null, missingSecrets };
    }
    return { probe, challenge: 'none', missingSecrets };
  }
}
