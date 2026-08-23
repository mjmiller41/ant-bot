#!/usr/bin/env node
// Assembles the single npm package that end users install, into `dist-npm/`.
//
// The workspace is four packages; the published artifact is one. esbuild flattens shared, server
// and cli into three entry bundles, `web/dist` and `skills/` are copied in beside them, and the
// package.json is generated so `files` cannot drift from what is actually there.
//
// What stays external, and why:
//   better-sqlite3  native addon — a prebuilt .node per platform, cannot be bundled
//   playwright      ships per-platform browser drivers and does its own path resolution
//   @anthropic-ai/claude-agent-sdk  spawns the `claude` CLI and resolves files relative to itself
//   fastify + plugins  resolve plugin metadata via require and break under bundling
// Everything external is declared as a real dependency below, so npm installs it for the user.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(repoRoot, 'dist-npm');

const PACKAGE_NAME = 'ant-bot';

// npm provenance (`npm publish --provenance`) refuses to sign a package whose `repository` does
// not match the repo the workflow is running in, so this is load-bearing, not metadata polish.
const REPOSITORY = 'github.com/mjmiller41/ant-bot';

/** Externals, and the version range the published package declares for each. */
const EXTERNAL_DEPENDENCIES = {
  '@anthropic-ai/claude-agent-sdk': null,
  'better-sqlite3': null,
  playwright: null,
  fastify: null,
  '@fastify/cors': null,
  '@fastify/multipart': null,
  '@fastify/static': null,
  '@fastify/websocket': null,
  'node-cron': null,
  'smol-toml': null,
  zod: null,
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pkgJson = (name) => readJson(path.join(repoRoot, 'packages', name, 'package.json'));

function resolveVersions() {
  const declared = { ...pkgJson('server').dependencies, ...pkgJson('shared').dependencies };
  const out = {};
  for (const name of Object.keys(EXTERNAL_DEPENDENCIES)) {
    const range = EXTERNAL_DEPENDENCIES[name] ?? declared[name];
    if (!range) {
      throw new Error(
        `external "${name}" has no version range in any workspace package.json — ` +
          `add it there, or the published package will not install it`,
      );
    }
    out[name] = range;
  }
  return out;
}

function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    // Mirrors copyTree in skills/install.ts: a symlink in the tree would publish as a broken
    // link, and .git/node_modules would balloon the tarball.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyDir(from, to, skip);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/**
 * Fails the build for things npm only complains about at publish time — by which point the
 * release workflow has already run the full test gate, tagged, and packed. `repository` in
 * particular is not optional: `--provenance` refuses to sign without it.
 */
function assertPublishable(manifest) {
  const problems = [];
  for (const field of ['name', 'version', 'description', 'license', 'repository', 'bin', 'files']) {
    if (!manifest[field]) problems.push(`missing "${field}"`);
  }
  const url = manifest.repository?.url ?? '';
  if (url && !url.includes(REPOSITORY)) {
    problems.push(`repository "${url}" does not point at ${REPOSITORY}; provenance will refuse it`);
  }
  if (manifest.private) problems.push('"private": true would make publish fail');
  if (problems.length) {
    throw new Error(`generated package.json is not publishable:\n  - ${problems.join('\n  - ')}`);
  }
}

function requireBuilt(p, what) {
  if (!fs.existsSync(p)) {
    throw new Error(`${what} is missing at ${p} — run \`pnpm build\` first`);
  }
}

async function main() {
  const version = readJson(path.join(repoRoot, 'package.json')).version;
  const webDist = path.join(repoRoot, 'packages', 'web', 'dist');
  const skillsDir = path.join(repoRoot, 'skills');
  requireBuilt(path.join(webDist, 'index.html'), 'the built web UI');
  requireBuilt(path.join(skillsDir, 'SPEC.md'), 'the bundled skills directory');

  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(outRoot, { recursive: true });

  const external = Object.keys(EXTERNAL_DEPENDENCIES);
  await build({
    entryPoints: {
      // The bin. Loads the daemon lazily, via serverBridge.
      index: path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts'),
      // The daemon, reached by serverBridge's bundled-file candidate.
      server: path.join(repoRoot, 'packages', 'server', 'src', 'index.ts'),
      // Kept separate so `antbot skill lint` does not load the daemon's native dependencies.
      'skills-spec': path.join(repoRoot, 'packages', 'server', 'src', 'skills', 'spec.ts'),
    },
    outdir: path.join(outRoot, 'dist'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    // Shared chunks, so the three entries do not each carry their own copy of @antbot/shared.
    splitting: true,
    sourcemap: true,
    external,
    logLevel: 'info',
    banner: {
      // Bundled ESM loses import.meta.require and any transitive CommonJS interop that the
      // externals reach for; this restores it without converting the output to CJS.
      js: [
        "import { createRequire as __antbotCreateRequire } from 'node:module';",
        'const require = __antbotCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  });

  fs.chmodSync(path.join(outRoot, 'dist', 'index.js'), 0o755);

  copyDir(webDist, path.join(outRoot, 'web', 'dist'));
  copyDir(skillsDir, path.join(outRoot, 'skills'), (n) => n === '.git' || n === 'node_modules');

  for (const f of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
    fs.copyFileSync(path.join(repoRoot, f), path.join(outRoot, f));
  }

  const manifest = {
    name: PACKAGE_NAME,
    version,
    description: 'Local-first daemon and web UI hosting persistent, named Claude agents.',
    license: 'MIT',
    author: 'Michael Miller',
    repository: { type: 'git', url: `git+https://${REPOSITORY}.git` },
    homepage: `https://${REPOSITORY}#readme`,
    bugs: { url: `https://${REPOSITORY}/issues` },
    type: 'module',
    bin: { antbot: './dist/index.js' },
    engines: { node: '>=24' },
    // Everything in dist-npm ships; listing the directories keeps a stray file from riding along.
    files: ['dist', 'web', 'skills', 'README.md', 'CHANGELOG.md', 'LICENSE'],
    dependencies: resolveVersions(),
    keywords: ['claude', 'agent', 'ai', 'daemon', 'local-first', 'anthropic'],
  };
  assertPublishable(manifest);
  fs.writeFileSync(path.join(outRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const bytes = totalBytes(outRoot);
  console.log(`\n${PACKAGE_NAME}@${version} assembled in dist-npm/ (${(bytes / 1e6).toFixed(1)} MB)`);
  console.log('');
  // `npm i -g ./dist-npm` looks equivalent and is not: npm *links* a local directory and
  // installs none of its dependencies, so the daemon starts and then cannot load
  // better-sqlite3. Packing first is what reproduces a registry install.
  console.log('  Test it as a user would:  npm pack ./dist-npm && npm i -g ./ant-bot-' + version + '.tgz');
  console.log('  Publish:                  npm publish ./dist-npm --access public');
}

function totalBytes(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += totalBytes(p);
    else if (entry.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

await main();
