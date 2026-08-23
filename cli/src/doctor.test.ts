import { describe, it, expect } from 'vitest';
import {
  checkNodeVersion,
  checkClaudeCli,
  checkClaudeAuth,
  checkApiKeyEnv,
  checkDataDirWritable,
  checkPortAvailability,
  checkBetterSqlite3,
  checkPlaywrightChromium,
  runDoctor,
  type DoctorDeps,
} from './doctor.js';

describe('checkNodeVersion', () => {
  it('passes on Node >= 24', () => {
    expect(checkNodeVersion({ nodeVersion: '24.1.0' }).status).toBe('pass');
    expect(checkNodeVersion({ nodeVersion: '25.0.0' }).status).toBe('pass');
  });

  it('fails on Node < 24', () => {
    const r = checkNodeVersion({ nodeVersion: '18.19.0' });
    expect(r.status).toBe('fail');
    expect(r.hint).toMatch(/nvm/);
  });
});

describe('checkClaudeCli', () => {
  it('passes when claude --version exits 0', async () => {
    const r = await checkClaudeCli({
      exec: async () => ({ code: 0, stdout: '2.0.0\n', stderr: '' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('2.0.0');
  });

  it('fails when claude is not on PATH (exec throws)', async () => {
    const r = await checkClaudeCli({
      exec: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(r.status).toBe('fail');
    expect(r.hint).toMatch(/npm i -g @anthropic-ai\/claude-code/);
  });

  it('fails when claude --version exits non-zero', async () => {
    const r = await checkClaudeCli({
      exec: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
    });
    expect(r.status).toBe('fail');
  });
});

describe('checkClaudeAuth', () => {
  it('passes when ~/.claude/.credentials.json exists', () => {
    const r = checkClaudeAuth({
      homeDir: '/home/u',
      fileExists: (p) => p === '/home/u/.claude/.credentials.json',
      fileSize: () => 0,
    });
    expect(r.status).toBe('pass');
  });

  it('passes when ~/.claude.json exists and is non-trivial', () => {
    const r = checkClaudeAuth({
      homeDir: '/home/u',
      fileExists: (p) => p === '/home/u/.claude.json',
      fileSize: () => 500,
    });
    expect(r.status).toBe('pass');
  });

  it('warns when ~/.claude.json exists but is trivially small', () => {
    const r = checkClaudeAuth({
      homeDir: '/home/u',
      fileExists: (p) => p === '/home/u/.claude.json',
      fileSize: () => 2,
    });
    expect(r.status).toBe('warn');
  });

  it('warns when neither credentials file exists', () => {
    const r = checkClaudeAuth({ homeDir: '/home/u', fileExists: () => false, fileSize: () => 0 });
    expect(r.status).toBe('warn');
    expect(r.hint).toMatch(/claude` once and log in/);
  });
});

describe('checkApiKeyEnv', () => {
  it('passes when ANTHROPIC_API_KEY is unset', () => {
    expect(checkApiKeyEnv({ env: {} }).status).toBe('pass');
  });

  it('warns when ANTHROPIC_API_KEY is set', () => {
    const r = checkApiKeyEnv({ env: { ANTHROPIC_API_KEY: 'sk-x' } });
    expect(r.status).toBe('warn');
    expect(r.hint).toMatch(/billingMode/);
  });
});

describe('checkDataDirWritable', () => {
  it('passes when writable', () => {
    expect(checkDataDirWritable({ dataDir: '/home/u/.ant-bot', isDirWritable: () => true }).status).toBe(
      'pass',
    );
  });

  it('fails when not writable', () => {
    const r = checkDataDirWritable({ dataDir: '/home/u/.ant-bot', isDirWritable: () => false });
    expect(r.status).toBe('fail');
    expect(r.hint).toMatch(/permissions/);
  });
});

describe('checkPortAvailability', () => {
  it('passes when the port is free', async () => {
    const r = await checkPortAvailability({
      port: 4780,
      probePort: async () => 'free',
      healthCheck: async () => ({ ok: false }),
    });
    expect(r.status).toBe('pass');
  });

  it('passes when occupied by a running antbot (health responds)', async () => {
    const r = await checkPortAvailability({
      port: 4780,
      probePort: async () => 'occupied',
      healthCheck: async () => ({ ok: true, version: '0.1.0' }),
    });
    expect(r.status).toBe('pass');
    expect(r.message).toContain('running antbot');
  });

  it('fails when occupied by an unrelated process', async () => {
    const r = await checkPortAvailability({
      port: 4780,
      probePort: async () => 'occupied',
      healthCheck: async () => ({ ok: false }),
    });
    expect(r.status).toBe('fail');
  });
});

describe('checkBetterSqlite3', () => {
  it('passes when the module loads', async () => {
    const r = await checkBetterSqlite3({ importBetterSqlite3: async () => ({}) });
    expect(r.status).toBe('pass');
  });

  it('fails when the module throws', async () => {
    const r = await checkBetterSqlite3({
      importBetterSqlite3: async () => {
        throw new Error('bad binding');
      },
    });
    expect(r.status).toBe('fail');
    expect(r.hint).toMatch(/pnpm rebuild better-sqlite3/);
  });
});

describe('checkPlaywrightChromium', () => {
  it('passes when the executable exists on disk', async () => {
    const r = await checkPlaywrightChromium({
      importPlaywright: async () => ({ chromium: { executablePath: () => '/opt/chromium' } }),
      fileExists: (p) => p === '/opt/chromium',
    });
    expect(r.status).toBe('pass');
  });

  it('warns (not fails) when the executable is missing', async () => {
    const r = await checkPlaywrightChromium({
      importPlaywright: async () => ({ chromium: { executablePath: () => '/opt/chromium' } }),
      fileExists: () => false,
    });
    expect(r.status).toBe('warn');
    expect(r.hint).toMatch(/npx playwright install chromium/);
  });

  it('warns (not fails) when playwright fails to import', async () => {
    const r = await checkPlaywrightChromium({
      importPlaywright: async () => {
        throw new Error('module not found');
      },
      fileExists: () => false,
    });
    expect(r.status).toBe('warn');
  });
});

function makeAllPassingDeps(): DoctorDeps {
  return {
    nodeVersion: '24.1.0',
    env: {},
    homeDir: '/home/u',
    dataDir: '/home/u/.ant-bot',
    port: 4780,
    fileExists: (p) => p === '/home/u/.claude/.credentials.json' || p === '/opt/chromium',
    fileSize: () => 1000,
    isDirWritable: () => true,
    exec: async () => ({ code: 0, stdout: '2.0.0', stderr: '' }),
    probePort: async () => 'free',
    healthCheck: async () => ({ ok: false }),
    importBetterSqlite3: async () => ({}),
    importPlaywright: async () => ({ chromium: { executablePath: () => '/opt/chromium' } }),
  };
}

describe('runDoctor', () => {
  it('returns exitCode 0 when nothing fails', async () => {
    const report = await runDoctor(makeAllPassingDeps());
    expect(report.results).toHaveLength(8);
    expect(report.exitCode).toBe(0);
    expect(report.results.every((r) => r.status !== 'fail')).toBe(true);
  });

  it('returns exitCode 1 when any check fails', async () => {
    const deps = makeAllPassingDeps();
    deps.nodeVersion = '18.0.0';
    const report = await runDoctor(deps);
    expect(report.exitCode).toBe(1);
    expect(report.results.some((r) => r.status === 'fail')).toBe(true);
  });

  it('exitCode stays 0 when only warnings occur', async () => {
    const deps = makeAllPassingDeps();
    deps.env = { ANTHROPIC_API_KEY: 'sk-x' };
    const report = await runDoctor(deps);
    expect(report.exitCode).toBe(0);
    expect(report.results.some((r) => r.status === 'warn')).toBe(true);
  });
});
