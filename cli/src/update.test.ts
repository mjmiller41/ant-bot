import { describe, it, expect } from 'vitest';
import {
  compareVersions,
  isUpgrade,
  planUpdateCheck,
  detectPackageManager,
  updateCommand,
  isCheckoutInstall,
  updateNotice,
  PACKAGE_NAME,
  REGISTRY_URL,
  checkForUpdate,
  UPDATE_CHECK_TTL_MS,
  type UpdateCache,
} from './update.js';

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('tolerates a leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('places a prerelease before its release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBeGreaterThan(0);
  });

  // A garbled registry answer must not read as "newer" and prompt an update.
  it('treats an unparseable version as equal', () => {
    expect(compareVersions('not-a-version', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '')).toBe(0);
  });
});

describe('isUpgrade', () => {
  it('is true only for a strictly newer version', () => {
    expect(isUpgrade('0.1.0', '0.2.0')).toBe(true);
    expect(isUpgrade('0.2.0', '0.2.0')).toBe(false);
    expect(isUpgrade('0.3.0', '0.2.0')).toBe(false);
  });

  // npm's `latest` tag can point at a prerelease; a stable install should not be nudged onto one.
  it('never offers a stable install a prerelease', () => {
    expect(isUpgrade('1.0.0', '1.1.0-beta.1')).toBe(false);
  });

  it('does offer a prerelease install a newer prerelease', () => {
    expect(isUpgrade('1.1.0-beta.1', '1.1.0-beta.2')).toBe(true);
  });

  it('offers a prerelease install the matching stable release', () => {
    expect(isUpgrade('1.1.0-beta.2', '1.1.0')).toBe(true);
  });

  // The name ant-bot did not get: npm's holding package publishes 0.0.1-security.
  it('is not fooled by a security holding package version', () => {
    expect(isUpgrade('0.1.0', '0.0.1-security')).toBe(false);
  });
});

describe('planUpdateCheck', () => {
  const now = 1_700_000_000_000;
  const cache = (over: Partial<UpdateCache> = {}): UpdateCache => ({ latest: '1.0.0', checkedAt: now, ...over });

  it('fetches when there is no cache', () => {
    expect(planUpdateCheck(null, now)).toBe('fetch');
  });

  it('uses a cache written within the day', () => {
    expect(planUpdateCheck(cache({ checkedAt: now - 1000 }), now)).toBe('use-cache');
  });

  it('fetches once the cache is a day old', () => {
    expect(planUpdateCheck(cache({ checkedAt: now - UPDATE_CHECK_TTL_MS }), now)).toBe('fetch');
  });

  // A clock that jumped backwards would otherwise pin the cache as fresh until it caught up.
  it('fetches when the cache is stamped in the future', () => {
    expect(planUpdateCheck(cache({ checkedAt: now + 60_000 }), now)).toBe('fetch');
  });

  it('fetches when the cache is malformed', () => {
    expect(planUpdateCheck({ latest: '1.0.0' } as UpdateCache, now)).toBe('fetch');
    expect(planUpdateCheck({ checkedAt: now } as UpdateCache, now)).toBe('fetch');
  });
});

describe('detectPackageManager', () => {
  it.each([
    ['/home/u/.local/share/pnpm/global/5/node_modules/ant-bot', 'pnpm'],
    ['/home/u/Library/pnpm/global/5/node_modules/ant-bot', 'pnpm'],
    ['/home/u/node_modules/.pnpm/ant-bot@1.0.0/node_modules/ant-bot', 'pnpm'],
    ['/home/u/.bun/install/global/node_modules/ant-bot', 'bun'],
    ['/home/u/.yarn/global/node_modules/ant-bot', 'yarn'],
    ['/home/u/.config/yarn/global/node_modules/ant-bot', 'yarn'],
    ['/usr/lib/node_modules/ant-bot/dist', 'npm'],
    ['/home/u/.nvm/versions/node/v24.0.0/lib/node_modules/ant-bot/dist', 'npm'],
  ])('reads %s as %s', (p, expected) => {
    expect(detectPackageManager(p)).toBe(expected);
  });
});

describe('updateCommand', () => {
  const pkg = `${PACKAGE_NAME}@latest`;

  it('uses each package manager\'s own global-install form', () => {
    expect(updateCommand('npm')).toEqual({ cmd: 'npm', args: ['install', '-g', pkg] });
    expect(updateCommand('pnpm')).toEqual({ cmd: 'pnpm', args: ['add', '-g', pkg] });
    expect(updateCommand('yarn')).toEqual({ cmd: 'yarn', args: ['global', 'add', pkg] });
    expect(updateCommand('bun')).toEqual({ cmd: 'bun', args: ['add', '-g', pkg] });
  });

  // The scope is load-bearing: unscoped `ant-bot` is refused by npm's similarity guard, so an
  // update command that lost it would install nothing (or, worse, something else).
  it('keeps the scope on the package it installs', () => {
    expect(PACKAGE_NAME).toBe('@michael-joseph-miller/ant-bot');
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
      expect(updateCommand(pm).args.at(-1)).toBe('@michael-joseph-miller/ant-bot@latest');
    }
  });

  it('encodes the scope separator in the registry URL', () => {
    expect(REGISTRY_URL).toBe('https://registry.npmjs.org/%40michael-joseph-miller%2Fant-bot/latest');
  });
});

describe('isCheckoutInstall', () => {
  const has = (...paths: string[]) => {
    const set = new Set(paths);
    return (p: string) => set.has(p);
  };

  // The guard that keeps `antbot update` from running `npm i -g` over a working tree.
  it('recognises a checkout: outside node_modules, with a .git above it', () => {
    expect(isCheckoutInstall('/home/u/Code/ant-bot/cli/dist', has('/home/u/Code/ant-bot/.git')))
      .toBe(true);
  });

  it('is not fooled by a global install whose home directory is a dotfiles repo', () => {
    expect(isCheckoutInstall('/home/u/.local/lib/node_modules/ant-bot/dist', has('/home/u/.git')))
      .toBe(false);
  });

  it('treats an unpacked tarball with no .git as an install', () => {
    expect(isCheckoutInstall('/opt/ant-bot/dist', has())).toBe(false);
  });

  it('does not walk past the filesystem root looking for .git', () => {
    expect(isCheckoutInstall('/opt/ant-bot/dist', () => false)).toBe(false);
  });

  it('short-circuits on node_modules without touching the filesystem', () => {
    let probed = false;
    isCheckoutInstall('/usr/lib/node_modules/ant-bot/dist', () => { probed = true; return true; });
    expect(probed).toBe(false);
  });
});

describe('updateNotice', () => {
  it('names both versions and the command', () => {
    expect(updateNotice('0.1.0', '0.2.0')).toBe(
      'A newer ant-bot is available: 0.1.0 → 0.2.0. Run `antbot update`.',
    );
  });

  it('says nothing when current or unknown', () => {
    expect(updateNotice('0.2.0', '0.2.0')).toBeNull();
    expect(updateNotice('0.2.0', null)).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const now = 1_700_000_000_000;
  function deps(over: Partial<Parameters<typeof checkForUpdate>[0]> = {}) {
    return {
      currentVersion: '0.1.0',
      now,
      readCache: () => null,
      writeCache: () => {},
      fetchLatest: async () => '0.2.0',
      ...over,
    };
  }

  it('fetches and reports an upgrade', async () => {
    const r = await checkForUpdate(deps());
    expect(r).toMatchObject({ latest: '0.2.0', isUpgrade: true, cached: false });
    expect(r.notice).toContain('0.1.0 → 0.2.0');
  });

  it('writes the fetched answer to the cache', async () => {
    let written = '';
    await checkForUpdate(deps({ writeCache: (c) => { written = c; } }));
    expect(JSON.parse(written)).toEqual({ latest: '0.2.0', checkedAt: now });
  });

  it('serves a fresh cache without fetching', async () => {
    let fetched = false;
    const r = await checkForUpdate(
      deps({
        readCache: () => JSON.stringify({ latest: '0.3.0', checkedAt: now - 1000 }),
        fetchLatest: async () => { fetched = true; return '0.9.0'; },
      }),
    );
    expect(fetched).toBe(false);
    expect(r).toMatchObject({ latest: '0.3.0', cached: true });
  });

  // An offline machine must not make `antbot status` fail.
  it('falls back to a stale cache when the fetch throws', async () => {
    const r = await checkForUpdate(
      deps({
        readCache: () => JSON.stringify({ latest: '0.3.0', checkedAt: now - 10 * UPDATE_CHECK_TTL_MS }),
        fetchLatest: async () => { throw new Error('ENOTFOUND'); },
      }),
    );
    expect(r).toMatchObject({ latest: '0.3.0', isUpgrade: true, cached: true });
  });

  it('reports nothing rather than throwing when offline with no cache', async () => {
    const r = await checkForUpdate(deps({ fetchLatest: async () => { throw new Error('offline'); } }));
    expect(r).toMatchObject({ latest: null, isUpgrade: false, notice: null });
  });

  it('survives a corrupt cache file', async () => {
    const r = await checkForUpdate(deps({ readCache: () => '{not json' }));
    expect(r).toMatchObject({ latest: '0.2.0', isUpgrade: true });
  });

  it('does not cache a null answer', async () => {
    let wrote = false;
    const r = await checkForUpdate(deps({ fetchLatest: async () => null, writeCache: () => { wrote = true; } }));
    expect(wrote).toBe(false);
    expect(r.latest).toBeNull();
  });
});
