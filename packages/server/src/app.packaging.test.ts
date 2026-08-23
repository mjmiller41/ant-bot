// A source-level test, which is unusual here — but the bug it guards is invisible to every
// other kind. The published build bundles the daemon with esbuild, and a bundler can only follow
// a dynamic import whose specifier is a literal. When `optionalImport` assembled its specifier at
// runtime, the bundle resolved nothing and the daemon booted *successfully* with skills, the
// browser and the scheduler all silently absent: health checks pass, the UI loads, and the only
// symptom is that a third of the product is missing. No unit test of app.ts can see that, because
// in a checkout the runtime form resolves perfectly well.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'app.ts'),
  'utf8',
);

describe('app.ts stays bundler-resolvable', () => {
  it('passes every optional subsystem a literal import thunk', () => {
    const calls = [...src.matchAll(/optionalImport\(([^\n]*)/g)]
      .map((m) => m[1]!)
      // The declaration itself, not a call site.
      .filter((args) => !args.startsWith('name: string'));
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).toMatch(/^'[^']+',\s*\(\)\s*=>\s*import\('\.[^']+'\)\)/);
    }
  });

  it('has no template-literal or variable dynamic import', () => {
    expect(src).not.toMatch(/import\(\s*`/);
    expect(src).not.toMatch(/import\(\s*(?:\/\*[^*]*\*\/\s*)?[A-Za-z_$][\w$]*\s*\)/);
  });

  it('imports only modules that exist, so a bundle cannot be missing one', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const specs = [...src.matchAll(/import\('(\.[^']+)'\)/g)].map((m) => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(fs.existsSync(path.join(dir, spec.replace(/\.js$/, '.ts')))).toBe(true);
    }
  });
});
