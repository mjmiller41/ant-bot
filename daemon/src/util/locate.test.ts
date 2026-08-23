import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findPackageRoot,
  webDistCandidates,
  findWebDist,
  bundledSkillsCandidates,
  findBundledSkillsDir,
  type LocateDeps,
} from './locate.js';

/** A fake filesystem: only the listed paths exist. */
function fsOf(paths: string[]): (p: string) => boolean {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p) => set.has(path.resolve(p));
}

function deps(over: Partial<LocateDeps> & Pick<LocateDeps, 'here'>): LocateDeps {
  return { cwd: '/nowhere', exists: () => false, resolve: () => null, ...over };
}

/* The two layouts these lookups have to survive. A checkout runs from the source tree; an
 * installed package is a flat directory under node_modules with no workspace around it. */
const CHECKOUT = {
  serverPkg: '/repo/daemon/package.json',
  here: '/repo/daemon/dist/api',
  webIndex: '/repo/ui/dist/index.html',
  skills: '/repo/skills',
};
const INSTALLED = {
  pkg: '/usr/lib/node_modules/antbot/package.json',
  here: '/usr/lib/node_modules/antbot/dist/api',
  webIndex: '/usr/lib/node_modules/antbot/web/dist/index.html',
  skills: '/usr/lib/node_modules/antbot/skills',
};

describe('findPackageRoot', () => {
  it('finds the nearest package.json above a compiled module', () => {
    expect(findPackageRoot('/repo/daemon/dist/api', fsOf([CHECKOUT.serverPkg])))
      .toBe(path.resolve('/repo/daemon'));
  });

  it('returns the directory itself when it holds the package.json', () => {
    expect(findPackageRoot('/a/b', fsOf(['/a/b/package.json']))).toBe(path.resolve('/a/b'));
  });

  it('returns null rather than looping at the filesystem root', () => {
    expect(findPackageRoot('/a/b/c', fsOf([]))).toBeNull();
  });

  // The point of walking up: bundling changes how deep the module sits, and must not matter.
  it('is independent of how deep the calling module is', () => {
    const exists = fsOf([INSTALLED.pkg]);
    const root = path.resolve('/usr/lib/node_modules/antbot');
    expect(findPackageRoot('/usr/lib/node_modules/antbot/dist', exists)).toBe(root);
    expect(findPackageRoot('/usr/lib/node_modules/antbot/dist/a/b/c/d', exists)).toBe(root);
  });
});

describe('findWebDist', () => {
  it('finds the sibling workspace package in a checkout', () => {
    const d = deps({
      here: CHECKOUT.here,
      exists: fsOf([CHECKOUT.serverPkg, CHECKOUT.webIndex]),
    });
    expect(findWebDist(d)).toBe(path.resolve('/repo/ui/dist'));
  });

  // The regression this exists for: the old `../../../web/dist` walk resolved into node_modules
  // and returned null from an installed package, and the daemon silently served no UI.
  it('finds the copied-in dist from an installed package', () => {
    const d = deps({
      here: INSTALLED.here,
      exists: fsOf([INSTALLED.pkg, INSTALLED.webIndex]),
    });
    expect(findWebDist(d)).toBe(path.resolve('/usr/lib/node_modules/antbot/web/dist'));
  });

  it('still finds it when the code is bundled to a different depth', () => {
    const d = deps({
      here: '/usr/lib/node_modules/antbot/dist',
      exists: fsOf([INSTALLED.pkg, INSTALLED.webIndex]),
    });
    expect(findWebDist(d)).toBe(path.resolve('/usr/lib/node_modules/antbot/web/dist'));
  });

  it('prefers an explicitly resolvable @antbot/ui over any layout guess', () => {
    const d = deps({
      here: CHECKOUT.here,
      resolve: (s) => (s === '@antbot/ui/package.json' ? '/elsewhere/web/package.json' : null),
      exists: fsOf([CHECKOUT.serverPkg, CHECKOUT.webIndex, '/elsewhere/web/dist/index.html']),
    });
    expect(findWebDist(d)).toBe(path.resolve('/elsewhere/web/dist'));
  });

  it('falls through a resolvable package whose dist is not built', () => {
    const d = deps({
      here: CHECKOUT.here,
      resolve: () => '/elsewhere/web/package.json',
      exists: fsOf([CHECKOUT.serverPkg, CHECKOUT.webIndex]),
    });
    expect(findWebDist(d)).toBe(path.resolve('/repo/ui/dist'));
  });

  it('finds it relative to the cwd when run from the repo root', () => {
    const d = deps({ here: '/detached', cwd: '/repo', exists: fsOf([CHECKOUT.webIndex]) });
    expect(findWebDist(d)).toBe(path.resolve('/repo/ui/dist'));
  });

  it('returns null when the UI has not been built', () => {
    expect(findWebDist(deps({ here: CHECKOUT.here, exists: fsOf([CHECKOUT.serverPkg]) }))).toBeNull();
  });

  it('requires index.html, not just the directory', () => {
    const d = deps({
      here: INSTALLED.here,
      exists: fsOf([INSTALLED.pkg, '/usr/lib/node_modules/antbot/web/dist']),
    });
    expect(findWebDist(d)).toBeNull();
  });

  it('never proposes a candidate inside node_modules of the package it starts from', () => {
    const cands = webDistCandidates(deps({ here: INSTALLED.here, exists: fsOf([INSTALLED.pkg]) }));
    expect(cands.some((c) => c.includes(`${path.sep}node_modules${path.sep}antbot${path.sep}node_modules`))).toBe(false);
  });
});

describe('findBundledSkillsDir', () => {
  it('finds the repo skills directory in a checkout', () => {
    const d = deps({ here: CHECKOUT.here, exists: fsOf([CHECKOUT.serverPkg, CHECKOUT.skills]) });
    expect(findBundledSkillsDir(d)).toBe(path.resolve('/repo/skills'));
  });

  it('finds the copied-in directory from an installed package', () => {
    const d = deps({ here: INSTALLED.here, exists: fsOf([INSTALLED.pkg, INSTALLED.skills]) });
    expect(findBundledSkillsDir(d)).toBe(path.resolve('/usr/lib/node_modules/antbot/skills'));
  });

  it('still finds it when the code is bundled to a different depth', () => {
    const d = deps({
      here: '/usr/lib/node_modules/antbot/dist',
      exists: fsOf([INSTALLED.pkg, INSTALLED.skills]),
    });
    expect(findBundledSkillsDir(d)).toBe(path.resolve('/usr/lib/node_modules/antbot/skills'));
  });

  // syncBundledSkills treats a missing directory as "nothing to sync", so a concrete path is
  // more useful in a log than a null.
  it('returns its first candidate rather than null when nothing exists', () => {
    const d = deps({ here: INSTALLED.here, exists: fsOf([INSTALLED.pkg]) });
    expect(findBundledSkillsDir(d)).toBe(bundledSkillsCandidates(d)[0]);
  });
});

describe('the real checkout', () => {
  // Guards the production wiring, not just the pure core: if these two disagree with the tree
  // this test file lives in, the injected-deps tests above are testing a fiction.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const real = { here, cwd: process.cwd(), exists: (p: string) => fs.existsSync(p), resolve: () => null };

  it('locates the skills that ship with this checkout', () => {
    expect(fs.existsSync(path.join(findBundledSkillsDir(real), 'weekly-report', 'SKILL.md'))).toBe(true);
  });

  it('proposes the repo root as a skills candidate', () => {
    // daemon/src/util -> daemon/src -> daemon -> repo root
    expect(bundledSkillsCandidates(real)).toContain(path.resolve(here, '..', '..', '..', 'skills'));
  });
});
