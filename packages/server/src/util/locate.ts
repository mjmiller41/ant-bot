// Finding the assets ant-bot ships with — the built web UI and the bundled skills directory.
//
// These lookups used to count `..` segments up from `import.meta.url`, which encodes two guesses
// at once: the repo layout, and how deep the compiler happens to put the calling module. Both are
// wrong from an installed package, and both fail *silently* — `findWebDist` returns null and the
// daemon serves no UI, `defaultBundledSkillsDir` points at nothing and no skills sync. Walking up
// to the nearest package.json instead is depth-independent, so bundling or moving a source file
// cannot quietly break them.
import fs from 'node:fs';
import path from 'node:path';

export interface LocateDeps {
  /** Directory of the calling module. */
  here: string;
  cwd: string;
  exists: (p: string) => boolean;
  /** Resolves a bare specifier to an absolute path; returns null when it is not installed. */
  resolve: (specifier: string) => string | null;
}

export function nodeLocateDeps(here: string, resolve: (s: string) => string | null): LocateDeps {
  return { here, cwd: process.cwd(), exists: (p) => fs.existsSync(p), resolve };
}

/**
 * The nearest ancestor of `from` (inclusive) holding a package.json. Returns null at the
 * filesystem root, which callers treat as "fall through to the other candidates".
 */
export function findPackageRoot(from: string, exists: (p: string) => boolean): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (exists(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The version of the package this module was loaded from. In the published build the CLI and the
 * daemon are one package, so `antbot --version` and `GET /api/health` necessarily agree; in a
 * checkout they read their own workspace package.json, which `version.test.ts` pins to the root.
 */
export function readPackageVersion(
  here: string,
  exists: (p: string) => boolean,
  read: (p: string) => string,
): string {
  const root = findPackageRoot(here, exists);
  if (!root) return '0.0.0';
  try {
    return (JSON.parse(read(path.join(root, 'package.json'))) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Candidates for the built web UI, most specific first. `pkg` is `packages/server` in a checkout
 * and the installed package root otherwise, so `pkg/web/dist` covers the shipped layout and
 * `pkg/../web/dist` covers the sibling workspace package — neither depends on compile depth.
 */
export function webDistCandidates(deps: LocateDeps): string[] {
  const out: string[] = [];
  const resolved = deps.resolve('@antbot/web/package.json');
  if (resolved) out.push(path.join(path.dirname(resolved), 'dist'));

  const pkg = findPackageRoot(deps.here, deps.exists);
  if (pkg) {
    out.push(path.join(pkg, 'web', 'dist'));
    out.push(path.resolve(pkg, '..', 'web', 'dist'));
  }
  out.push(path.resolve(deps.cwd, 'packages', 'web', 'dist'));
  return out;
}

/** The built web UI, or null when it has not been built (the daemon then runs API-only). */
export function findWebDist(deps: LocateDeps): string | null {
  return webDistCandidates(deps).find((c) => deps.exists(path.join(c, 'index.html'))) ?? null;
}

/**
 * Candidates for the skills directory ant-bot ships. In a checkout `pkg` is `packages/server`, so
 * the repo root is two levels up; in the installed package the directory sits beside the code.
 */
export function bundledSkillsCandidates(deps: LocateDeps): string[] {
  const out: string[] = [];
  const pkg = findPackageRoot(deps.here, deps.exists);
  if (pkg) {
    out.push(path.join(pkg, 'skills'));
    out.push(path.resolve(pkg, '..', '..', 'skills'));
  }
  out.push(path.resolve(deps.cwd, 'skills'));
  return out;
}

/**
 * The skills directory ant-bot ships with. Unlike `findWebDist` this never returns null: the
 * caller (`syncBundledSkills`) already treats a missing directory as "nothing to sync", and a
 * concrete path makes the failure legible in a log.
 */
export function findBundledSkillsDir(deps: LocateDeps): string {
  const candidates = bundledSkillsCandidates(deps);
  return candidates.find((c) => deps.exists(c)) ?? candidates[0]!;
}
