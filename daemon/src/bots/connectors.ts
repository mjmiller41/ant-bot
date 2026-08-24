// Turning stored connector rows into MCP server configs the Agent SDK can mount.
//
// Two things make this worth a module of its own. First, it is the only place a secret *value*
// ever enters a config object — everywhere else in the system a connector carries a reference
// (`{{secret:NAME}}`) and nothing more. Second, deciding what to mount is a decision, not an
// action: which connectors are usable, which are missing credentials, and what the human should
// be told. Keeping that pure means every branch is testable without a keychain or a subprocess.
import type { Connector, ConnectorConfig } from '@antbot/contract';
import type { MountedConnector } from '../agent/runtime.js';

/**
 * A reference to a stored secret, embeddable inside a value: `Bearer {{secret:GH_TOKEN}}`.
 *
 * A template rather than a structured field because real credentials are usually part of a
 * larger string — an `Authorization` header is a scheme plus a token — and an object form
 * ({secret: 'NAME'}) cannot express that without inventing a concatenation syntax anyway.
 */
export const SECRET_REF_RE = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g;

/** Every secret name referenced anywhere in a config, deduplicated, in first-seen order. */
export function extractSecretRefs(config: ConnectorConfig): string[] {
  const values = config.transport === 'stdio' ? Object.values(config.env) : Object.values(config.headers);
  const names: string[] = [];
  for (const v of values) {
    for (const m of v.matchAll(SECRET_REF_RE)) {
      const name = m[1]!;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** References with nothing behind them. Drives the warning badge in the UI and the CLI listing. */
export function computeMissingSecrets(connector: Connector, available: ReadonlySet<string>): string[] {
  return extractSecretRefs(connector.config).filter((n) => !available.has(n));
}

export interface MountPlan {
  mount: Connector[];
  skipped: { connector: Connector; missing: string[] }[];
}

/**
 * Decide which of a bot's connectors can actually be mounted this turn.
 *
 * A connector whose credential is missing is skipped, not fatal. Mounting it anyway would hand
 * the model a server that fails on first use with an opaque protocol error; failing the whole
 * turn would let one broken connector block work that has nothing to do with it. Skipping is the
 * only option that leaves the rest of the turn intact — and the human already had a warning on
 * the connectors screen before it came to this.
 */
export function planConnectorMount(assigned: Connector[], available: ReadonlySet<string>): MountPlan {
  const plan: MountPlan = { mount: [], skipped: [] };
  for (const connector of assigned) {
    const missing = computeMissingSecrets(connector, available);
    if (missing.length) plan.skipped.push({ connector, missing });
    else plan.mount.push(connector);
  }
  return plan;
}

/** Thrown when a name that was present at planning time yields nothing at resolve time. */
export class MissingSecretError extends Error {
  constructor(
    public connectorName: string,
    public secretName: string,
  ) {
    super(`Connector "${connectorName}" references secret "${secretName}", which could not be read.`);
    this.name = 'MissingSecretError';
  }
}

function substitute(value: string, connectorName: string, secrets: ReadonlyMap<string, string | null>): string {
  return value.replace(SECRET_REF_RE, (_full, name: string) => {
    const resolved = secrets.get(name);
    // Between planning and here the backend can still come up empty — a keychain that locked, a
    // secret deleted mid-turn. Throwing skips this one connector in the caller rather than
    // silently mounting it with the literal "{{secret:NAME}}" as its credential.
    if (resolved == null) throw new MissingSecretError(connectorName, name);
    return resolved;
  });
}

const substituteAll = (
  record: Record<string, string>,
  connectorName: string,
  secrets: ReadonlyMap<string, string | null>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, substitute(v, connectorName, secrets)]));

/**
 * The SDK config for one connector, with secret references replaced by their values.
 *
 * The returned object is the only representation that holds real credentials. It goes straight
 * into the turn's `mcpServers` map and is never persisted, logged, or returned by a route.
 * Runtime-neutral: this is ant-bot's own shape, and the agent runtime's adapter translates it.
 */
export function buildMcpServerConfig(
  connector: Connector,
  secrets: ReadonlyMap<string, string | null>,
): MountedConnector {
  const c = connector.config;
  if (c.transport === 'stdio') {
    return {
      type: 'stdio',
      command: c.command,
      args: c.args,
      env: substituteAll(c.env, connector.name, secrets),
    };
  }
  return {
    type: c.transport,
    url: c.url,
    headers: substituteAll(c.headers, connector.name, secrets),
    ...(c.tools ? { tools: c.tools } : {}),
  };
}
