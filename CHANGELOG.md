# Changelog

All notable changes to ant-bot are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.4] — 2026-08-24

### Changed

- **The thread shows the answer, not the work.** A reply that took a dozen searches used to
  arrive behind a dozen boxes. Tool calls now fold into one quiet line — `7 steps`, or
  `Working… search_threads` while a turn is in flight, or `7 steps · 1 failed` — and clicking it
  opens all of them, in order, exactly as before. Approvals, sign-in prompts, errors and files
  still render in full: those are things to act on, not steps to scroll past.

## [0.4.3] — 2026-08-24

### Fixed

- **A restarted daemon no longer leaves the page blank.** The event sequence restarts at 1 on
  every boot, and the UI drops anything at or below the last sequence it saw — so a tab open
  across a restart silently discarded every event while still showing "Connected". Bots ran,
  replies were written, approvals were raised, and none of it appeared. `hello` now carries a
  per-process epoch; a new one resets the filter and refetches the open thread, the roster and
  the pending approvals.
- **Attaching a file no longer stops the turn on an approval.** Attachments live in
  `~/.ant-bot/attachments`, outside the workspace, so reading the image you just attached tripped
  the local-execution boundary and blocked the turn for fifteen minutes waiting on a permission
  question about your own file. That directory now counts as inside the boundary — containment is
  still resolved, so nothing above it is reachable.
- **"Pending approval" is now a way in.** The count in the top bar was a dead label; clicking it
  opens the thread that is waiting on you. (Approvals are answered inline in the thread — the
  Rules screen, the reasonable guess, is not where they appear.)
- **A bot waiting on you no longer displays as "queued".** Sending a second message while a turn
  was waiting for an approval overwrote the bot's state, so a question waiting for an answer
  looked like a stalled queue.

## [0.4.2] — 2026-08-24

### Changed

- **JSON stays out of the thread.** A tool that returns structured data — a mail search, a thread
  fetch — now shows one line saying what came back (`Result — 50 threads · 82.1 KB`) with the JSON
  behind it, instead of a page of it between you and the Bot's actual reply. Plain-text results
  stay visible, because that is usually the thing you wanted to see.
- **Tool arguments read as words.** `gmail: search_threads query: is:unread, maxResults: 50`
  rather than a JSON object, in the thread and on every approval card. Lists are counted and
  nested objects collapse to `{…}`.

## [0.4.1] — 2026-08-24

### Fixed

- **A Google MCP URL now says what works.** Adding `https://gmailmcp.googleapis.com/…` used to
  report `needs sign-in`, take a client ID, complete the sign-in, and then have every call refused
  with "The caller does not have permission" — Google's endpoint admits only clients Google has
  allowlisted. The check now recognises a Google sign-in behind a custom URL and answers
  "use the built-in instead: `antbot mcp add gmail`", in the CLI and on the Connectors screen,
  without prompting for a client that could not help.

## [0.4.0] — 2026-08-24

Connectors, redesigned. Getting an MCP server usable by a Bot took up to eleven steps and eight
concepts; it is now one command, and ant-bot depends on nothing outside itself for any of it.

### Added

- **Built-in connectors.** `antbot mcp add gmail` gives a Bot mail — `search_threads`,
  `get_thread`, `get_message`, `list_labels`, `create_draft`, `send_message` — served by the daemon
  itself over Gmail's REST API with a token from ant-bot's own sign-in. Google's MCP endpoint
  accepts only allowlisted clients, so ant-bot brings its own server rather than a dependency on
  Google's, or on the `claude` CLI's, or on claude.ai. The one-time Google client setup is guided
  in the CLI and the UI, with the redirect URI filled in. `send_message` and `create_draft` ship
  with a `require` rule, so a Bot always asks before mail leaves your account.
- **One-step add.** `antbot mcp add <name> [command | url]` infers the transport, takes a
  credential once (`--env TOKEN` prompts with echo off and stores it in the keychain), checks the
  server, signs in when it can — opening the browser — and asks which Bots get it (`--bots`).
  The Connectors screen is one **Add** field with the name prefilled, credential rows with a
  **secret** toggle, and Bot checkboxes. Nobody types `{{secret:…}}` any more.
- **An honest check.** `antbot mcp check <name>` (and **Check** on the screen) gives one verdict —
  `ready`, `needs sign-in`, `needs a credential`, `unreachable` — decided by whether a *call* would
  be allowed, not by whether the server lists tools. It replaces `test`, whose green result many
  servers contradicted on the first real call. The verdict is stored on the row and shown there.
- **Mid-turn sign-in.** When a connector's token expires during a turn, the Bot's thread gets a
  card with an **Open** button instead of a silently failing tool; the connector reconnects when
  the sign-in finishes, without a restart.
- **A place for secrets.** `antbot secret set|list|remove` and a **Secrets** section on Settings.
  The API existed; nothing called it.
- **The agent runtime seam.** `AgentRuntime` in `daemon/src/agent/runtime.ts` is where a Gemini or
  Codex runtime plugs in: connectors reach it as a neutral `MountedConnector`, never as SDK config.

### Changed

- **Mounting is strict.** A turn mounts exactly what ant-bot passes — never `~/.claude.json`, a
  plugin's `.mcp.json`, or claude.ai connectors — and every connector's tools are loaded up front
  rather than deferred behind `ToolSearch`. A Bot's tools cannot change because of something
  configured outside ant-bot.
- **Assignment autosaves.** Ticking a connector in Bot settings is the save; the **Save
  connectors** button is gone.
- `antbot connector` remains as an alias of `antbot mcp`. `--scopes` on `add` is gone;
  `--transport sse` remains for the rare SSE endpoint.
- Migration 3 adds `kind`, `last_status`, `last_error`, `checked_at` to `connectors`. Existing
  rows survive as `custom`.

### Removed

- `POST /api/connectors/:id/test` and `ConnectorProbeResult.authHint`, replaced by `/check`.

## [0.3.1] — 2026-08-24

### Fixed

- **Sign-in accepts a client secret.** Google's "Web application" OAuth clients authenticate at
  the token endpoint, so a client ID alone got as far as the consent screen and then failed with
  the provider's own `client_secret is missing`. Both the CLI (`--client-secret`) and the
  Connectors screen now take one, and ant-bot explains what is needed rather than passing that
  message through unhelpfully.
- **Client credentials are remembered.** They are registered once with a provider and outlive any
  token, so they are stored in the keychain under their own key — a second sign-in, after an
  expiry or a failed exchange, needs no flags.

## [0.3.0] — 2026-08-24

### Added

- **ant-bot signs in to MCP servers itself.** Connectors that need an interactive sign-in rather
  than a static token are now first class: `antbot mcp login <name>`, or **Sign in** on the
  Connectors screen. ant-bot discovers what the server accepts (RFC 9728 from the server's own
  401), registers itself with the provider where dynamic client registration is supported, runs an
  OAuth 2.1 authorization-code flow with PKCE, and stores the tokens in the keychain. Every turn
  gets a fresh access token, refreshed before expiry. `antbot mcp logout <name>` forgets it.
  - Providers that do not permit self-registration — Google among them — are handled by accepting
    a client ID you create yourself; ant-bot says so rather than failing obscurely.
  - Tokens are bound to the server they were issued for (RFC 8707), and a callback whose state
    ant-bot did not issue is refused.
- **`antbot mcp`** is the command for all of this. `antbot connector` still works.

## [0.2.3] — 2026-08-24

### Fixed

- **"Start fresh" looked like it did nothing.** It cleared the conversation in the database, but
  the open thread kept rendering the copy it already had, so the screen did not change. The
  `thread.updated` event the daemon publishes was a no-op in the web client — it now drops the
  cached transcript and the view refetches.

### Added

- Guidance for connectors that need an interactive sign-in rather than a static token: the
  `claude` CLI can complete an OAuth flow for an MCP server (`claude mcp login`), which is the
  only route for endpoints that will not accept a header credential. See USER-GUIDE §11.

## [0.2.2] — 2026-08-24

### Fixed

- **`antbot update` could never see a new version.** The registry request asked for
  `application/vnd.npm.install-v1+json`, which npm serves only for the full packument — on the
  `/latest` endpoint it answers `406`, which the caller reported as "could not reach the npm
  registry". So the update check has failed since the first release, and the once-a-day notice in
  `status` and `doctor` never fired. The header is gone, and `fetchLatestVersion` now has tests of
  its own; every previous test injected a fake fetch, which is exactly how the one function that
  talks to the network went unexercised.

## [0.2.1] — 2026-08-24

### Added

- **Start fresh.** A Bot settings action that clears the conversation and the model's accumulated
  context while keeping the Bot itself — description, memory, skills, connectors, routines and
  files all survive. Previously the only way to get a clean slate was to duplicate the Bot and
  delete the original, which also threw away its memory. Refuses while the Bot is working.

### Fixed

- **A connector that fails to start now says so.** The SDK reports each MCP server's status at the
  start of every turn and ant-bot was discarding it, so a connector that needed authentication, or
  failed outright, produced a Bot that simply behaved as though the connector were not assigned —
  with nothing anywhere explaining why. Non-connected servers are now logged and reported in the
  thread, in plain language.
- **`connector test` no longer reports a misleading success.** Listing a server's tools and being
  allowed to call them are different questions: a server can advertise its tools to anyone and
  refuse the first real call. A successful test against an endpoint with no credential configured
  now carries that caveat, in the UI and the CLI.

## [0.2.0] — 2026-08-23

### Added

- **MCP connectors.** External MCP servers can be registered account-wide and assigned to
  individual Bots, the way skills are. Assignment *is* the permission: a Bot that has not been
  given a connector never has the server mounted, so its tools do not exist for that Bot.
  Disabling a connector withdraws it from every Bot at once.
  - Manage them on the new **Connectors** screen, over `/api/connectors`, or with
    `antbot connector list|add|enable|disable|remove|test`.
  - `antbot connector test` connects to the server and lists the tools it offers, so a broken
    command or a wrong URL is visible before a Bot ever tries to use it.
  - stdio, http and sse transports; http and sse accept an optional per-tool allowlist.
  - Tools reach Bots as `mcp__<name>__<tool>` and pass the permission gateway unchanged — the
    first call raises an approval card, and you allow what you trust with a rule.
- **Credentials by reference.** Any connector env value or header may contain `{{secret:NAME}}`.
  The daemon resolves it from the keychain when the server starts; the value lives only in that
  subprocess's environment or its outbound headers, never in the database, an API response, a log
  line, or a Bot's context. A reference with nothing behind it is flagged in the UI and CLI, and
  the connector is skipped for the turn rather than failing it.
  - This gives `SecretsService` a scoped `resolve()`; the unscoped `envOverlay()` remains unused.

### Changed

- `docs/USER-GUIDE.md` gains §11 (Connectors); later sections renumbered, §23 is now the
  known-limitations list. `docs/API-CONTRACT.md` documents seven new endpoints — a deliberate
  change to a frozen contract. `docs/SECURITY.md` gains a connectors section covering what the
  workspace boundary does not cover, why allow rules should be fully qualified, and the fact that
  a credential does reach the connector's own process.

## [0.1.5] — 2026-08-23

### Fixed

- **Input is now dispatched in order.** The screencast socket handles each frame without awaiting
  the last, so events raced: a mouse down and up could invert and a burst of typing arrived
  shuffled. Slow human typing mostly survived it, which is why this looked like "some keys work"
  rather than like a bug. Input is serialised per screen, and the takeover check runs again at
  dispatch so a queued event cannot land after control is handed back. Backlogged pointer moves
  are dropped rather than queued without bound; clicks, keys and text never are.

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
