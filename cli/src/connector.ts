// `antbot connector` — manage the MCP servers bots can be given access to.
//
// Talks to the daemon over HTTP like `antbot skill` does, so the daemon stays the single owner
// of the registry and of the keychain. In particular `test` runs inside the daemon: resolving a
// connector's secrets in the CLI would mean a second process holding credentials for no reason.
import { getJson, postJson, patchJson, deleteJson } from './net.js';
import { bold, dim, green, red, yellow } from './color.js';

interface ConnectorRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;
  missingSecrets: string[];
  signedIn: boolean;
}

interface LoginResponse { authorizeUrl: string }

interface ProbeResponse {
  ok: boolean;
  tools: { name: string; description: string }[];
  error?: string;
  authHint?: string;
}

/** Collect a repeatable `--flag K=V` into a record. Later wins, so a typo can be corrected. */
function collectPairs(argv: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const raw = argv[i + 1] ?? '';
    const eq = raw.indexOf('=');
    if (eq > 0) out[raw.slice(0, eq)] = raw.slice(eq + 1);
    i++;
  }
  return out;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Split a shell-ish command string into a command and arguments, honouring quotes so a path
 * with a space survives. Not a shell: no expansion, no operators — the daemon spawns the
 * command directly, and pretending otherwise would be a way to smuggle one in.
 */
export function splitCommand(input: string): { command: string; args: string[] } {
  const parts = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map((p) =>
    (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")) ? p.slice(1, -1) : p,
  );
  return { command: clean[0] ?? '', args: clean.slice(1) };
}

/** Build the config for `connector add` from its flags, or explain what is missing. */
export function buildConfigFromFlags(argv: string[]): { config: Record<string, unknown> } | { error: string } {
  const stdio = flagValue(argv, '--stdio');
  const url = flagValue(argv, '--url');
  if (stdio && url) return { error: 'Use either --stdio or --url, not both.' };

  if (stdio) {
    const { command, args } = splitCommand(stdio);
    if (!command) return { error: '--stdio needs a command, e.g. --stdio "npx -y @scope/server"' };
    return { config: { transport: 'stdio', command, args, env: collectPairs(argv, '--env') } };
  }

  if (url) {
    const transport = flagValue(argv, '--transport') ?? 'http';
    if (transport !== 'http' && transport !== 'sse') return { error: '--transport must be http or sse' };
    const tools = flagValue(argv, '--tools');
    return {
      config: {
        transport,
        url,
        headers: collectPairs(argv, '--header'),
        ...(tools ? { tools: tools.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
      },
    };
  }

  return { error: 'Give either --stdio "<command>" or --url <url>.' };
}

const transportOf = (c: ConnectorRow): string => String(c.config.transport ?? '?');

async function findByName(port: number, name: string): Promise<ConnectorRow | undefined> {
  return (await getJson<ConnectorRow[]>(port, '/api/connectors')).find((c) => c.name === name);
}

export async function runConnectorCommand(argv: string[], port: number): Promise<number> {
  const sub = argv[0];
  const hint = (): void => {
    console.error(dim('Subcommands: list, add, login, logout, enable, disable, remove, test.'));
    console.error(dim('Run `antbot mcp --help` for the full usage.'));
  };
  if (!sub) {
    console.error(red('antbot connector needs a subcommand.'));
    hint();
    return 2;
  }

  let rows: ConnectorRow[];
  const load = async (): Promise<boolean> => {
    try {
      rows = await getJson<ConnectorRow[]>(port, '/api/connectors');
      return true;
    } catch (err) {
      console.error(red(`Could not reach the daemon on port ${port}: ${(err as Error).message}`));
      console.error(dim('Start it with `antbot start`.'));
      return false;
    }
  };

  switch (sub) {
    case 'list': {
      if (!(await load())) return 1;
      if (!rows!.length) {
        console.log(dim('No connectors yet. Add one with `antbot connector add`.'));
        return 0;
      }
      for (const c of rows!) {
        const state = c.enabled ? '' : dim(' (disabled)');
        const signed = c.signedIn ? green(' signed in') : '';
        console.log(`${bold(c.name)}  ${dim(transportOf(c))}${state}${signed}`);
        if (c.description) console.log(`  ${c.description}`);
        if (c.missingSecrets.length) {
          console.log(yellow(`  missing secret(s): ${c.missingSecrets.join(', ')} — this connector will not mount`));
        }
      }
      return 0;
    }

    case 'add': {
      const name = argv[1];
      if (!name || name.startsWith('--')) {
        console.error(red('Usage: antbot connector add <name> (--stdio "<cmd>" | --url <url>)'));
        return 2;
      }
      const built = buildConfigFromFlags(argv);
      if ('error' in built) {
        console.error(red(built.error));
        return 2;
      }
      try {
        const created = await postJson<ConnectorRow>(port, '/api/connectors', {
          name,
          description: flagValue(argv, '--desc') ?? '',
          config: built.config,
        });
        console.log(green(`Added connector "${created.name}".`));
        console.log(dim('Assign it to a bot in Bot settings, then `antbot connector test` to check it.'));
        return 0;
      } catch (err) {
        console.error(red((err as Error).message));
        return 1;
      }
    }

    case 'enable':
    case 'disable': {
      const name = argv[1];
      if (!name) {
        console.error(red(`Usage: antbot connector ${sub} <name>`));
        return 2;
      }
      if (!(await load())) return 1;
      const match = rows!.find((c) => c.name === name);
      if (!match) {
        console.error(red(`No connector named "${name}".`));
        return 1;
      }
      await patchJson(port, `/api/connectors/${match.id}`, { enabled: sub === 'enable' });
      console.log(green(`Connector "${name}" ${sub}d.`));
      return 0;
    }

    case 'remove': {
      const name = argv[1];
      if (!name) {
        console.error(red('Usage: antbot connector remove <name>'));
        return 2;
      }
      if (!(await load())) return 1;
      const match = rows!.find((c) => c.name === name);
      if (!match) {
        console.error(red(`No connector named "${name}".`));
        return 1;
      }
      await deleteJson(port, `/api/connectors/${match.id}`);
      console.log(green(`Removed connector "${name}". Bot assignments for it are gone too.`));
      return 0;
    }

    case 'login': {
      const name = argv[1];
      if (!name) {
        console.error(red('Usage: antbot mcp login <name> [--client-id ID] [--client-secret SECRET]'));
        return 2;
      }
      if (!(await load())) return 1;
      const match = rows!.find((c) => c.name === name);
      if (!match) {
        console.error(red(`No connector named "${name}".`));
        return 1;
      }
      const body: Record<string, unknown> = {};
      const cid = flagValue(argv, '--client-id');
      const csec = flagValue(argv, '--client-secret');
      const scopes = flagValue(argv, '--scopes');
      if (cid) body.clientId = cid;
      if (csec) body.clientSecret = csec;
      if (scopes) body.scopes = scopes.split(',').map((x) => x.trim()).filter(Boolean);
      try {
        const res = await postJson<LoginResponse>(port, `/api/connectors/${match.id}/login`, body);
        console.log(bold('Open this URL to sign in:'));
        console.log(`  ${res.authorizeUrl}`);
        console.log(dim('The browser returns to ant-bot when you are done. Then: antbot mcp test ' + name));
        return 0;
      } catch (err) {
        console.error(red((err as Error).message));
        return 1;
      }
    }

    case 'logout': {
      const name = argv[1];
      if (!name) {
        console.error(red('Usage: antbot mcp logout <name>'));
        return 2;
      }
      if (!(await load())) return 1;
      const match = rows!.find((c) => c.name === name);
      if (!match) {
        console.error(red(`No connector named "${name}".`));
        return 1;
      }
      await deleteJson(port, `/api/connectors/${match.id}/login`);
      console.log(green(`Signed out of "${name}".`));
      return 0;
    }

    case 'test': {
      const name = argv[1];
      if (!name) {
        console.error(red('Usage: antbot connector test <name>'));
        return 2;
      }
      let match: ConnectorRow | undefined;
      try {
        match = await findByName(port, name);
      } catch (err) {
        console.error(red(`Could not reach the daemon on port ${port}: ${(err as Error).message}`));
        return 1;
      }
      if (!match) {
        console.error(red(`No connector named "${name}".`));
        return 1;
      }
      const result = await postJson<ProbeResponse>(port, `/api/connectors/${match.id}/test`, {});
      if (!result.ok) {
        console.error(red(`${name}: ${result.error ?? 'could not connect'}`));
        return 1;
      }
      console.log(green(`${name}: connected, ${result.tools.length} tool(s)`));
      if (result.authHint) console.log(yellow(`  ${result.authHint}`));
      for (const t of result.tools) {
        console.log(`  ${bold(`mcp__${name}__${t.name}`)}`);
        if (t.description) console.log(`    ${dim(t.description)}`);
      }
      return 0;
    }

    default:
      console.error(red(`Unknown subcommand "${sub}".`));
      hint();
      return 2;
  }
}
