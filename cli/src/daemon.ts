import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, ensureDirs, type AntbotPaths } from '@antbot/daemon/config/paths.js';
import { loadConfig, DEFAULT_PORT } from '@antbot/daemon/config/config.js';
import { pidFilePath, readPidFile, writePidFile, removePidFile, isProcessAlive } from './pid.js';
import { getHealth, getBotCount, waitForHealth } from './net.js';
import { startAntbotServer } from './serverBridge.js';
import { green, red, yellow, dim } from './color.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadPaths(): AntbotPaths {
  const paths = resolvePaths();
  ensureDirs(paths);
  return paths;
}

/** `antbot start --foreground`: runs the daemon in this process. */
export async function cmdStartForeground(port?: number, openAfter = false): Promise<number> {
  const cfg = loadConfig();
  const resolvedPort = port ?? cfg.port;
  try {
    const instance = await startAntbotServer({ port: resolvedPort, host: cfg.host });
    console.log(green(`antbot listening on http://${cfg.host}:${resolvedPort}`));
    if (openAfter) openInBrowser(`http://127.0.0.1:${resolvedPort}`);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(dim(`Received ${signal}, shutting down...`));
      try {
        await instance.close?.();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    return 0;
  } catch (err) {
    console.error(red(`Failed to start antbot: ${(err as Error).message}`));
    return 1;
  }
}

/** `antbot start`: spawns a detached foreground instance and waits for health. */
export async function cmdStartDetached(port?: number, openAfter = false): Promise<number> {
  const cfg = loadConfig();
  const paths = loadPaths();
  const resolvedPort = port ?? cfg.port ?? DEFAULT_PORT;

  const pidPath = pidFilePath(paths.root);
  const existing = readPidFile(pidPath);
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`antbot is already running at http://127.0.0.1:${existing.port} (pid ${existing.pid}).`);
    if (openAfter) openInBrowser(`http://127.0.0.1:${existing.port}`);
    return 0;
  }
  if (existing) removePidFile(pidPath);

  const logPath = path.join(paths.logs, 'antbot.log');
  fs.mkdirSync(paths.logs, { recursive: true });
  const logFd = fs.openSync(logPath, 'a');

  const selfEntry = process.argv[1];
  if (!selfEntry) {
    console.error(red('Could not determine the antbot entry point to spawn.'));
    return 1;
  }

  const child = spawn(
    process.execPath,
    [selfEntry, 'start', '--foreground', '--port', String(resolvedPort)],
    { detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();

  if (!child.pid) {
    console.error(red('Failed to spawn the antbot daemon.'));
    return 1;
  }
  writePidFile(pidPath, { pid: child.pid, port: resolvedPort, startedAt: Date.now() });

  console.log(`Starting antbot (pid ${child.pid}) on port ${resolvedPort}...`);
  const ok = await waitForHealth(resolvedPort, 30000);
  if (!ok) {
    console.error(red(`Timed out waiting for antbot to become healthy. Check ${logPath}`));
    return 1;
  }
  console.log(green(`antbot is running at http://127.0.0.1:${resolvedPort}`));
  if (openAfter) openInBrowser(`http://127.0.0.1:${resolvedPort}`);
  return 0;
}

export async function cmdStop(): Promise<number> {
  const paths = loadPaths();
  const pidPath = pidFilePath(paths.root);
  const data = readPidFile(pidPath);

  if (!data || !isProcessAlive(data.pid)) {
    console.log('antbot is not running.');
    if (data) removePidFile(pidPath);
    return 0;
  }

  console.log(`Stopping antbot (pid ${data.pid})...`);
  try {
    process.kill(data.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && isProcessAlive(data.pid)) {
    await sleep(200);
  }

  if (isProcessAlive(data.pid)) {
    console.log(yellow('Process did not exit in time, sending SIGKILL.'));
    try {
      process.kill(data.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }

  removePidFile(pidPath);
  console.log(green('antbot stopped.'));
  return 0;
}

export async function cmdStatus(): Promise<number> {
  const paths = loadPaths();
  const pidPath = pidFilePath(paths.root);
  const data = readPidFile(pidPath);
  const alive = !!data && isProcessAlive(data.pid);

  // A daemon started outside the CLI (e.g. `node dist/main.js`, or a dev runner)
  // writes no pidfile, so fall back to probing the configured port before
  // declaring it down — otherwise `status` contradicts `doctor`.
  if (!alive || !data) {
    const cfgPort = loadConfig().port ?? DEFAULT_PORT;
    const probe = await getHealth(cfgPort);
    if (!probe.ok) {
      console.log(red('antbot is not running.'));
      return 1;
    }
    const count = await getBotCount(cfgPort);
    console.log(green('antbot is running (started outside the CLI — no pidfile)'));
    console.log(`  URL:      http://127.0.0.1:${cfgPort}`);
    console.log(`  Version:  ${probe.version ?? 'unknown'}`);
    console.log(`  Data dir: ${paths.root}`);
    console.log(`  Bots:     ${count ?? 'unknown'}`);
    console.log(yellow('  Note: `antbot stop` cannot stop it; stop it where it was started.'));
    return 0;
  }

  const health = await getHealth(data.port);
  const botCount = health.ok ? await getBotCount(data.port) : null;

  console.log(green(`antbot is running (pid ${data.pid})`));
  console.log(`  URL:      http://127.0.0.1:${data.port}`);
  console.log(`  Version:  ${health.version ?? 'unknown'}`);
  console.log(`  Data dir: ${paths.root}`);
  console.log(`  Bots:     ${botCount ?? 'unknown'}`);
  if (!health.ok) {
    console.log(yellow('  Warning: process is alive but /api/health is not responding.'));
  }
  return health.ok ? 0 : 1;
}

/** Hand a URL to the platform's default browser. Never fails the command. */
export function openInBrowser(url: string): void {
  console.log(url);
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(opener, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    });
    child.on('error', () => {
      console.log(dim(`Could not launch a browser automatically. Open ${url} manually.`));
    });
    child.unref();
  } catch {
    console.log(dim(`Could not launch a browser automatically. Open ${url} manually.`));
  }
}

/** `antbot restart`: stop if running, then start detached again. */
export async function cmdRestart(port?: number): Promise<number> {
  const stopCode = await cmdStop();
  if (stopCode !== 0) return stopCode;
  return cmdStartDetached(port);
}

/**
 * `antbot open`: open the UI, starting the daemon first if it is not up yet, so
 * one command gets you from a cold checkout to a working UI.
 */
export async function cmdOpen(): Promise<number> {
  const paths = loadPaths();
  const cfg = loadConfig();
  const pidPath = pidFilePath(paths.root);
  const data = readPidFile(pidPath);
  const port = data?.port ?? cfg.port ?? DEFAULT_PORT;

  const health = await getHealth(port);
  if (!health.ok) {
    console.log(dim('antbot is not running — starting it first...'));
    const code = await cmdStartDetached(port);
    if (code !== 0) return code;
  }

  openInBrowser(`http://127.0.0.1:${port}`);
  return 0;
}
