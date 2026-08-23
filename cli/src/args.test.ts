import { describe, it, expect } from 'vitest';
import { parseArgs, CliError, KNOWN_COMMANDS, COMMAND_FLAGS } from './args.js';
import { GLOBAL_HELP, commandHelp } from './help.js';

describe('parseArgs', () => {
  it('defaults to help when no args are given', () => {
    const parsed = parseArgs([]);
    expect(parsed.command).toBeNull();
    expect(parsed.help).toBe(true);
    expect(parsed.version).toBe(false);
  });

  it('recognizes --help and -h as top-level help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).command).toBeNull();
  });

  it('recognizes --version and -v', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
  });

  it('parses a known command with no flags', () => {
    const parsed = parseArgs(['status']);
    expect(parsed.command).toBe('status');
    expect(parsed.help).toBe(false);
    expect(parsed.flags).toEqual({});
  });

  it('throws CliError for an unknown command', () => {
    expect(() => parseArgs(['bogus'])).toThrow(CliError);
    expect(() => parseArgs(['bogus'])).toThrow(/Unknown command/);
  });

  it('throws CliError for an unknown top-level option', () => {
    expect(() => parseArgs(['--nope'])).toThrow(CliError);
  });

  it('applies flag defaults for a command', () => {
    const parsed = parseArgs(['start']);
    expect(parsed.flags.foreground).toBe(false);
    expect(parsed.flags.port).toBeUndefined();
  });

  it('parses --port N as a number', () => {
    const parsed = parseArgs(['start', '--port', '5000']);
    expect(parsed.flags.port).toBe(5000);
    expect(typeof parsed.flags.port).toBe('number');
  });

  it('parses --port=N inline syntax', () => {
    const parsed = parseArgs(['start', '--port=5001']);
    expect(parsed.flags.port).toBe(5001);
  });

  it('parses boolean flags without consuming the next token', () => {
    const parsed = parseArgs(['start', '--foreground', '--port', '4000']);
    expect(parsed.flags.foreground).toBe(true);
    expect(parsed.flags.port).toBe(4000);
  });

  it('parses --flag=false as boolean false', () => {
    const parsed = parseArgs(['start', '--foreground=false']);
    expect(parsed.flags.foreground).toBe(false);
  });

  it('throws CliError for an unknown flag on a valid command', () => {
    expect(() => parseArgs(['status', '--bogus'])).toThrow(CliError);
    expect(() => parseArgs(['status', '--bogus'])).toThrow(/Unknown flag/);
  });

  it('throws CliError when a value-flag is missing its value', () => {
    expect(() => parseArgs(['start', '--port'])).toThrow(CliError);
  });

  it('throws CliError when a numeric flag gets a non-numeric value', () => {
    expect(() => parseArgs(['start', '--port', 'abc'])).toThrow(CliError);
  });

  it('collects positionals, e.g. restore <path>', () => {
    const parsed = parseArgs(['restore', '/tmp/backup.tar.gz']);
    expect(parsed.command).toBe('restore');
    expect(parsed.positionals).toEqual(['/tmp/backup.tar.gz']);
  });

  it('parses backup --out PATH', () => {
    const parsed = parseArgs(['backup', '--out', '/tmp/out.tar.gz']);
    expect(parsed.flags.out).toBe('/tmp/out.tar.gz');
  });

  it('sets help=true for a per-command --help without erroring', () => {
    const parsed = parseArgs(['start', '--help']);
    expect(parsed.command).toBe('start');
    expect(parsed.help).toBe(true);
  });

  it('restore defaults --yes to false', () => {
    const parsed = parseArgs(['restore', '/tmp/x.tar.gz']);
    expect(parsed.flags.yes).toBe(false);
  });

  it('parses restart, with an optional --port', () => {
    expect(parseArgs(['restart']).command).toBe('restart');
    expect(parseArgs(['restart', '--port', '5000']).flags.port).toBe(5000);
  });

  it('parses start --open and defaults it to false', () => {
    expect(parseArgs(['start']).flags.open).toBe(false);
    expect(parseArgs(['start', '--open']).flags.open).toBe(true);
  });

  it('parses start --open alongside --port and --foreground', () => {
    const parsed = parseArgs(['start', '--port', '4791', '--open', '--foreground']);
    expect(parsed.flags).toMatchObject({ port: 4791, open: true, foreground: true });
  });
});

describe('help', () => {
  it('documents every known command in the global help', () => {
    for (const command of KNOWN_COMMANDS) {
      expect(GLOBAL_HELP).toContain(command);
    }
  });

  it('has a non-empty help page for every known command', () => {
    for (const command of KNOWN_COMMANDS) {
      expect(commandHelp(command)).toMatch(new RegExp(`^antbot ${command} —`));
      // `skill` lists its subcommands under a multi-line Usage block.
      expect(commandHelp(command)).toMatch(new RegExp(`Usage:(\\n| )+antbot ${command}`));
    }
  });

  it("documents each command's flags on that command's help page", () => {
    for (const command of KNOWN_COMMANDS) {
      for (const flag of Object.keys(COMMAND_FLAGS[command])) {
        expect(commandHelp(command)).toContain(`--${flag}`);
      }
    }
  });
});

describe('connector: passthrough argument grammar', () => {
  // `--env K=V` repeats, which the flag parser's one-value-per-flag model cannot hold. The
  // subcommand parses its own tokens instead, so they must arrive untouched.
  it('passes every token through as a positional, repeats included', () => {
    const p = parseArgs(['connector', 'add', 'gh', '--stdio', 'npx srv', '--env', 'A=1', '--env', 'B=2']);
    expect(p.command).toBe('connector');
    expect(p.positionals).toEqual(['add', 'gh', '--stdio', 'npx srv', '--env', 'A=1', '--env', 'B=2']);
    expect(p.flags).toEqual({});
  });

  it('does not reject a flag it has never heard of', () => {
    expect(() => parseArgs(['connector', 'add', 'x', '--anything-at-all', 'v'])).not.toThrow();
  });

  it('keeps a secret reference intact', () => {
    const p = parseArgs(['connector', 'add', 'gh', '--env', 'T={{secret:GH}}']);
    expect(p.positionals).toContain('T={{secret:GH}}');
  });

  // One source of help text: --help is still intercepted so help.ts answers, not the subcommand.
  it('still intercepts --help', () => {
    expect(parseArgs(['connector', '--help']).help).toBe(true);
  });

  it('leaves other commands' + String.fromCharCode(39) + ' flag parsing alone', () => {
    expect(parseArgs(['start', '--port', '4791']).flags.port).toBe(4791);
    expect(() => parseArgs(['start', '--nope'])).toThrow();
  });
});
