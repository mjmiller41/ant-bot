import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { computeBackupItems, isExcludedPath, BACKUP_EXCLUDED_DIRS, type BackupSource } from './backup.js';

const source: BackupSource = {
  dbPath: '/home/u/.ant-bot/antbot.db',
  configPath: '/home/u/.ant-bot/config.toml',
  skillsDir: '/home/u/.ant-bot/skills',
  botsDir: '/home/u/.ant-bot/workspace/bots',
  botSlugs: ['scout', 'writer'],
};

describe('computeBackupItems', () => {
  it('always includes the db, config, and skills dir', () => {
    const items = computeBackupItems(source);
    expect(items).toContainEqual({ source: source.dbPath, archivePath: 'antbot.db' });
    expect(items).toContainEqual({ source: source.configPath, archivePath: 'config.toml' });
    expect(items).toContainEqual({ source: source.skillsDir, archivePath: 'skills' });
  });

  it('includes only the memory dir for each bot slug', () => {
    const items = computeBackupItems(source);
    expect(items).toContainEqual({
      source: path.join(source.botsDir, 'scout', 'memory'),
      archivePath: 'workspace/bots/scout/memory',
    });
    expect(items).toContainEqual({
      source: path.join(source.botsDir, 'writer', 'memory'),
      archivePath: 'workspace/bots/writer/memory',
    });
  });

  it('produces exactly 3 + N items for N bot slugs', () => {
    expect(computeBackupItems(source)).toHaveLength(3 + source.botSlugs.length);
    expect(computeBackupItems({ ...source, botSlugs: [] })).toHaveLength(3);
  });

  it('never includes a browser-profile or attachments entry', () => {
    const items = computeBackupItems(source);
    for (const item of items) {
      expect(isExcludedPath(item.archivePath)).toBe(false);
    }
  });
});

describe('isExcludedPath', () => {
  it('excludes browser-profile paths', () => {
    expect(isExcludedPath('browser-profile')).toBe(true);
    expect(isExcludedPath('browser-profile/Default/Cookies')).toBe(true);
  });

  it('excludes attachments paths', () => {
    expect(isExcludedPath('attachments')).toBe(true);
    expect(isExcludedPath('attachments/2024/01/file.png')).toBe(true);
  });

  it('does not exclude normal backup content', () => {
    expect(isExcludedPath('antbot.db')).toBe(false);
    expect(isExcludedPath('config.toml')).toBe(false);
    expect(isExcludedPath('skills')).toBe(false);
    expect(isExcludedPath('workspace/bots/scout/memory/notes.md')).toBe(false);
  });

  it('lists exactly the two excluded top-level dirs', () => {
    expect(BACKUP_EXCLUDED_DIRS.sort()).toEqual(['attachments', 'browser-profile'].sort());
  });
});
