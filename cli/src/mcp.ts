// `antbot mcp` — the MCP servers bots can use, and `antbot secret` — the credentials they need.
//
// One step. `add` takes a command or a URL (or a built-in's name), asks for a credential only
// when the server needs one, checks the server honestly, signs in when it can, and asks which
// bots get it. The `{{secret:NAME}}` reference syntax still exists in storage; nothing here
// makes a person type it.
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { getJson, postJson, patchJson, deleteJson } from './net.js';
import { bold, dim, green, red, yellow } from './color.js';

interface Check {
  status: 'ready' | 'needs-sign-in' | 'needs-credential' | 'unreachable';
  selfRegistration?: boolean;
  provider?: string;
  tools: { name: string; description: string }[];
  detail?: string;
  alternative?: string;
}
interface ConnectorRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  kind: 'custom' | 'builtin';
  config: Record<string, unknown>;
  missingSecrets: string[];
  signedIn: boolean;
  lastStatus: string | null;
  lastError: string | null;
}
interface CatalogEntry {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  needsClientCredentials: boolean;
  setupSteps: string[];
}
interface BotRow { bot: { id: string; name: string; slug: string } }

/* ------------------------------ pure helpers ------------------------------ */

/** Quote-aware split. Not a shell: the daemon spawns the command directly. */
export function splitCommand(input: string): { command: string; args: string[] } {
  const parts = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const clean = parts.map((p) =>
    (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")) ? p.slice(1, -1) : p,
  );
  return { command: clean[0] ?? '', args: clean.slice(1) };
}

export const looksLikeUrl = (s: string): boolean => /^https?:\/\//i.test(s.trim());

/** Values of a repeatable `--flag`, in order. */
export function collectFlag(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[++i]!);
  return out;
}
export function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The secret name an env var or header value is stored under. Never typed by a person. */
export const secretNameFor = (connector: string, key: string): string => `mcp/${connector}/${key}`;

export interface PlannedPair { key: string; value: string; secret: boolean }

/**
 * `--env A=1 --env TOKEN` → `A` literal, `TOKEN` to be prompted and stored as a secret.
 * A value given inline is a literal; a bare key means "ask me, and keep it out of the config".
 */
export function planPairs(raw: string[]): PlannedPair[] {
  return raw.map((r) => {
    const eq = r.indexOf('=');
    if (eq > 0) return { key: r.slice(0, eq), value: r.slice(eq + 1), secret: false };
    return { key: r, value: '', secret: true };
  });
}

/** Resolve `--bots` against the roster: slugs or names, `all`, or nothing. */
export function resolveBots(spec: string | undefined, roster: BotRow[]): string[] | 'ask' | null {
  if (spec === undefined) return 'ask';
  if (spec === 'none' || spec === '') return null;
  if (spec === 'all') return roster.map((r) => r.bot.id);
  const wanted = spec.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return roster.filter((r) => wanted.includes(r.bot.slug) || wanted.includes(r.bot.name.toLowerCase())).map((r) => r.bot.id);
}

export function describeVerdict(name: string, check: Check): string {
  const n = check.tools.length;
  switch (check.status) {
    case 'ready':
      return green(`✓ ${name}: ready, ${n} tool${n === 1 ? '' : 's'}`);
    case 'needs-sign-in':
      if (check.alternative) return red(`✗ ${name}: ${check.detail ?? `use the built-in instead: antbot mcp add ${check.alternative}`}`);
      return yellow(`! ${name}: needs sign-in${check.provider ? ` (${check.provider})` : ''}${n ? `, ${n} tools` : ''}`);
    case 'needs-credential':
      return yellow(`! ${name}: ${check.detail ?? 'needs a credential'}`);
    case 'unreachable':
      return red(`✗ ${name}: unreachable${check.detail ? ` — ${check.detail}` : ''}`);
  }
}

/* ------------------------------ I/O helpers ------------------------------ */

async function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Mute echo for the answer only: write the prompt, then swallow output until Enter.
    const out = process.stdout as NodeJS.WriteStream & { write: (s: string) => boolean };
    const orig = out.write.bind(out);
    process.stdout.write(question);
    let muted = true;
    (out as { write: (s: string) => boolean }).write = ((s: string) => (muted ? true : orig(s))) as typeof out.write;
    try {
      const v = await rl.question('');
      return v.trim();
    } finally {
      muted = false;
      (out as { write: (s: string) => boolean }).write = orig;
      process.stdout.write('\n');
      rl.close();
    }
  }
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Best effort: open the URL, else print it. Never a hard failure. */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* fall through to printing */ }
  console.log(dim('  If a browser did not open, use this link:'));
  console.log(`  ${url}`);
}

async function load(port: number): Promise<ConnectorRow[] | null> {
  try {
    return await getJson<ConnectorRow[]>(port, '/api/connectors');
  } catch (err) {
    console.error(red(`Could not reach the daemon on port ${port}: ${(err as Error).message}`));
    console.error(dim('Start it with `antbot start`.'));
    return null;
  }
}

/** Store the secrets a plan needs, prompting for each. Returns the config-ready record. */
async function storePairs(port: number, connector: string, pairs: PlannedPair[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    if (!p.secret) { out[p.key] = p.value; continue; }
    const value = await ask(`  ${p.key}: `, true);
    if (!value) throw new Error(`${p.key} needs a value.`);
    const name = secretNameFor(connector, p.key);
    await postJson(port, '/api/secrets', { name, value });
    out[p.key] = `{{secret:${name}}}`;
  }
  return out;
}

/** Sign in: begin, open the browser, then poll the row until it reports signed in (or time out). */
async function signIn(port: number, row: ConnectorRow, opts: { clientId?: string; clientSecret?: string }): Promise<boolean> {
  let res: { authorizeUrl: string };
  try {
    res = await postJson<{ authorizeUrl: string }>(port, `/api/connectors/${row.id}/login`, opts);
  } catch (err) {
    console.error(yellow(`  ${(err as Error).message}`));
    return false;
  }
  console.log(dim('  Opening your browser to sign in…'));
  openBrowser(res.authorizeUrl);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const rows = await getJson<ConnectorRow[]>(port, '/api/connectors').catch(() => []);
    const cur = rows.find((r) => r.id === row.id);
    if (cur?.signedIn) return true;
  }
  console.log(yellow('  Still waiting for the sign-in. Finish it in the browser, then run: antbot mcp check ' + row.name));
  return false;
}

/** Guided client-credential entry for a provider that will not register apps itself. */
async function collectClientCredentials(entry: CatalogEntry | null, provider: string | undefined): Promise<{ clientId: string; clientSecret?: string } | null> {
  console.log(yellow(`  ${provider ?? 'This provider'} needs an OAuth client you create yourself — a one-time setup:`));
  for (const [i, step] of (entry?.setupSteps ?? []).entries()) console.log(`    ${i + 1}. ${step}`);
  const clientId = await ask('  Client ID (blank to do this later): ');
  if (!clientId) return null;
  const clientSecret = await ask('  Client secret (blank if none): ', true);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

/* --------------------------------- commands -------------------------------- */

export async function runMcpCommand(argv: string[], port: number): Promise<number> {
  const sub = argv[0];
  const hint = (): void => {
    console.error(dim('Subcommands: list, add, check, login, logout, enable, disable, remove.'));
    console.error(dim('Run `antbot mcp --help` for the full usage.'));
  };
  if (!sub) { console.error(red('antbot mcp needs a subcommand.')); hint(); return 2; }

  const byName = async (name: string): Promise<ConnectorRow | null> => {
    const rows = await load(port);
    if (!rows) return null;
    const m = rows.find((c) => c.name === name);
    if (!m) console.error(red(`No connector named "${name}".`));
    return m ?? null;
  };

  switch (sub) {
    case 'list': {
      const rows = await load(port);
      if (!rows) return 1;
      if (!rows.length) { console.log(dim('No connectors yet. Add one with `antbot mcp add`.')); return 0; }
      const roster = await getJson<BotRow[]>(port, '/api/bots').catch(() => [] as BotRow[]);
      const assigned = new Map<string, string[]>();
      for (const r of roster) {
        const cs = await getJson<{ name: string }[]>(port, `/api/bots/${r.bot.id}/connectors`).catch(() => []);
        for (const c of cs) assigned.set(c.name, [...(assigned.get(c.name) ?? []), r.bot.name]);
      }
      for (const c of rows) {
        const kind = c.kind === 'builtin' ? 'built-in' : String(c.config.transport ?? '?');
        const state = !c.enabled ? dim('disabled')
          : c.signedIn ? green('signed in')
          : c.missingSecrets.length ? yellow(`missing secret: ${c.missingSecrets.join(', ')}`)
          : c.lastStatus === 'ready' || c.lastStatus === 'connected' ? green('ready')
          : c.lastStatus ? yellow(c.lastStatus) : dim('unchecked');
        const bots = assigned.get(c.name)?.length ? dim(`→ ${assigned.get(c.name)!.join(', ')}`) : dim('→ no bots');
        console.log(`${bold(c.name.padEnd(14))} ${kind.padEnd(9)} ${state}  ${bots}`);
        if (c.description) console.log(`  ${dim(c.description)}`);
        if (c.lastError && c.lastStatus !== 'ready') console.log(`  ${dim(c.lastError)}`);
      }
      return 0;
    }

    case 'add': {
      const name = argv[1];
      const target = argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined;
      if (!name || name.startsWith('--')) {
        console.error(red('Usage: antbot mcp add <name> [<command> | <url>] [--env VAR[=value]]... [--header K=V]... [--bots a,b|all]'));
        return 2;
      }
      const catalog = await getJson<CatalogEntry[]>(port, '/api/connectors/catalog').catch(() => [] as CatalogEntry[]);
      const entry = catalog.find((e) => e.name === name) ?? null;

      let body: Record<string, unknown>;
      if (!target) {
        if (!entry) {
          console.error(red(`"${name}" is not a built-in connector. Give a command or a URL:`));
          console.error(dim(`  antbot mcp add ${name} "npx -y some-server"    or    antbot mcp add ${name} https://…/mcp`));
          if (catalog.length) console.error(dim(`  Built-in: ${catalog.map((e) => e.name).join(', ')}`));
          return 2;
        }
        console.log(`${bold(entry.displayName)} is built into ant-bot. ${entry.description}`);
        body = { name, builtin: name };
      } else if (looksLikeUrl(target)) {
        const headers = await storePairs(port, name, planPairs(collectFlag(argv, '--header')));
        const transport = flagValue(argv, '--transport') === 'sse' ? 'sse' : 'http';
        body = { name, config: { transport, url: target.trim(), headers } };
      } else {
        const { command, args } = splitCommand(target);
        if (!command) { console.error(red('The command is empty.')); return 2; }
        const env = await storePairs(port, name, planPairs(collectFlag(argv, '--env')));
        body = { name, config: { transport: 'stdio', command, args, env } };
      }
      if (flagValue(argv, '--desc')) body.description = flagValue(argv, '--desc');

      // Bots: resolve now so the row is created already assigned (one round trip, one step).
      const roster = await getJson<BotRow[]>(port, '/api/bots').catch(() => [] as BotRow[]);
      let botIds = resolveBots(flagValue(argv, '--bots'), roster);
      if (botIds === 'ask') {
        if (roster.length) {
          const names = roster.map((r) => r.bot.name).join(', ');
          const ans = await ask(`  Give it to which bots? [${names}, all, none] `);
          botIds = resolveBots(ans || 'none', roster);
        } else botIds = null;
      }
      if (botIds && botIds.length) body.botIds = botIds;

      let created: ConnectorRow & { check: Check };
      try {
        created = await postJson(port, '/api/connectors', body);
      } catch (err) {
        console.error(red((err as Error).message));
        return 1;
      }
      console.log(describeVerdict(name, created.check));

      // Sign in right away when the verdict says so — that is the whole point of one step.
      if (created.check.status === 'needs-sign-in' && !created.check.alternative) {
        let creds: { clientId?: string; clientSecret?: string } = {};
        if (!created.check.selfRegistration) {
          const c = await collectClientCredentials(entry, created.check.provider);
          if (!c) {
            console.log(dim(`  Later: antbot mcp login ${name} --client-id ID --client-secret SECRET`));
            return 0;
          }
          creds = c;
        }
        const ok = await signIn(port, created, creds);
        if (ok) {
          const check = await postJson<Check>(port, `/api/connectors/${created.id}/check`, {});
          console.log(describeVerdict(name, check));
        }
      }
      if (botIds && botIds.length) console.log(dim(`  Assigned to ${botIds.length} bot${botIds.length === 1 ? '' : 's'}.`));
      else console.log(dim('  Not assigned to any bot yet — tick it in Bot settings when you want a bot to have it.'));
      return 0;
    }

    case 'check': {
      const name = argv[1];
      if (!name) { console.error(red('Usage: antbot mcp check <name>')); return 2; }
      const row = await byName(name);
      if (!row) return 1;
      const check = await postJson<Check>(port, `/api/connectors/${row.id}/check`, {});
      console.log(describeVerdict(name, check));
      for (const t of check.tools) console.log(`  ${bold(`mcp__${name}__${t.name}`)}${t.description ? dim(`  ${t.description.slice(0, 90)}`) : ''}`);
      if (check.status === 'needs-sign-in' && !check.alternative) console.log(dim(`  Sign in with: antbot mcp login ${name}`));
      return check.status === 'ready' ? 0 : 1;
    }

    case 'login': {
      const name = argv[1];
      if (!name) { console.error(red('Usage: antbot mcp login <name> [--client-id ID] [--client-secret SECRET]')); return 2; }
      const row = await byName(name);
      if (!row) return 1;
      const creds: { clientId?: string; clientSecret?: string } = {};
      const cid = flagValue(argv, '--client-id');
      const csec = flagValue(argv, '--client-secret');
      if (cid) creds.clientId = cid;
      if (csec) creds.clientSecret = csec;
      const ok = await signIn(port, row, creds);
      if (ok) {
        const check = await postJson<Check>(port, `/api/connectors/${row.id}/check`, {});
        console.log(describeVerdict(name, check));
        return 0;
      }
      return 1;
    }

    case 'logout': {
      const name = argv[1];
      if (!name) { console.error(red('Usage: antbot mcp logout <name>')); return 2; }
      const row = await byName(name);
      if (!row) return 1;
      await deleteJson(port, `/api/connectors/${row.id}/login`);
      console.log(green(`Signed out of "${name}".`));
      return 0;
    }

    case 'enable':
    case 'disable': {
      const name = argv[1];
      if (!name) { console.error(red(`Usage: antbot mcp ${sub} <name>`)); return 2; }
      const row = await byName(name);
      if (!row) return 1;
      await patchJson(port, `/api/connectors/${row.id}`, { enabled: sub === 'enable' });
      console.log(green(`Connector "${name}" ${sub}d.`));
      return 0;
    }

    case 'remove': {
      const name = argv[1];
      if (!name) { console.error(red('Usage: antbot mcp remove <name>')); return 2; }
      const row = await byName(name);
      if (!row) return 1;
      await deleteJson(port, `/api/connectors/${row.id}`);
      console.log(green(`Removed "${name}". Bot assignments for it are gone too.`));
      return 0;
    }

    default:
      console.error(red(`Unknown subcommand "${sub}".`));
      hint();
      return 2;
  }
}

export async function runSecretCommand(argv: string[], port: number): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case 'list': {
      try {
        const r = await getJson<{ backend: string; names: string[] }>(port, '/api/secrets');
        if (!r.names.length) console.log(dim(`No secrets stored (backend: ${r.backend}).`));
        for (const n of r.names) console.log(n);
        return 0;
      } catch (err) {
        console.error(red((err as Error).message));
        return 1;
      }
    }
    case 'set': {
      const name = argv[1];
      if (!name) { console.error(red('Usage: antbot secret set <NAME>')); return 2; }
      const value = await ask(`  Value for ${name}: `, true);
      if (!value) { console.error(red('A value is required.')); return 2; }
      try {
        await postJson(port, '/api/secrets', { name, value });
        console.log(green(`Stored ${name} in the keychain.`));
        return 0;
      } catch (err) {
        console.error(red((err as Error).message));
        return 1;
      }
    }
    case 'remove': {
      const name = argv[1];
      if (!name) { console.error(red('Usage: antbot secret remove <NAME>')); return 2; }
      await deleteJson(port, `/api/secrets/${encodeURIComponent(name)}`);
      console.log(green(`Removed ${name}.`));
      return 0;
    }
    default:
      console.error(red('Usage: antbot secret list | set <NAME> | remove <NAME>'));
      return 2;
  }
}
