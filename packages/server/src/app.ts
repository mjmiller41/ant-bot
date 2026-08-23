import fs from 'node:fs';
import path from 'node:path';
import { openDb, type DB } from './db/db.js';
import { Store } from './db/store.js';
import { EventBus } from './util/bus.js';
import { PermissionGateway } from './permissions/gateway.js';
import { seedBuiltinRules } from './permissions/rules.js';
import { makeAutoReviewer, NullAutoReviewer } from './permissions/autoreview.js';
import { BotManager } from './bots/manager.js';
import { loadConfig, type AntbotConfig } from './config/config.js';
import { logger } from './util/log.js';
import type { Settings } from '@antbot/shared';
import { SecretsService, pickBackend } from './permissions/secrets.js';

const log = logger('app');

/**
 * Load a subsystem that may not work on this machine — no Playwright installed, no fts5 — so the
 * daemon still boots without it.
 *
 * `load` must be a thunk around a *literal* dynamic import. This used to take a specifier string
 * and assemble it at runtime (`import(\`${spec}\`)`) so the compiler would not require the module
 * to exist; every one of them exists now, and the runtime-assembled form is invisible to a
 * bundler — the published build resolved them relative to the bundle, found nothing, and booted
 * with skills, browser and scheduler all silently missing.
 */
async function optionalImport(name: string, load: () => Promise<unknown>): Promise<any | null> {
  try {
    return await load();
  } catch (err) {
    log.warn(`${name} module could not be loaded`, (err as Error).message);
    return null;
  }
}

export interface App {
  cfg: AntbotConfig;
  db: DB;
  store: Store;
  bus: EventBus;
  gateway: PermissionGateway;
  manager: BotManager;
  getSettings: () => Settings;
  /** Optional subsystems, wired if their modules are present. */
  scheduler?: any;
  browser?: any;
  skills?: any;
  secrets?: SecretsService;
  lastUserActivity: { at: number };
  /** Root of the local plugin carrying installed skills. */
  skillPluginPath?: string;
  shutdown: () => Promise<void>;
}

export async function createApp(opts: { root?: string; withAgent?: boolean } = {}): Promise<App> {
  const cfg = loadConfig(opts.root);
  const db = openDb(cfg.paths.db, { backupsDir: cfg.paths.backups });
  const store = new Store(db);

  // config.toml holds first-run defaults; the DB is authoritative afterwards.
  const persisted = store.getSettings();
  const settingsCount = store.db.prepare(`SELECT COUNT(*) c FROM settings`).get() as { c: number };
  if (!settingsCount.c) {
    store.patchSettings(cfg.settings);
  }
  const getSettings = (): Settings => store.getSettings();
  void persisted;

  seedBuiltinRules(store);

  const bus = new EventBus();
  const reviewer = opts.withAgent === false
    ? new NullAutoReviewer()
    : makeAutoReviewer(getSettings, cfg.paths.workspace);
  const gateway = new PermissionGateway(store, bus, reviewer);

  const app: App = {
    cfg, db, store, bus, gateway, getSettings,
    manager: undefined as unknown as BotManager,
    lastUserActivity: { at: Date.now() },
    shutdown: async () => {},
  };

  app.manager = new BotManager({
    store, bus, gateway,
    workspace: cfg.paths.workspace,
    getSettings,
    skillPluginPath: () => app.skillPluginPath,
    installSkill: async (source: string, opts?: { allowMultiple?: boolean }) => {
      if (!app.skills?.installFromSource) throw new Error('Skill installation is unavailable.');
      const installed = await app.skills.installFromSource(source, opts ?? {});
      return installed.map((i: { skill: { name: string }; executables: string[] }) => ({
        name: i.skill.name,
        executables: i.executables,
      }));
    },
    listSkills: () =>
      store.listSkills().map((sk) => ({ slug: sk.slug, name: sk.name, description: sk.description })),
    // Routed through SkillStore so the directory and the registration go together — a bot
    // deleting directories with Bash is what leaves the registry pointing at nothing.
    removeSkill: async (slug: string) => {
      if (!app.skills?.deleteSkill) throw new Error('Skill removal is unavailable.');
      const skill = store.getSkillBySlug(slug);
      if (!skill) return { removed: false };
      app.skills.deleteSkill(skill.id);
      return { removed: true, name: skill.name };
    },
    browserTools: (botId: string) => {
      if (!app.browser?.toolServerFor) return undefined;
      try {
        return app.browser.toolServerFor(botId);
      } catch {
        return undefined;
      }
    },
  });

  // --- secrets (keychain-backed; values never reach the model) ---
  try {
    app.secrets = new SecretsService(
      await pickBackend(cfg.paths.secrets),
      `${cfg.paths.secrets}.index`,
    );
    log.info(`secrets backend: ${app.secrets.backendName}`);
  } catch (err) {
    log.warn('secrets backend unavailable', (err as Error).message);
  }

  // --- optional subsystems (built concurrently; wired only if present) ---
  await wireSkills(app);
  await wireBrowser(app);
  await wireScheduler(app);

  app.shutdown = async () => {
    try { app.scheduler?.stop?.(); } catch { /* ignore */ }
    try { await app.browser?.shutdown?.(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
  };

  return app;
}

async function wireSkills(app: App): Promise<void> {
  try {
    const mod = await optionalImport('skills', () => import('./skills/skills.js'));
    const pluginMod = await optionalImport('skill plugin', () => import('./skills/plugin.js'));
    const Ctor = mod?.SkillStore ?? mod?.default;
    if (!Ctor) return void log.warn('skills subsystem unavailable: no SkillStore export');

    // The skills directory doubles as a local plugin root so the SDK can load skills
    // natively; individual skills live one level down, under `skills/`.
    const pluginRoot = app.cfg.paths.skills;
    if (pluginMod?.ensureSkillPlugin) {
      pluginMod.ensureSkillPlugin(pluginRoot);
      const moved: string[] = pluginMod.migrateLegacyLayout?.(pluginRoot) ?? [];
      if (moved.length) log.info(`migrated ${moved.length} skill(s) into the plugin layout: ${moved.join(', ')}`);
      app.skillPluginPath = pluginRoot;
    }
    const filesDir: string = pluginMod?.skillFilesDir?.(pluginRoot) ?? pluginRoot;

    app.skills = new Ctor(app.store, filesDir);

    // Skills shipped with ant-bot are installed on every boot and refreshed in place, but
    // only while the user has not edited or deleted their copy — see skills/bundled.ts.
    const bundledMod = await optionalImport('bundled skills', () => import('./skills/bundled.js'));
    if (bundledMod?.syncBundledSkills) {
      try {
        const decisions: { slug: string; action: string }[] = bundledMod.syncBundledSkills(filesDir);
        const took = (action: string): string[] =>
          decisions.filter((d) => d.action === action).map((d) => d.slug);
        const installed = took('install');
        const updated = took('update');
        const kept = [...took('skip-modified'), ...took('skip-foreign')];
        if (installed.length) log.info(`installed ${installed.length} bundled skill(s): ${installed.join(', ')}`);
        if (updated.length) log.info(`updated ${updated.length} bundled skill(s): ${updated.join(', ')}`);
        if (kept.length) log.info(`left ${kept.length} locally-modified skill(s) alone: ${kept.join(', ')}`);

        // syncFromDisk only registers slugs the db has never seen, so a skill whose shipped
        // frontmatter `name` changed would keep its old registered name — and the SDK is handed
        // registered names as `enabledSkills`, so it would silently stop resolving for every bot
        // that had it enabled.
        const written = [...installed, ...updated, ...took('adopt')];
        const renamed: string[] = app.skills?.refreshFromDisk?.(written) ?? [];
        if (renamed.length) log.info(`refreshed metadata for ${renamed.length} skill(s): ${renamed.join(', ')}`);
      } catch (e) {
        log.warn('bundled skills not synced', (e as Error).message);
      }
    }
    app.skills.syncFromDisk?.();
    // Registry and disk drift apart when skills are removed by hand or a layout migration
    // moves files; left alone, the UI lists skills that cannot load.
    const fixed = app.skills.reconcile?.() as { repaired: string[]; removed: string[] } | undefined;
    if (fixed?.repaired.length) log.info(`repaired ${fixed.repaired.length} skill path(s): ${fixed.repaired.join(', ')}`);
    if (fixed?.removed.length) log.info(`dropped ${fixed.removed.length} skill row(s) with no files on disk`);
    log.info(`skills ready (${app.store.listSkills().length} registered)`);
  } catch (err) {
    log.warn('skills subsystem unavailable', (err as Error).message);
  }
}

async function wireBrowser(app: App): Promise<void> {
  try {
    const mod = await optionalImport('browser', () => import('./computer/browser.js'));
    const Ctor = mod?.BrowserService ?? mod?.default;
    if (!Ctor) return void log.warn('browser subsystem unavailable: no BrowserService export');
    const svc = new Ctor({ profileDir: app.cfg.paths.browserProfile, bus: app.bus, headless: true });
    let toolsMod: any = null;
    toolsMod = await optionalImport('browser tools', () => import('./computer/tools.js'));
    // Each bot drives its own page ("screen") on the one shared browser profile.
    const cache = new Map<string, unknown>();
    svc.toolServerFor = (botId: string) => {
      if (!toolsMod?.createBrowserToolServer) return undefined;
      let s = cache.get(botId);
      if (!s) {
        s = toolsMod.createBrowserToolServer(svc, botId, app.cfg.paths.workspace);
        cache.set(botId, s);
      }
      return s;
    };
    app.browser = svc;
    log.info('browser computer service ready');
  } catch (err) {
    log.warn('browser subsystem unavailable', (err as Error).message);
  }
}

async function wireScheduler(app: App): Promise<void> {
  try {
    const mod = await optionalImport('scheduler', () => import('./scheduler/scheduler.js'));
    const Ctor = mod?.Scheduler ?? mod?.default;
    if (!Ctor) return void log.warn('scheduler subsystem unavailable: no Scheduler export');
    app.scheduler = new Ctor({
      store: app.store, bus: app.bus, manager: app.manager, getSettings: app.getSettings,
    });
    app.scheduler.start?.();
    log.info(`scheduler started (${app.store.listRoutines().filter((r) => r.enabled).length} active routines)`);
  } catch (err) {
    log.warn('scheduler subsystem unavailable', (err as Error).message);
  }
}

/** Deliver queued bot-to-bot mail on boot so handoffs survive a restart. */
export function drainMailbox(app: App): number {
  let n = 0;
  for (const bot of app.store.listBots()) {
    for (const m of app.store.listMail(bot.id)) {
      const from = app.store.getBot(m.fromBotId);
      app.manager.enqueue({
        botId: bot.id, threadId: bot.threadId!, origin: 'bot', hops: m.hops,
        prompt: `**Handoff from @${from?.slug ?? 'unknown'}:**\n\n${m.contentMd}`,
      });
      app.store.markDelivered(m.id);
      n++;
    }
  }
  return n;
}

export function workspaceRelative(root: string, p: string): string | null {
  const resolved = path.resolve(root, p);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

export function ensureWorkspaceFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
