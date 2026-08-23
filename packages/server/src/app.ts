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
 * Import a subsystem that may not be built yet. The specifier is assembled at
 * runtime so the compiler does not require the module to exist.
 */
async function optionalImport(spec: string): Promise<any | null> {
  try {
    return await import(/* @vite-ignore */ `${spec}`);
  } catch {
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
  const db = openDb(cfg.paths.db);
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
    const mod = await optionalImport('./skills/skills.js');
    const pluginMod = await optionalImport('./skills/plugin.js');
    const Ctor = mod?.SkillStore ?? mod?.default;
    if (!Ctor) return;

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
    if (mod?.seedExamples) {
      try { mod.seedExamples(filesDir); } catch (e) { log.warn('skill examples not seeded', (e as Error).message); }
    }
    // Skills committed to the ant-bot project itself are installed on every boot, so a
    // skill can be version-controlled alongside the code that uses it.
    if (mod?.syncProjectSkills) {
      try {
        const added: string[] = mod.syncProjectSkills(filesDir);
        if (added.length) log.info(`installed ${added.length} project skill(s): ${added.join(', ')}`);
      } catch (e) {
        log.warn('project skills not synced', (e as Error).message);
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
    const mod = await optionalImport('./computer/browser.js');
    const Ctor = mod?.BrowserService ?? mod?.default;
    if (!Ctor) return;
    const svc = new Ctor({ profileDir: app.cfg.paths.browserProfile, bus: app.bus, headless: true });
    let toolsMod: any = null;
    toolsMod = await optionalImport('./computer/tools.js');
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
    const mod = await optionalImport('./scheduler/scheduler.js');
    const Ctor = mod?.Scheduler ?? mod?.default;
    if (!Ctor) return;
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
