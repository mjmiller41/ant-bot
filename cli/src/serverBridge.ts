// Everything that talks to @antbot/daemon lives here so it can be imported
// lazily and fail gracefully: the server package's exports (in particular
// startServer) may not exist yet in-progress, and native deps like
// better-sqlite3/playwright are @antbot/daemon's dependencies, not @antbot/cli's.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ResolveDeps {
  /** Directory of the calling module. */
  here: string;
  /** Resolves a bare specifier; throws when it is not installed, like require.resolve. */
  resolve: (specifier: string) => string;
  realpath: (p: string) => string;
  exists: (p: string) => boolean;
}

/**
 * Nearest ancestor of `from` holding a package.json. Deliberately a local copy of the server's
 * `util/locate.ts` helper rather than an import: this module exists so that nothing here touches
 * @antbot/daemon eagerly, and locating that package cannot itself depend on loading it.
 */
function packageRootOf(from: string, exists: (p: string) => boolean): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (exists(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where @antbot/daemon's dependencies can be resolved from. Three layouts, in order:
 *
 * 1. A real resolve of the package — correct under npm, pnpm and yarn regardless of how the
 *    installer chose to hoist, which the old hardcoded `cli/node_modules/@antbot/daemon` symlink
 *    was not (npm hoists to the root and never creates it).
 * 2. That symlink anyway, for a pnpm workspace where step 1 can miss.
 * 3. This package itself. In the published single-package build there is no separate
 *    @antbot/daemon: the CLI and the daemon are one package, and better-sqlite3/playwright are
 *    its own dependencies.
 */
export function resolveServerPackageDir(deps: ResolveDeps): string | null {
  try {
    return deps.realpath(path.dirname(deps.resolve('@antbot/daemon/package.json')));
  } catch { /* not a separate package here; try the other layouts */ }

  const pkg = packageRootOf(deps.here, deps.exists);
  if (pkg) {
    const link = path.join(pkg, 'node_modules', '@antbot', 'daemon');
    if (deps.exists(link)) {
      try {
        return deps.realpath(link);
      } catch { /* dangling symlink */ }
    }
    return pkg;
  }
  return null;
}

const require_ = createRequire(import.meta.url);

function findServerPackageDir(): string | null {
  return resolveServerPackageDir({
    here: path.dirname(fileURLToPath(import.meta.url)),
    resolve: (s) => require_.resolve(s),
    realpath: (p) => fs.realpathSync(p),
    exists: (p) => fs.existsSync(p),
  });
}

/**
 * Resolves and imports a module from @antbot/daemon's own dependency tree
 * (e.g. "better-sqlite3", "playwright") so doctor checks reflect what the
 * daemon will actually load, without @antbot/cli declaring those as its own
 * dependencies.
 */
export async function importServerDependency(specifier: string): Promise<unknown> {
  const serverDir = findServerPackageDir();
  if (!serverDir) {
    throw new Error(`could not locate the @antbot/daemon package to resolve "${specifier}"`);
  }
  const req = createRequire(path.join(serverDir, 'package.json'));
  const resolved = req.resolve(specifier);
  return import(pathToFileURL(resolved).href);
}

export interface StartServerOptions {
  port: number;
  host: string;
}

export interface ServerInstance {
  close?: () => Promise<void> | void;
}

/**
 * Lazily imports @antbot/daemon and calls its startServer() export, if present.
 *
 * NOTE: the specifier is held in a variable (not a string literal) on purpose.
 * @antbot/daemon does not export startServer() yet (it's being built
 * concurrently, and its package.json "exports" main entry may not resolve to
 * a build artifact at all times), so a literal `import('@antbot/daemon')`
 * would make this file's typecheck depend on that package's build state.
 * Routing through a variable makes TS treat the result as `Promise<any>`.
 */
/**
 * Where a server module can be imported from, most portable first.
 *
 * The published build has no separate @antbot/daemon — the CLI and the daemon are bundled into
 * one package, side by side under `dist/`. `bareSpecifier` is what resolves in a checkout or a
 * multi-package install; `bundledFile` is the sibling that resolves in the published one.
 */
export function serverModuleCandidates(
  bareSpecifier: string,
  bundledFile: string,
  deps: Pick<ResolveDeps, 'here' | 'exists'>,
): string[] {
  const out = [bareSpecifier];
  const pkg = packageRootOf(deps.here, deps.exists);
  if (pkg) {
    const sibling = path.join(pkg, 'dist', bundledFile);
    if (deps.exists(sibling)) out.push(pathToFileURL(sibling).href);
  }
  return out;
}

function candidates(bare: string, bundled: string): string[] {
  return serverModuleCandidates(bare, bundled, {
    here: path.dirname(fileURLToPath(import.meta.url)),
    exists: (p) => fs.existsSync(p),
  });
}

/** Tries each candidate in turn, reporting the first real failure rather than the last miss. */
async function importFirst(specs: string[], what: string): Promise<unknown> {
  let firstError: unknown;
  for (const spec of specs) {
    try {
      return await import(spec);
    } catch (err) {
      firstError ??= err;
    }
  }
  throw new Error(`could not load ${what}: ${(firstError as Error)?.message ?? 'not found'}`);
}

/**
 * Lazily imports the daemon and calls its startServer() export, if present.
 *
 * NOTE: the specifiers are held in variables (not string literals) on purpose.
 * @antbot/daemon's package.json "exports" main entry may not resolve to a build artifact at all
 * times, so a literal `import('@antbot/daemon')` would make this file's typecheck depend on that
 * package's build state. Routing through a variable makes TS treat the result as `Promise<any>`.
 */
export async function startAntbotServer(opts: StartServerOptions): Promise<ServerInstance> {
  const mod = (await importFirst(candidates('@antbot/daemon', 'server.js'), 'the ant-bot daemon')) as {
    startServer?: (opts: StartServerOptions) => Promise<ServerInstance> | ServerInstance;
  };
  if (typeof mod.startServer !== 'function') {
    throw new Error('@antbot/daemon does not export startServer() yet.');
  }
  return mod.startServer(opts);
}

export interface SpecViolation {
  code: string;
  level: 'error' | 'warning';
  field?: string;
  message: string;
}

export interface SkillSpecModule {
  validateSkillDir: (dir: string) => SpecViolation[];
  validateSkillsIn: (root: string) => { slug: string; violations: SpecViolation[] }[];
}

/**
 * Lazily imports the spec validator. Held in a variable for the same reason as
 * startAntbotServer above, and kept a *separate* entry point from the daemon on purpose:
 * `antbot skill lint` runs with no daemon, and must not drag better-sqlite3, fastify and
 * playwright into the process just to parse frontmatter.
 */
export async function importSkillSpec(): Promise<SkillSpecModule> {
  return (await importFirst(
    candidates('@antbot/daemon/skills/spec.js', 'skills-spec.js'),
    'the skill spec validator',
  )) as SkillSpecModule;
}
