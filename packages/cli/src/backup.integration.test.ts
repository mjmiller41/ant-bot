import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackup, restoreBackup } from './backup.js';
import { runCommand } from './proc.js';

let tarAvailable = true;

beforeAll(async () => {
  try {
    const res = await runCommand('tar', ['--version']);
    tarAvailable = res.code === 0;
  } catch {
    tarAvailable = false;
  }
});

describe.runIf(process.platform !== 'win32')('createBackup / restoreBackup (real tar)', () => {
  it('creates an archive excluding browser-profile and attachments, and round-trips it', async () => {
    if (!tarAvailable) return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-cli-test-'));
    fs.writeFileSync(path.join(root, 'antbot.db'), 'sqlite-bytes');
    fs.writeFileSync(path.join(root, 'config.toml'), 'port = 4780\n');
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'weekly-report.md'), '# skill');
    fs.mkdirSync(path.join(root, 'workspace', 'bots', 'scout', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspace', 'bots', 'scout', 'memory', 'facts.md'), '- likes tea');
    fs.mkdirSync(path.join(root, 'browser-profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(root, 'browser-profile', 'Default', 'Cookies'), 'secret');
    fs.mkdirSync(path.join(root, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(root, 'attachments', 'photo.png'), 'binary');

    const outPath = path.join(root, 'out', 'backup.tar.gz');
    const result = await createBackup({
      root,
      dbPath: path.join(root, 'antbot.db'),
      configPath: path.join(root, 'config.toml'),
      skillsDir: path.join(root, 'skills'),
      botsDir: path.join(root, 'workspace', 'bots'),
      outPath,
    });

    expect(fs.existsSync(outPath)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    const listing = await runCommand('tar', ['tzf', outPath]);
    expect(listing.stdout).toContain('antbot.db');
    expect(listing.stdout).toContain('config.toml');
    expect(listing.stdout).toContain('skills/weekly-report.md');
    expect(listing.stdout).toContain('workspace/bots/scout/memory/facts.md');
    expect(listing.stdout).not.toContain('browser-profile');
    expect(listing.stdout).not.toContain('attachments');

    const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-cli-restore-'));
    await restoreBackup({ archivePath: outPath, root: restoreRoot });
    expect(fs.existsSync(path.join(restoreRoot, 'antbot.db'))).toBe(true);
    expect(
      fs.existsSync(path.join(restoreRoot, 'workspace', 'bots', 'scout', 'memory', 'facts.md')),
    ).toBe(true);
    expect(fs.existsSync(path.join(restoreRoot, 'browser-profile'))).toBe(false);
  });

  it('throws a clear error when restoring a missing archive', async () => {
    const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antbot-cli-restore-missing-'));
    await expect(
      restoreBackup({ archivePath: path.join(restoreRoot, 'nope.tar.gz'), root: restoreRoot }),
    ).rejects.toThrow(/not found/);
  });
});
