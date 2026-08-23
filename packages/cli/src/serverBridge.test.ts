import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveServerPackageDir, type ResolveDeps } from './serverBridge.js';

function fsOf(paths: string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

const unresolvable = (s: string): string => {
  throw new Error(`Cannot find module '${s}'`);
};

function deps(over: Partial<ResolveDeps> & Pick<ResolveDeps, 'here'>): ResolveDeps {
  return {
    resolve: unresolvable,
    realpath: (p) => path.resolve(p),
    exists: () => false,
    ...over,
  };
}

describe('resolveServerPackageDir', () => {
  it('prefers a real resolve of the package', () => {
    const d = deps({
      here: '/repo/packages/cli/dist',
      resolve: (s) =>
        s === '@antbot/server/package.json' ? '/repo/packages/server/package.json' : unresolvable(s),
    });
    expect(resolveServerPackageDir(d)).toBe(path.resolve('/repo/packages/server'));
  });

  it('follows the symlink to the real directory, not the link path', () => {
    const link = '/repo/packages/cli/node_modules/@antbot/server';
    const d = deps({
      here: '/repo/packages/cli/dist',
      exists: fsOf(['/repo/packages/cli/package.json', link]),
      realpath: (p) => (path.resolve(p) === path.resolve(link) ? path.resolve('/repo/packages/server') : path.resolve(p)),
    });
    expect(resolveServerPackageDir(d)).toBe(path.resolve('/repo/packages/server'));
  });

  // npm hoists to the install root and never creates cli/node_modules/@antbot/server, which the
  // old hardcoded lookup required — doctor's native-dependency checks silently stopped working.
  it('finds a hoisted install that has no cli-local symlink', () => {
    const d = deps({
      here: '/app/node_modules/@antbot/cli/dist',
      resolve: (s) =>
        s === '@antbot/server/package.json' ? '/app/node_modules/@antbot/server/package.json' : unresolvable(s),
      exists: fsOf(['/app/node_modules/@antbot/cli/package.json']),
    });
    expect(resolveServerPackageDir(d)).toBe(path.resolve('/app/node_modules/@antbot/server'));
  });

  // In the published single-package build the CLI and the daemon are one package, so
  // better-sqlite3 and playwright resolve from the CLI's own root.
  it('falls back to this package when @antbot/server is not a separate package', () => {
    const d = deps({
      here: '/usr/lib/node_modules/antbot/dist',
      exists: fsOf(['/usr/lib/node_modules/antbot/package.json']),
    });
    expect(resolveServerPackageDir(d)).toBe(path.resolve('/usr/lib/node_modules/antbot'));
  });

  it('is independent of how deep the bundled code sits', () => {
    const d = deps({
      here: '/usr/lib/node_modules/antbot/dist/a/b/c',
      exists: fsOf(['/usr/lib/node_modules/antbot/package.json']),
    });
    expect(resolveServerPackageDir(d)).toBe(path.resolve('/usr/lib/node_modules/antbot'));
  });

  it('ignores a dangling symlink and uses the package root', () => {
    const link = '/repo/packages/cli/node_modules/@antbot/server';
    const d = deps({
      here: '/repo/packages/cli/dist',
      exists: fsOf(['/repo/packages/cli/package.json', link]),
      realpath: (p) => {
        if (path.resolve(p) === path.resolve(link)) throw new Error('ENOENT');
        return path.resolve(p);
      },
    });
    expect(resolveServerPackageDir(d)).toBe(path.resolve('/repo/packages/cli'));
  });

  it('returns null when there is no package.json anywhere above', () => {
    expect(resolveServerPackageDir(deps({ here: '/detached/dist' }))).toBeNull();
  });
});
