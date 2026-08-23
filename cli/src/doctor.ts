import path from 'node:path';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PortHealth {
  ok: boolean;
  version?: string;
}

/**
 * Everything a doctor check needs, injected so checks are pure/testable without
 * touching the real filesystem, network, or child processes.
 */
export interface DoctorDeps {
  nodeVersion: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  dataDir: string;
  port: number;

  fileExists: (path: string) => boolean;
  fileSize: (path: string) => number;
  isDirWritable: (dir: string) => boolean;

  exec: (cmd: string, args: string[]) => Promise<ExecResult>;
  probePort: (port: number) => Promise<'free' | 'occupied'>;
  healthCheck: (port: number) => Promise<PortHealth>;

  importBetterSqlite3: () => Promise<unknown>;
  importPlaywright: () => Promise<{ chromium: { executablePath: () => string } }>;
}

function pass(name: string, message: string): CheckResult {
  return { name, status: 'pass', message };
}
function warn(name: string, message: string, hint: string): CheckResult {
  return { name, status: 'warn', message, hint };
}
function fail(name: string, message: string, hint: string): CheckResult {
  return { name, status: 'fail', message, hint };
}

export function checkNodeVersion(deps: Pick<DoctorDeps, 'nodeVersion'>): CheckResult {
  const major = Number.parseInt(deps.nodeVersion.split('.')[0] ?? '0', 10);
  if (Number.isFinite(major) && major >= 24) {
    return pass('Node.js version', `v${deps.nodeVersion}`);
  }
  return fail(
    'Node.js version',
    `v${deps.nodeVersion} (ant-bot requires >= 24)`,
    'Install Node.js 24 or later, e.g. via nvm: `nvm install 24`.',
  );
}

export async function checkClaudeCli(deps: Pick<DoctorDeps, 'exec'>): Promise<CheckResult> {
  try {
    const res = await deps.exec('claude', ['--version']);
    if (res.code === 0) {
      return pass('claude CLI', res.stdout.trim() || 'installed');
    }
    return fail(
      'claude CLI',
      `"claude --version" exited with code ${res.code}`,
      'Install with `npm i -g @anthropic-ai/claude-code`.',
    );
  } catch {
    return fail(
      'claude CLI',
      'not found on PATH',
      'Install with `npm i -g @anthropic-ai/claude-code`.',
    );
  }
}

export function checkClaudeAuth(
  deps: Pick<DoctorDeps, 'fileExists' | 'fileSize' | 'homeDir'>,
): CheckResult {
  const credentialsPath = path.join(deps.homeDir, '.claude', '.credentials.json');
  const claudeJsonPath = path.join(deps.homeDir, '.claude.json');

  if (deps.fileExists(credentialsPath)) {
    return pass('Claude authentication', `Found ${credentialsPath}`);
  }
  if (deps.fileExists(claudeJsonPath) && deps.fileSize(claudeJsonPath) > 50) {
    return pass('Claude authentication', `Found ${claudeJsonPath}`);
  }
  return warn(
    'Claude authentication',
    'No Claude Code credentials found',
    'Run `claude` once and log in.',
  );
}

export function checkApiKeyEnv(deps: Pick<DoctorDeps, 'env'>): CheckResult {
  const value = deps.env.ANTHROPIC_API_KEY;
  if (!value) {
    return pass('ANTHROPIC_API_KEY', 'Not set (turns bill to your Claude subscription)');
  }
  return warn(
    'ANTHROPIC_API_KEY',
    'Set in environment',
    "Set, but ant-bot strips it so turns bill to your subscription. Set billingMode='api' in settings if you want API billing instead.",
  );
}

export function checkDataDirWritable(deps: Pick<DoctorDeps, 'isDirWritable' | 'dataDir'>): CheckResult {
  if (deps.isDirWritable(deps.dataDir)) {
    return pass('Data directory', `${deps.dataDir} is writable`);
  }
  return fail(
    'Data directory',
    `${deps.dataDir} is not writable`,
    `Check permissions on ${deps.dataDir}.`,
  );
}

export async function checkPortAvailability(
  deps: Pick<DoctorDeps, 'probePort' | 'healthCheck' | 'port'>,
): Promise<CheckResult> {
  const state = await deps.probePort(deps.port);
  if (state === 'free') {
    return pass('Port', `Port ${deps.port} is free`);
  }
  const health = await deps.healthCheck(deps.port);
  if (health.ok) {
    return pass(
      'Port',
      `Port ${deps.port} is in use by a running antbot daemon${health.version ? ` (v${health.version})` : ''}`,
    );
  }
  return fail(
    'Port',
    `Port ${deps.port} is in use by another process`,
    `Stop the other process or run \`antbot start --port <N>\`.`,
  );
}

export async function checkBetterSqlite3(
  deps: Pick<DoctorDeps, 'importBetterSqlite3'>,
): Promise<CheckResult> {
  try {
    await deps.importBetterSqlite3();
    return pass('better-sqlite3', 'native module loads');
  } catch (err) {
    return fail(
      'better-sqlite3',
      `failed to load (${(err as Error).message})`,
      'Run `pnpm rebuild better-sqlite3`.',
    );
  }
}

export async function checkPlaywrightChromium(
  deps: Pick<DoctorDeps, 'importPlaywright' | 'fileExists'>,
): Promise<CheckResult> {
  try {
    const pw = await deps.importPlaywright();
    const execPath = pw.chromium.executablePath();
    if (deps.fileExists(execPath)) {
      return pass('Playwright Chromium', execPath);
    }
    return warn(
      'Playwright Chromium',
      `Expected browser binary at ${execPath}`,
      'Run `npx playwright install chromium`.',
    );
  } catch (err) {
    return warn(
      'Playwright Chromium',
      `Could not verify Chromium install (${(err as Error).message})`,
      'Run `npx playwright install chromium`.',
    );
  }
}

export interface DoctorReport {
  results: CheckResult[];
  exitCode: 0 | 1;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const results: CheckResult[] = [
    checkNodeVersion(deps),
    await checkClaudeCli(deps),
    checkClaudeAuth(deps),
    checkApiKeyEnv(deps),
    checkDataDirWritable(deps),
    await checkPortAvailability(deps),
    await checkBetterSqlite3(deps),
    await checkPlaywrightChromium(deps),
  ];
  const exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
  return { results, exitCode };
}
