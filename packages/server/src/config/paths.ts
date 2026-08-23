import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface AntbotPaths {
  root: string;
  db: string;
  config: string;
  workspace: string;
  attachments: string;
  skills: string;
  browserProfile: string;
  backups: string;
  secrets: string;
  logs: string;
}

export function resolvePaths(root?: string): AntbotPaths {
  const base = root ?? process.env.ANTBOT_HOME ?? path.join(os.homedir(), '.ant-bot');
  return {
    root: base,
    db: path.join(base, 'antbot.db'),
    config: path.join(base, 'config.toml'),
    workspace: path.join(base, 'workspace'),
    attachments: path.join(base, 'attachments'),
    skills: path.join(base, 'skills'),
    browserProfile: path.join(base, 'browser-profile'),
    backups: path.join(base, 'backups'),
    secrets: path.join(base, 'secrets.json'),
    logs: path.join(base, 'logs'),
  };
}

export function ensureDirs(p: AntbotPaths): void {
  for (const d of [p.root, p.workspace, p.attachments, p.skills, p.backups, p.logs,
                   path.join(p.workspace, 'projects'), path.join(p.workspace, 'bots')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
