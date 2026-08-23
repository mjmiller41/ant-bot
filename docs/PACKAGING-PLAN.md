# Packaging and distribution plan

**Status: steps 1–5 landed and verified against a real global install; not yet published.** This is a live work plan, not a historical record
— unlike `ant-bot-implementation-plan.md` and `grok-bot-system-outline.md`, it is meant to be
edited as the work lands, and deleted once it is all done. What remains is in
[Left to do](#left-to-do) at the bottom.

**The decision:** ant-bot ships to end users as **one bundled npm package**, installed with
`npm i -g ant-bot`. The repo checkout plus `./antbot` stays exactly as it is and becomes the
contributor path.

> **Name change from the original plan.** `antbot` on npm is a *security holding package*
> (`0.0.1-security`, published 2022), so it cannot be claimed. The published name is **`ant-bot`**,
> matching the repo and the `~/.ant-bot` data directory. The binary is still `antbot`, so every
> command in the docs is unchanged.

## Why this shape

`claude` — which every ant-bot user must already have installed and logged in — is distributed the
same way, so this is the least surprising thing we can do. It also removes pnpm, a TypeScript
toolchain, and a 643 MB `node_modules` from the end user's machine.

Rejected alternatives, with the reason:

| Option | Why not |
| --- | --- |
| Publish all four workspace packages separately | Lockstep versioning, and it keeps the fragile inter-package path lookups that step 2 below exists to delete |
| Standalone binary (Node SEA / `bun --compile`) | `better-sqlite3` is a native addon and the Agent SDK ships per-platform binaries; a per-platform CI matrix to avoid a Node dependency the user is guaranteed to have already |
| Docker image | Inverts the product's premise — bots share *your* computer, workspace, browser profile and `claude` login. Fits the "container computer mode" gap in USER-GUIDE §22, not the install story |
| Homebrew tap / AUR | Worth doing *after* this, as a thin wrapper over the published package |

## The work, in dependency order

### 1. Migration runner — **done**

`db/schema.ts` was one `CREATE TABLE IF NOT EXISTS` blob run on every open, with no migration
runner. Harmless while the only database in existence is the author's; the first shipped update
adding a column would have silently broken every existing `~/.ant-bot/antbot.db`.

`db/migrations.ts` now holds the whole mechanism:

- `schema_version` ledger table; `MIGRATIONS` is the ordered list, applied inside a transaction
  per migration on open, so a failure partway through leaves the ledger honest about how far it got.
- Migration 1 **is** `SCHEMA_SQL`. Editing `schema.ts` therefore only changes what a *fresh*
  database gets — an existing one never sees it. Append a numbered migration instead, and never
  renumber a released one.
- `detectBaselineAdoption` recognises a pre-runner database by a table only the baseline creates,
  so it is adopted at the baseline rather than mistaken for empty.
- `migrate()` writes a `VACUUM INTO` snapshot to `paths.backups` before touching a database that
  already holds data. `VACUUM INTO` rather than a file copy, because copying `antbot.db` alone
  would lose whatever is still in `antbot.db-wal`. A brand-new database is not snapshotted.
- `planMigrations(currentVersion, migrations)` is the pure decision and `migrate()` the I/O
  wrapper, matching `detectBlockFromSignals` / `computeBackupItems` / `runDoctor(deps)`. It refuses
  a database numbered past the code (`MIGRATION_DOWNGRADE`) rather than writing rows a newer
  schema forbids.

Note: this is a single module, not the `db/migrations/` *directory* the old plan doc mentions.
The trap in `CLAUDE.md` is rewritten accordingly.

### 2. Make the server location-independent — **done**

Three lookups assumed the repo layout and resolved into `node_modules` from an installed package,
each failing silently. All three now walk **up to the nearest `package.json`** instead of counting
`..` segments, which was encoding two guesses at once: the repo layout, *and* how deep the
compiler puts the calling module. The second guess is what bundling breaks.

- `findWebDist()` → `util/locate.ts`. Tries a real resolve of `@antbot/web`, then `<pkg>/web/dist`
  (published layout), then `<pkg>/../web/dist` (workspace sibling), then the cwd.
- `serverBridge.findServerPackageDir()` → `resolveServerPackageDir()`. Tries
  `require.resolve('@antbot/server/package.json')` — correct under npm, pnpm and yarn regardless of
  hoisting, which the old hardcoded `packages/cli/node_modules/@antbot/server` symlink was not —
  then that symlink anyway, then this package itself for the single-package build.
- `defaultBundledSkillsDir()` → `findBundledSkillsDir()`. Was already dual-layout, but its
  installed candidate (`../../skills`) assumed tsc's output depth and would have broken under
  bundling.

Covered by `util/locate.test.ts` and `serverBridge.test.ts`, both of which simulate a real
installed layout with injected filesystems.

### 3. Bundle, and add publish metadata — **done**

`pnpm build:package` (`scripts/build-package.mjs`) assembles `dist-npm/`:

```
dist-npm/
  package.json          generated — `files` cannot drift from what is there
  dist/index.js         the bin: CLI + shared, bundled
  dist/server.js        the daemon, reached by serverBridge's bundled-file candidate
  dist/skills-spec.js   separate entry so `antbot skill lint` loads no native deps
  web/dist/             the built UI
  skills/               the bundled skills
  LICENSE  README.md  CHANGELOG.md
```

esbuild, ESM, `splitting: true` so the three entries share one copy of `@antbot/shared`. Left
external and declared as real dependencies: `better-sqlite3` (native addon), `playwright`
(per-platform drivers), the Agent SDK (resolves files relative to itself), and fastify + its
plugins (resolve plugin metadata via `require`). Their version ranges are read from the workspace
manifests rather than duplicated, and the build fails if one is missing.

One source of version truth: the root `package.json`. `getCliVersion()` and `SERVER_VERSION` both
read the nearest manifest, which in the published package is literally the same file — and
`version.test.ts` pins every workspace manifest to the root so they cannot drift in a checkout.

MIT `LICENSE` and `CHANGELOG.md` added.

**A bug this uncovered.** `optionalImport()` in `app.ts` assembled its specifier at runtime
(`import(\`${spec}\`)`) so the compiler would not require the module to exist. A bundler cannot
follow that: the published daemon booted **successfully** with skills, the browser and the
scheduler all silently missing — health checks pass, the UI loads, and a third of the product is
absent. It now takes a thunk around a literal `import()`, the "no export found" path logs instead
of returning quietly, and `app.packaging.test.ts` fails if the old form comes back.

### 4. Release and update — **done**

- `.github/workflows/release.yml`: tag-triggered (`v*`), reusing the exact lint/typecheck/test gate
  from `ci.yml`, verifying the tag matches `package.json`, then `npm publish --provenance`. A
  `workflow_dispatch` dry run builds and uploads the tarball without publishing, because `files`
  mistakes are only visible in packed output.
- Provenance needs three things, and the first is easy to miss: a `repository` field in the
  *published* manifest matching the repo the workflow runs in (npm refuses to sign without it),
  `id-token: write` on the job, and a publish from a supported CI. `assertPublishable()` in the
  build script fails the build if the manifest loses any of that, rather than letting the release
  job discover it after tagging and packing.
- `antbot update [--check] [--yes]`: detects the package manager from the install path, re-runs it,
  then points at `antbot restart`. Refuses inside a git checkout — detected by *two* signals
  (outside `node_modules` **and** a `.git` above), since each alone is wrong somewhere.
- A once-a-day cached registry check, surfaced in `antbot status` and `antbot doctor`.
  **Notification only, never automatic** — the daemon holds a live SQLite handle and may be
  mid-turn spending tokens. It never throws: offline falls back to a stale cache, then to silence.

Not done: the Settings surface. That needs an API endpoint, and `docs/API-CONTRACT.md` is frozen —
"a decision, not a detail", as the original plan put it. Recorded as a gap in USER-GUIDE §22
rather than decided unilaterally.

### 5. Documentation — **done**

- `README.md` Quickstart split into a user path (npm) and a contributor path (clone); test-count
  table recomputed.
- `docs/USER-GUIDE.md` §2 (installation, and a new "Staying up to date"), §3 (the `update`
  command), §22 (the update-check UI gap).
- `CLAUDE.md`: the "no migration runner" trap rewritten as "schema changes go in `migrations.ts`",
  plus new traps for the asset lookups and `optionalImport`.
- `docs/API-CONTRACT.md`: **unchanged** — no route was added.

## Left to do

1. **Publish.** Nothing is on npm yet. `npm publish ./dist-npm --dry-run` passes (369 kB packed,
   60 files). Before a `v0.1.0` tag does anything, the repo needs:

   - **An `NPM_TOKEN` secret.** An npm automation token with publish rights on `ant-bot`.
   - **A `npm-publish` environment** (Settings → Environments), which `release.yml` declares.
     It is *optional* — GitHub auto-creates it on first use, and deleting the `environment:` line
     and putting `NPM_TOKEN` in repo-level secrets works identically. It is there for two reasons
     worth keeping on a step this irreversible (npm unpublish is a 72-hour window and the version
     number is burned forever): the token is readable only by jobs that declare this environment,
     and the environment can require a human approval before the job runs.
2. ~~Verify against a real global install.~~ **Done.** `npm pack ./dist-npm` →
   `npm i -g ant-bot-0.1.0.tgz` on npm 12 pulls 188 packages with no blocked install scripts,
   puts `antbot` on the PATH, passes all eight `doctor` checks (`better-sqlite3` native module
   included), and boots clean: UI served from the package, five bundled skills synced, browser and
   scheduler up, zero warnings.

   Two traps found doing it, both now guarded:
   - `npm i -g .` from the repo root installs the *workspace*, which npm symlinks into global
     `node_modules` under whatever name the root manifest carries. It creates no binary (the root
     has no `bin`), emits confusing `prepare: pnpm run build` script warnings, and — while the root
     was still named `ant-bot` — shadowed any real install. The root is now
     **`ant-bot-workspace`**, with the reason recorded in the manifest.
   - `npm i -g ./dist-npm` is *also* wrong, and much more convincingly: npm link-installs a local
     directory and fetches none of its dependencies, so `antbot` exists and the daemon dies on
     `better-sqlite3`. Only a packed tarball reproduces a registry install. `pnpm build:package`
     now prints the pack-then-install command.
3. **The update check in Settings** — blocked on the frozen-contract decision above.
4. **Homebrew tap / AUR**, as a thin wrapper over the published package.

## Constraints that do not change

- Nothing authenticates the API; it binds to `127.0.0.1` for that reason. Packaging must not
  introduce a `0.0.0.0` bind, a reverse-proxy default, or a port-forward convenience.
- `claude` (logged in to a Pro/Max subscription) and, optionally, Chromium remain user-installed
  prerequisites. `antbot doctor` already checks both and is the right place to keep saying so.
