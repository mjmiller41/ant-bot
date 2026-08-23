# Changelog

All notable changes to ant-bot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Database migration runner.** `db/migrations.ts` applies an ordered, transactional migration
  list on every open and records what ran in a `schema_version` table. Databases created before
  the runner existed are adopted at the baseline version rather than mistaken for empty ones, and
  a `VACUUM INTO` snapshot is written to `backups/` before any migration touches existing data.
- **Packaging.** `pnpm build:package` assembles the single publishable npm package into
  `dist-npm/`: the CLI, daemon and shared schemas bundled with esbuild, the built web UI and the
  bundled skills copied in beside them, and a generated manifest checked for everything npm
  otherwise only complains about at publish time.
- **`antbot update`**, and a once-a-day cached registry check surfaced in `antbot status` and
  `antbot doctor`. Notification only — ant-bot never updates itself in the background.
- MIT `LICENSE` and this changelog.

### Changed

- Shipped-asset lookups (the built web UI, the bundled skills directory, the daemon's package
  root) now walk up to the nearest `package.json` instead of counting `..` segments from
  `import.meta.url`. The old form assumed both the repo layout and the compiler's output depth,
  and failed silently from an installed package.
- `antbot --version` and `GET /api/health` read the version from `package.json` instead of a
  hardcoded constant, so a release bump cannot leave them disagreeing.

### Notes

- Published as **`@michael-joseph-miller/ant-bot`**, not `ant-bot`. npm's name-similarity guard
  refuses the unscoped name as too close to `antbot`, a security holding package from 2022 that
  cannot be claimed. Scoped names are exempt from that check. The binary is still `antbot`.

## [0.1.0]

Initial version: the ant-bot daemon, web UI and CLI.
