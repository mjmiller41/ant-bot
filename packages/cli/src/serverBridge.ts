// Everything that talks to @antbot/server lives here so it can be imported
// lazily and fail gracefully: the server package's exports (in particular
// startServer) may not exist yet in-progress, and native deps like
// better-sqlite3/playwright are @antbot/server's dependencies, not @antbot/cli's.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolves the real (symlink-followed) directory of the @antbot/server package on disk. */
function findServerPackageDir(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // .../packages/cli/dist
    const cliRoot = path.dirname(here); // .../packages/cli
    const link = path.join(cliRoot, 'node_modules', '@antbot', 'server');
    return fs.realpathSync(link);
  } catch {
    return null;
  }
}

/**
 * Resolves and imports a module from @antbot/server's own dependency tree
 * (e.g. "better-sqlite3", "playwright") so doctor checks reflect what the
 * daemon will actually load, without @antbot/cli declaring those as its own
 * dependencies.
 */
export async function importServerDependency(specifier: string): Promise<unknown> {
  const serverDir = findServerPackageDir();
  if (!serverDir) {
    throw new Error(`could not locate the @antbot/server package to resolve "${specifier}"`);
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
 * Lazily imports @antbot/server and calls its startServer() export, if present.
 *
 * NOTE: the specifier is held in a variable (not a string literal) on purpose.
 * @antbot/server does not export startServer() yet (it's being built
 * concurrently, and its package.json "exports" main entry may not resolve to
 * a build artifact at all times), so a literal `import('@antbot/server')`
 * would make this file's typecheck depend on that package's build state.
 * Routing through a variable makes TS treat the result as `Promise<any>`.
 */
export async function startAntbotServer(opts: StartServerOptions): Promise<ServerInstance> {
  const specifier = '@antbot/server';
  const mod = (await import(specifier)) as {
    startServer?: (opts: StartServerOptions) => Promise<ServerInstance> | ServerInstance;
  };
  if (typeof mod.startServer !== 'function') {
    throw new Error('@antbot/server does not export startServer() yet.');
  }
  return mod.startServer(opts);
}
