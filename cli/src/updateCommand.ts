// The `antbot update` command and the cached notice that `status` and `doctor` print.
// The decisions all live in update.ts; this file is the filesystem, network and process edge.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { getCliVersion } from './version.js';
import { runCommand } from './proc.js';
import { loadPaths } from './daemon.js';
import { bold, dim, green, red, yellow } from './color.js';
import {
  checkForUpdate,
  detectPackageManager,
  fetchLatestVersion,
  isCheckoutInstall,
  updateCommand,
  type UpdateStatus,
} from './update.js';

const CACHE_FILE = 'update-check.json';

function cachePath(): string {
  return path.join(loadPaths().root, CACHE_FILE);
}

function installPath(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * The once-a-day check, wired to the real filesystem and registry. Silent on every failure —
 * a command must not fail because a registry did not answer.
 */
export async function currentUpdateStatus(): Promise<UpdateStatus> {
  const file = cachePath();
  return checkForUpdate({
    currentVersion: getCliVersion(),
    now: Date.now(),
    readCache: () => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    writeCache: (contents) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents, 'utf8');
      } catch {
        /* a read-only data dir is not worth a warning here */
      }
    },
    fetchLatest: () => fetchLatestVersion(),
  });
}

/**
 * Prints the update line for `status` and `doctor`, if there is one. A checkout is skipped:
 * telling a contributor to run `antbot update` on their own working tree is noise.
 */
export async function printUpdateNotice(): Promise<void> {
  if (isCheckoutInstall(installPath(), (p) => fs.existsSync(p))) return;
  const status = await currentUpdateStatus();
  if (status.notice) console.log(yellow(`  ${status.notice}`));
}

export async function runUpdateCommand(opts: { check: boolean; yes: boolean }): Promise<number> {
  const here = installPath();
  const current = getCliVersion();

  if (isCheckoutInstall(here, (p) => fs.existsSync(p))) {
    console.error(red('This is a git checkout, not a package-manager install.'));
    console.error(dim('Update it with:  git pull && pnpm install'));
    return 2;
  }

  const status = await currentUpdateStatus();
  if (status.latest === null) {
    console.error(red('Could not reach the npm registry to check for updates.'));
    return 1;
  }
  if (!status.isUpgrade) {
    console.log(green(`ant-bot ${current} is up to date.`) + (status.cached ? dim(' (cached)') : ''));
    return 0;
  }

  console.log(bold(`ant-bot ${current} → ${status.latest}`));
  if (opts.check) return 0;

  const pm = detectPackageManager(here);
  const { cmd, args } = updateCommand(pm);

  if (!opts.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Run \`${cmd} ${args.join(' ')}\`? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Aborted.');
      return 0;
    }
  }

  console.log(dim(`$ ${cmd} ${args.join(' ')}`));
  const result = await runCommand(cmd, args);
  if (result.code !== 0) {
    console.error(red(`${cmd} exited with code ${result.code}`));
    if (result.stderr) console.error(dim(result.stderr.trim()));
    return 1;
  }

  // The freshly-installed copy has a different version; the cached answer is now wrong.
  try {
    fs.rmSync(cachePath(), { force: true });
  } catch {
    /* ignore */
  }

  console.log(green(`Updated to ${status.latest}.`));
  console.log(dim('Restart a running daemon to pick it up:  antbot restart'));
  return 0;
}
