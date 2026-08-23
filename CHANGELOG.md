# Changelog

All notable changes to ant-bot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-08-23

### Added

- **Copy out of a taken-over page.** Ctrl+C puts the remote page's selection on your clipboard,
  and Ctrl+X copies then lets the page delete. This needs a round trip to the daemon rather than a
  key forward: your browser's own selection is a JPEG, and the page's clipboard belongs to the
  headless browser, which you have no way to read. Selections inside form fields are handled too,
  since copying a value out of a login form is a likely reason to be there.
- The viewer now reports what happened — how much was copied, that nothing was selected, or that
  the browser refused clipboard access.

## [0.1.3] — 2026-08-23

### Fixed

- **Takeover now actually receives the keyboard.** Taking over left focus on the button that was
  clicked, so keystrokes went to the button and nothing reached the page — only a click on the
  image made typing work at all. Focus moves to the screencast surface on takeover, and a hint
  appears if it is ever lost.
- **Ctrl+V pastes your clipboard.** The keydown was being swallowed, which suppressed the
  browser's own paste event; forwarding Ctrl+V instead would have pasted the *headless browser's*
  clipboard, which is not yours. The shortcut is now left alone so the native paste event fires
  and the text is sent verbatim.
- Named keys (Backspace, arrows, Enter, Tab) and modifier combinations reach the page reliably
  now that focus is where it needs to be — the daemon side always handled them correctly.

## [0.1.2] — 2026-08-23

### Added

- **Browser takeover forwards mouse and keyboard.** The screencast websocket is now
  bidirectional: clicks, typing, scrolling and paste are dispatched into the page while a screen
  is taken over, so a human can finish a login or 2FA prompt and hand control back. Gated on
  takeover with a hard refusal — input is never queued, so a late click cannot land after control
  was returned. Closes the takeover gap in USER-GUIDE §22.

### Fixed

- **The screencast no longer sits blank on a static page.** Chromium emits frames only on
  repaint, so a page that was not moving — a login form waiting for input, the exact case
  takeover exists for — delivered nothing at all. One screenshot is now seeded on connect.
- **Taking over says what it did.** The daemon has always returned an explanation ("this computer
  is running headless, there is no window to bring to the front…"); the UI discarded it, so the
  button flipped to "Return control" and nothing told you what had changed.

## [0.1.1] — 2026-08-23

### Changed

- **Repo layout flattened.** The four workspace packages moved out of `packages/` to the repo
  root as `contract/`, `daemon/`, `ui/` and `cli/`, and their npm names follow
  (`@antbot/shared` → `@antbot/contract`, `@antbot/server` → `@antbot/daemon`,
  `@antbot/web` → `@antbot/ui`). Each now has a README saying what it is and why it exists.
  No behaviour change; the published package is unaffected.
- **README leads with where your data lives** — a map of `~/.ant-bot`, what each directory holds,
  and why `workspace/` is the security boundary rather than just a folder.

### Added

- **`fable` and `haiku` model tiers for Bots.** `haiku` was already valid in the schema but no
  picker offered it; `fable` is new. Both pickers now render the shared `MODEL_TIERS` list, so the
  UI cannot offer a tier the API rejects, or hide one it accepts.

## [0.1.0] — 2026-08-23

First published release: `npm i -g @michael-joseph-miller/ant-bot`.

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
- The release procedure, the provenance requirements and the packaging traps now live in
  `CLAUDE.md` under "Releasing"; `docs/PACKAGING-PLAN.md` has served its purpose and is deleted.
