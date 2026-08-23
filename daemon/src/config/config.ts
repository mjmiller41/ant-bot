import fs from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { SettingsSchema, type Settings } from '@antbot/contract';
import { resolvePaths, ensureDirs, type AntbotPaths } from './paths.js';

export interface AntbotConfig {
  paths: AntbotPaths;
  settings: Settings;
  port: number;
  host: string;
}

export const DEFAULT_PORT = 4780;
export const DEFAULT_HOST = '127.0.0.1';

export function loadConfig(root?: string): AntbotConfig {
  const paths = resolvePaths(root);
  ensureDirs(paths);

  let raw: Record<string, unknown> = {};
  if (fs.existsSync(paths.config)) {
    try {
      raw = parseToml(fs.readFileSync(paths.config, 'utf8')) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }
  const server = (raw.server ?? {}) as Record<string, unknown>;
  const settings = SettingsSchema.parse({
    ...(typeof raw.settings === 'object' && raw.settings ? raw.settings : {}),
    timezone:
      (raw.settings as Record<string, unknown> | undefined)?.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      'UTC',
  });

  const cfg: AntbotConfig = {
    paths,
    settings,
    port: Number(process.env.ANTBOT_PORT ?? server.port ?? DEFAULT_PORT),
    host: String(server.host ?? DEFAULT_HOST),
  };
  if (!fs.existsSync(paths.config)) writeConfig(cfg);
  return cfg;
}

export function writeConfig(cfg: AntbotConfig): void {
  fs.writeFileSync(
    cfg.paths.config,
    stringifyToml({ server: { port: cfg.port, host: cfg.host }, settings: cfg.settings as unknown as Record<string, unknown> }),
  );
}
