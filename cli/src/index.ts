#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline/promises';
import path from 'node:path';
import { parseArgs, CliError, type Command } from './args.js';
import { GLOBAL_HELP, commandHelp } from './help.js';
import { getCliVersion } from './version.js';
import { runDoctor, type CheckResult, type CheckStatus } from './doctor.js';
import { runCommand } from './proc.js';
import { probePort, getHealth } from './net.js';
import { loadConfig } from '@antbot/daemon/config/config.js';
import { importServerDependency } from './serverBridge.js';
import { bold, dim, green, red, yellow } from './color.js';
import {
  cmdStartDetached,
  cmdStartForeground,
  cmdStop,
  cmdRestart,
  cmdStatus,
  cmdOpen,
  loadPaths,
} from './daemon.js';
import { createBackup, restoreBackup } from './backup.js';
import { runSkillCommand } from './skill.js';
import { runConnectorCommand } from './connector.js';
import { runUpdateCommand, printUpdateNotice } from './updateCommand.js';

async function runDoctorCommand(): Promise<number> {
  const paths = loadPaths();
  const port = 4780;

  const report = await runDoctor({
    nodeVersion: process.versions.node,
    env: process.env,
    homeDir: process.env.HOME ?? process.env.USERPROFILE ?? '',
    dataDir: paths.root,
    port,

    fileExists: (p) => fs.existsSync(p),
    fileSize: (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return 0;
      }
    },
    isDirWritable: (dir) => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },

    exec: (cmd, args) => runCommand(cmd, args),
    probePort: (p) => probePort(p),
    healthCheck: (p) => getHealth(p),

    importBetterSqlite3: () => importServerDependency('better-sqlite3'),
    importPlaywright: async () => {
      const mod = (await importServerDependency('playwright')) as {
        default?: { chromium: { executablePath: () => string } };
        chromium?: { executablePath: () => string };
      };
      const pw = mod.default ?? mod;
      if (!pw.chromium) throw new Error('playwright module has no chromium export');
      return { chromium: pw.chromium };
    },
  });

  renderDoctorTable(report.results);
  return report.exitCode;
}

function symbolFor(status: CheckStatus): string {
  if (status === 'pass') return green('✓');
  if (status === 'warn') return yellow('⚠');
  return red('✗');
}

function renderDoctorTable(results: CheckResult[]): void {
  const nameWidth = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${symbolFor(r.status)} ${bold(r.name.padEnd(nameWidth))}  ${r.message}`);
    if (r.hint && r.status !== 'pass') {
      console.log(`   ${dim(`-> ${r.hint}`)}`);
    }
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  console.log('');
  if (failed > 0) {
    console.log(red(`${failed} check(s) failed, ${warned} warning(s).`));
  } else if (warned > 0) {
    console.log(yellow(`All checks passed with ${warned} warning(s).`));
  } else {
    console.log(green('All checks passed.'));
  }
}

async function runBackupCommand(outFlag: string | undefined): Promise<number> {
  const paths = loadPaths();
  const outPath =
    outFlag ?? path.join(paths.backups, `antbot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  try {
    const result = await createBackup({
      root: paths.root,
      dbPath: paths.db,
      configPath: paths.config,
      skillsDir: paths.skills,
      botsDir: path.join(paths.workspace, 'bots'),
      outPath,
    });
    const kb = (result.bytes / 1024).toFixed(1);
    console.log(green(`Backup written to ${result.outPath} (${kb} KB)`));
    return 0;
  } catch (err) {
    console.error(red((err as Error).message));
    return 1;
  }
}

async function runRestoreCommand(archivePath: string | undefined, skipConfirm: boolean): Promise<number> {
  if (!archivePath) {
    console.error(red('Usage: antbot restore <path> [--yes]'));
    return 2;
  }
  const paths = loadPaths();

  if (!skipConfirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `This will overwrite files under ${paths.root} with the contents of ${archivePath}. Continue? [y/N] `,
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted.');
      return 0;
    }
  }

  try {
    await restoreBackup({ archivePath, root: paths.root });
    console.log(green(`Restored ${archivePath} into ${paths.root}`));
    return 0;
  } catch (err) {
    console.error(red((err as Error).message));
    return 1;
  }
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      console.error(red(err.message));
      process.exit(2);
    }
    throw err;
  }

  if (parsed.version) {
    console.log(getCliVersion());
    process.exit(0);
  }

  if (parsed.help || !parsed.command) {
    console.log(parsed.command ? commandHelp(parsed.command) : GLOBAL_HELP);
    process.exit(0);
  }

  const command: Command = parsed.command;

  switch (command) {
    case 'start': {
      const port = typeof parsed.flags.port === 'number' ? parsed.flags.port : undefined;
      const foreground = Boolean(parsed.flags.foreground);
      const openAfter = Boolean(parsed.flags.open);
      if (foreground) {
        const code = await cmdStartForeground(port, openAfter);
        if (code !== 0) process.exit(code);
        return; // keep the event loop alive; the server owns it now
      }
      process.exit(await cmdStartDetached(port, openAfter));
      return;
    }
    case 'stop':
      process.exit(await cmdStop());
      return;
    case 'restart':
      process.exit(await cmdRestart(typeof parsed.flags.port === 'number' ? parsed.flags.port : undefined));
      return;
    // The update notice is printed here rather than inside the commands themselves: it is the
    // only thing in the CLI that touches the network, and keeping it at the dispatch layer means
    // neither cmdStatus nor runDoctor grows a dependency on it.
    case 'status': {
      const code = await cmdStatus();
      await printUpdateNotice();
      process.exit(code);
      return;
    }
    case 'doctor': {
      const code = await runDoctorCommand();
      await printUpdateNotice();
      process.exit(code);
      return;
    }
    case 'open':
      process.exit(await cmdOpen());
      return;
    case 'skill': {
      const cfg = loadConfig();
      process.exit(await runSkillCommand(parsed.positionals, cfg.port));
      return;
    }
    // `connector` is the older name for the same thing, kept working.
    case 'mcp':
    case 'connector': {
      const cfg = loadConfig();
      process.exit(await runConnectorCommand(parsed.positionals, cfg.port));
      return;
    }
    case 'backup':
      process.exit(await runBackupCommand(typeof parsed.flags.out === 'string' ? parsed.flags.out : undefined));
      return;
    case 'restore':
      process.exit(await runRestoreCommand(parsed.positionals[0], Boolean(parsed.flags.yes)));
      return;
    case 'update':
      process.exit(
        await runUpdateCommand({ check: Boolean(parsed.flags.check), yes: Boolean(parsed.flags.yes) }),
      );
      return;
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unhandled command: ${String(_exhaustive)}`);
    }
  }
}

main().catch((err) => {
  console.error(red(`antbot: ${(err as Error).stack ?? (err as Error).message}`));
  process.exit(1);
});
