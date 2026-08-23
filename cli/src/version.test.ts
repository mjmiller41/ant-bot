import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersionFrom, getCliVersion } from './version.js';

// cli/src -> cli -> repo root. One level shallower than when the workspace lived in packages/.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readPkg = (p: string): { version?: string } => JSON.parse(fs.readFileSync(p, 'utf8'));

function fsOf(files: Record<string, string>): { exists: (p: string) => boolean; read: (p: string) => string } {
  const map = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]));
  return {
    exists: (p) => map.has(path.resolve(p)),
    read: (p) => map.get(path.resolve(p)) ?? '',
  };
}

describe('readVersionFrom', () => {
  it('reads the nearest package.json', () => {
    const f = fsOf({ '/pkg/package.json': '{"version":"1.2.3"}' });
    expect(readVersionFrom('/pkg/dist', f.exists, f.read)).toBe('1.2.3');
  });

  // The published build bundles to a different depth than tsc; the old `../package.json`
  // assumption would have made `antbot --version` report 0.0.0 there.
  it('is independent of how deep the calling module sits', () => {
    const f = fsOf({ '/pkg/package.json': '{"version":"1.2.3"}' });
    expect(readVersionFrom('/pkg/dist/a/b/c', f.exists, f.read)).toBe('1.2.3');
  });

  it('stops at the first package.json rather than continuing to the root', () => {
    const f = fsOf({
      '/pkg/package.json': '{"version":"9.9.9"}',
      '/pkg/inner/package.json': '{"version":"1.0.0"}',
    });
    expect(readVersionFrom('/pkg/inner/dist', f.exists, f.read)).toBe('1.0.0');
  });

  it('degrades to 0.0.0 on unparseable or versionless manifests', () => {
    expect(readVersionFrom('/pkg', fsOf({ '/pkg/package.json': 'not json' }).exists, () => 'not json')).toBe('0.0.0');
    const f = fsOf({ '/pkg/package.json': '{"name":"x"}' });
    expect(readVersionFrom('/pkg', f.exists, f.read)).toBe('0.0.0');
  });

  it('degrades to 0.0.0 when there is no package.json above', () => {
    const f = fsOf({});
    expect(readVersionFrom('/detached/dist', f.exists, f.read)).toBe('0.0.0');
  });
});

describe('one source of version truth', () => {
  const rootVersion = readPkg(path.join(repoRoot, 'package.json')).version;

  it('has a version on the repo root manifest', () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  // In the published package there is genuinely one manifest, so `antbot --version` and
  // /api/health cannot disagree. In a checkout they read their own workspace manifest — this
  // test is what keeps that from drifting into two different answers.
  it.each(['contract', 'daemon', 'ui', 'cli'])('keeps %s/ in lockstep with the root', (dir) => {
    expect(readPkg(path.join(repoRoot, dir, 'package.json')).version).toBe(rootVersion);
  });

  it('reports that version from getCliVersion()', () => {
    expect(getCliVersion()).toBe(rootVersion);
  });
});
