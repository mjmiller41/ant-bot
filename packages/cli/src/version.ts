import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walks up to the nearest package.json rather than assuming `../package.json`, because the
 * published build bundles this file to a different depth than tsc does. Kept independent of
 * @antbot/server's identical helper for the reason given in serverBridge.ts.
 */
export function readVersionFrom(
  here: string,
  exists: (p: string) => boolean,
  read: (p: string) => string,
): string {
  let dir = path.resolve(here);
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (exists(pkg)) {
      try {
        return (JSON.parse(read(pkg)) as { version?: string }).version ?? '0.0.0';
      } catch {
        return '0.0.0';
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}

export function getCliVersion(): string {
  return readVersionFrom(
    path.dirname(fileURLToPath(import.meta.url)),
    (p) => fs.existsSync(p),
    (p) => fs.readFileSync(p, 'utf8'),
  );
}
