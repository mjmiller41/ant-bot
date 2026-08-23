// Hand-rolled argument parser. No external CLI framework.

export const KNOWN_COMMANDS = [
  'start',
  'stop',
  'restart',
  'status',
  'doctor',
  'open',
  'skill',
  'backup',
  'restore',
] as const;

export type Command = (typeof KNOWN_COMMANDS)[number];

export class CliError extends Error {}

export type FlagType = 'string' | 'boolean' | 'number';

export interface FlagDef {
  type: FlagType;
  default?: string | number | boolean;
}

export type FlagSpecs = Record<string, FlagDef>;

/** Per-command flag definitions, including defaults. */
export const COMMAND_FLAGS: Record<Command, FlagSpecs> = {
  start: {
    port: { type: 'number' },
    foreground: { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
  },
  stop: {},
  restart: {
    port: { type: 'number' },
  },
  status: {},
  doctor: {},
  open: {},
  skill: {},
  backup: {
    out: { type: 'string' },
  },
  restore: {
    yes: { type: 'boolean', default: false },
  },
};

export interface ParsedArgs {
  command: Command | null;
  help: boolean;
  version: boolean;
  positionals: string[];
  flags: Record<string, string | number | boolean>;
}

function isKnownCommand(value: string): value is Command {
  return (KNOWN_COMMANDS as readonly string[]).includes(value);
}

/**
 * Parse process.argv-style arguments (excluding `node`/script path).
 * Throws CliError on unknown command / unknown flag / missing flag value.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: null, help: true, version: false, positionals: [], flags: {} };
  }

  const first = argv[0];

  if (first === '--version' || first === '-v') {
    return { command: null, help: false, version: true, positionals: [], flags: {} };
  }

  if (first === '--help' || first === '-h') {
    return { command: null, help: true, version: false, positionals: [], flags: {} };
  }

  if (first.startsWith('-')) {
    throw new CliError(`Unknown option: ${first}\nRun "antbot --help" for usage.`);
  }

  if (!isKnownCommand(first)) {
    throw new CliError(`Unknown command: "${first}"\nRun "antbot --help" for usage.`);
  }

  const command = first;
  const spec = COMMAND_FLAGS[command];
  const rest = argv.slice(1);

  const flags: Record<string, string | number | boolean> = {};
  for (const [name, def] of Object.entries(spec)) {
    if (def.default !== undefined) flags[name] = def.default;
  }

  const positionals: string[] = [];
  let help = false;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];

    if (tok === '--help' || tok === '-h') {
      help = true;
      continue;
    }

    if (tok.startsWith('--')) {
      let name = tok.slice(2);
      let inlineValue: string | undefined;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }

      const def = spec[name];
      if (!def) {
        throw new CliError(`Unknown flag "--${name}" for command "${command}"`);
      }

      if (def.type === 'boolean') {
        flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
        continue;
      }

      const raw = inlineValue !== undefined ? inlineValue : rest[++i];
      if (raw === undefined) {
        throw new CliError(`Flag "--${name}" requires a value`);
      }
      if (def.type === 'number') {
        const num = Number(raw);
        if (Number.isNaN(num)) {
          throw new CliError(`Flag "--${name}" must be a number, got "${raw}"`);
        }
        flags[name] = num;
      } else {
        flags[name] = raw;
      }
      continue;
    }

    positionals.push(tok);
  }

  return { command, help, version: false, positionals, flags };
}
