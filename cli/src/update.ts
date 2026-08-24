// Update checking and self-update.
//
// The check is a notification, never an action. The daemon holds a live SQLite handle and may be
// mid-turn spending subscription tokens; replacing its files underneath that is a bad trade for a
// local-first tool. So: `antbot status` and `antbot doctor` mention a newer version, and the user
// runs `antbot update` when it suits them.
//
// Pure core (`compareVersions`, `planUpdateCheck`, `detectPackageManager`, `updateCommand`)
// decides; the I/O wrapper fetches, caches and spawns.
import path from 'node:path';

// Scoped, because npm rejects `ant-bot` as too similar to the pre-existing `antbot` holding
// package. The *binary* is still `antbot`; only the install/update command carries the scope.
export const PACKAGE_NAME = '@michael-joseph-miller/ant-bot';
// encodeURIComponent so the scope separator reaches the registry as %2F.
export const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;

/** Once a day. A local-first tool has no business talking to a registry more often than that. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface UpdateCache {
  latest: string;
  checkedAt: number;
}

/* ------------------------------- pure core ------------------------------- */

interface Parsed {
  parts: number[];
  prerelease: string | null;
}

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? null };
}

/**
 * Compares two semver strings: negative if `a` is older, positive if newer, 0 if equal.
 * Unparseable versions sort as equal, so a garbled registry answer never triggers a prompt.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i]! !== pb.parts[i]!) return pa.parts[i]! - pb.parts[i]!;
  }
  // 1.0.0-beta precedes 1.0.0. Beyond that, comparing prerelease identifiers by string is
  // close enough for "is there something newer" and avoids reimplementing semver.
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/**
 * Whether `latest` is worth telling the user about. A stable install is never nudged onto a
 * prerelease, however the registry's `latest` tag happens to be pointed — that is a choice the
 * user makes deliberately with `npm i -g @michael-joseph-miller/ant-bot@next`.
 */
export function isUpgrade(current: string, latest: string): boolean {
  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return false;
  if (l.prerelease !== null && c.prerelease === null) return false;
  return compareVersions(latest, current) > 0;
}

/** Whether the cached answer is still good, so a check costs no network at all. */
export function planUpdateCheck(
  cache: UpdateCache | null,
  now: number,
  ttlMs = UPDATE_CHECK_TTL_MS,
): 'use-cache' | 'fetch' {
  if (!cache || typeof cache.checkedAt !== 'number' || typeof cache.latest !== 'string') return 'fetch';
  // A clock that moved backwards (timezone fix, VM restore) would otherwise pin the cache
  // as fresh until the clock caught up.
  if (cache.checkedAt > now) return 'fetch';
  return now - cache.checkedAt < ttlMs ? 'use-cache' : 'fetch';
}

/**
 * Which package manager installed this copy, inferred from where it lives. Each keeps its global
 * root in a recognisable place, and re-running the *wrong* one either fails or installs a second
 * copy that shadows the first.
 */
export function detectPackageManager(installPath: string): PackageManager {
  const p = installPath.split(path.sep).join('/');
  if (/\/\.bun\//.test(p)) return 'bun';
  // pnpm's global store, and its content-addressed layout wherever it lives.
  if (/\/\.pnpm\//.test(p) || /\/pnpm\/(global|store)\//.test(p) || /\/Library\/pnpm\//.test(p)) return 'pnpm';
  if (/\/\.yarn\//.test(p) || /\/yarn\/global\//.test(p) || /\/\.config\/yarn\//.test(p)) return 'yarn';
  return 'npm';
}

/** The command that upgrades a global install for each package manager. */
export function updateCommand(pm: PackageManager, pkg = PACKAGE_NAME): { cmd: string; args: string[] } {
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-g', `${pkg}@latest`] };
    case 'yarn':
      return { cmd: 'yarn', args: ['global', 'add', `${pkg}@latest`] };
    case 'bun':
      return { cmd: 'bun', args: ['add', '-g', `${pkg}@latest`] };
    case 'npm':
    default:
      return { cmd: 'npm', args: ['install', '-g', `${pkg}@latest`] };
  }
}

/**
 * A checkout is not upgradable by a package manager. Recognising it is what keeps
 * `antbot update` from running `npm i -g` over someone's working tree.
 *
 * Two signals, both required, because each alone is wrong somewhere: a path outside
 * `node_modules` also describes an unpacked tarball, and a `.git` directory also sits above a
 * global install when someone's home directory is a dotfiles repo. Requiring both errs toward
 * "installed" — the cost of that mistake is a redundant global install, where the opposite
 * mistake tells a real user their working install cannot be updated.
 */
export function isCheckoutInstall(installPath: string, exists: (p: string) => boolean): boolean {
  if (installPath.split(path.sep).includes('node_modules')) return false;
  let dir = path.resolve(installPath);
  for (;;) {
    if (exists(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** One line for `antbot status` / `antbot doctor`, or null when there is nothing to say. */
export function updateNotice(current: string, latest: string | null): string | null {
  if (!latest || !isUpgrade(current, latest)) return null;
  return `A newer ant-bot is available: ${current} → ${latest}. Run \`antbot update\`.`;
}

/* ------------------------------- I/O wrapper ------------------------------- */

export interface UpdateCheckDeps {
  currentVersion: string;
  now: number;
  readCache: () => string | null;
  writeCache: (contents: string) => void;
  fetchLatest: () => Promise<string | null>;
  ttlMs?: number;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  isUpgrade: boolean;
  /** True when the answer came from cache and no request was made. */
  cached: boolean;
  notice: string | null;
}

/**
 * Never throws and never blocks a command from succeeding: an offline machine, a proxy, or a
 * registry outage must not make `antbot status` fail.
 */
export async function checkForUpdate(deps: UpdateCheckDeps): Promise<UpdateStatus> {
  let cache: UpdateCache | null = null;
  try {
    const raw = deps.readCache();
    if (raw) cache = JSON.parse(raw) as UpdateCache;
  } catch {
    /* an unreadable or corrupt cache is the same as no cache */
  }

  let latest: string | null;
  let cached = false;
  if (planUpdateCheck(cache, deps.now, deps.ttlMs) === 'use-cache') {
    latest = cache!.latest;
    cached = true;
  } else {
    try {
      latest = await deps.fetchLatest();
      if (latest) {
        deps.writeCache(`${JSON.stringify({ latest, checkedAt: deps.now } satisfies UpdateCache)}\n`);
      }
    } catch {
      // Fall back to whatever was cached, however stale — a stale answer beats none.
      latest = cache?.latest ?? null;
      cached = latest !== null;
    }
  }

  return {
    current: deps.currentVersion,
    latest,
    isUpgrade: latest !== null && isUpgrade(deps.currentVersion, latest),
    cached,
    notice: updateNotice(deps.currentVersion, latest),
  };
}

/** Fetches the registry's `latest` dist-tag, with a short timeout. */
export async function fetchLatestVersion(timeoutMs = 3000): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // No `application/vnd.npm.install-v1+json` accept header. That abbreviated-metadata type is
    // only served for the full packument; asking for it on `/latest` gets a 406, which this code
    // then reported as "could not reach the npm registry". The document is one version's
    // metadata either way, so there is nothing to abbreviate.
    const res = await fetch(REGISTRY_URL, { signal: ac.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
