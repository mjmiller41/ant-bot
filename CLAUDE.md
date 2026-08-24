# CLAUDE.md — working on ant-bot

Guidance for agents modifying this repository. Read this before touching code.

ant-bot is a **local-first daemon + web UI** hosting persistent, named Claude agents ("Bots").
Bots share one computer (workspace dir, browser profile, terminal), every tool call passes a
Permission Gateway, and turns run through the Claude Agent SDK — which spawns the `claude` CLI,
so usage bills to the user's Pro/Max subscription rather than an API key.

---

## Commands

```bash
pnpm install            # installs AND builds (root `prepare` = `pnpm run build`)
pnpm build              # tsc for shared/server/cli, vite for web
pnpm typecheck          # tsc --noEmit, all packages
pnpm test               # vitest run, all packages
pnpm --filter @antbot/daemon test    # one package
pnpm dev                # daemon only, via `node --experimental-strip-types src/main.ts`
pnpm e2e                # Playwright, needs a live daemon on :4780
pnpm build:package      # assemble the publishable npm package into dist-npm/ (needs pnpm build first)
./antbot doctor|start|stop|status|open|skill|backup|restore|update
```

Your gate is `pnpm lint && pnpm typecheck && pnpm test`; run all three before claiming done.
`.github/workflows/ci.yml` runs exactly those on every push to `main` and every PR, each as its
own step so one failure does not mask the others. There is still no Prettier config — formatting
is not enforced, so match the surrounding file rather than reformatting it.

**Lint is a second opinion, not a formatter.** `eslint.config.js` is flat config on ESLint 9
(note: `--ext` no longer exists — the config decides which files are linted). The type-aware
tseslint presets are deliberately off, since `pnpm typecheck` already covers that ground. Where a
rule fights a deliberate choice here it is disabled *in the config, with the reason written down*
— `no-explicit-any`, `react-hooks/set-state-in-effect`. Read those comments before turning one
back on, and prefer a narrow inline disable with a justification over loosening a rule globally.

Baseline as of this checkout: **build clean, typecheck clean, 48 test files / 885 tests passing**
(contract 34, daemon 610, ui 99, cli 142). The table in `README.md` matches; if you touch it,
recompute rather than copy.

`./antbot` is a launcher that rebuilds whenever any `.ts`/`.tsx`/`.css` under `packages/` is newer
than `cli/dist/index.js`. So `./antbot status` after an edit silently triggers a full
build first. Set **`ANTBOT_HOME`** to run a throwaway instance against a scratch data dir:

```bash
ANTBOT_HOME=/tmp/antbot-scratch ./antbot start --port 4791 --foreground
```

---

## Layout and dependency direction

```
contract/  (@antbot/contract)  →  zod schemas + types for every entity, API request/response,
                                  LIMITS constants, the ServerEvent union. No runtime deps but zod.
daemon/    (@antbot/daemon)    →  the daemon. Depends on contract.
cli/       (@antbot/cli)       →  the `antbot` binary. Depends on daemon (lazily) and contract.
ui/        (@antbot/ui)        →  React 19 + Vite + Tailwind v4 UI. Depends on contract.
```

The four workspace packages sit at the repo root; there is no `packages/` wrapper. Each has its
own README stating what it is and why it exists.

`contract` is the contract. **Daemon and ui must both import from it — never redeclare a type on
one side.** Nothing in `contract` may import from daemon or ui.

Daemon internals:

| Path | Role |
|---|---|
| `src/app.ts` | Composition root. Builds db → store → bus → gateway → manager, then wires optional subsystems. |
| `src/api/server.ts` | Fastify bootstrap, `/api/events` + screencast WS, static UI, crash recovery on boot. |
| `src/api/routes-core.ts` | bots, memory, bot-skills, threads, messages. |
| `src/api/routes-ops.ts` | approvals, rules, skills, secrets, routines, attachments, usage, search, settings, workspace, computer. |
| `src/bots/manager.ts` | Turn queue + `execute()`: the heart. Builds the `antbot` MCP tool server, runs the turn, streams cards. |
| `src/bots/prompt.ts` | System prompt assembly (persona + job description + memory + skills + roster). |
| `src/agent/session.ts` | Thin wrapper over the SDK's `query()`; normalizes SDK messages into `TurnEvent`s. Owns `onElicitation` (mid-turn sign-in → `signin` card) and the reconnect after it. |
| `src/agent/runtime.ts` | The `AgentRuntime` seam: `MountedConnector` is runtime-neutral, `ClaudeRuntime` turns it into SDK `mcpServers`. Gemini/Codex plug in here. |
| `src/permissions/` | `gateway.ts` (decision flow) · `rules.ts` (matcher + `BUILTIN_RULES`) · `local.ts` (workspace boundary) · `autoreview.ts` (Haiku) · `secrets.ts` (keychain). |
| `src/bots/connectors.ts` | Pure core for MCP connectors: secret-ref extraction, mount planning, config building. |
| `src/connectors/` | `oauth.ts` (RFC 9728 discovery, PKCE, token exchange/refresh) · `auth.ts` (sign-in flow, keychain-backed tokens) · `check.ts` (`decideCheck`: the one honest verdict) · `builtin/` (`catalog.ts` what ships, `mcpServer.ts` hand-rolled MCP server, `gmail.ts` the tools, `service.ts` per-boot bearer + mounting). |
| `src/bots/mcpProbe.ts` | Hand-rolled MCP client behind `antbot mcp check`. Advisory only, never in a turn. |
| `src/skills/` | `skills.ts` (store, frontmatter) · `install.ts` (source parsing, git/url staging) · `plugin.ts` (local-plugin layout) · `bundled.ts` (shipped-skill sync + ledger) · `spec.ts` (Agent Skills spec validation). |
| `src/scheduler/scheduler.ts` | node-cron per routine, own `nextRunAt` cron evaluator, away-guard logic. |
| `src/computer/` | `browser.ts` (Playwright persistent context, screencast, takeover) · `tools.ts` (`browser_*` MCP server). |
| `src/db/` | `schema.ts` (raw SQL, = migration 1) · `migrations.ts` (ordered runner + `schema_version`) · `store.ts` (the only place SQL lives). |
| `src/util/locate.ts` | Where the shipped web UI and bundled skills live, in a checkout and in the published package. |

---

## How a message becomes work

1. `POST /api/threads/:id/messages` → row in `messages`, `message.created` on the bus. DM enqueues
   the one member; a group thread runs `routeGroupMessage()` (explicit mentions win, else a Haiku
   router pass, else first member).
2. `BotManager.enqueue()` — FIFO with priority; `origin: 'routine'` gets priority 10 so interactive
   turns run first. `drain()` respects `settings.maxConcurrentSessions` and never runs two turns
   for the same bot.
3. `execute()` creates the streaming bot message, builds the system prompt, assembles MCP servers
   (`antbot` always, `browser` if available), and calls `runTurn()`.
4. Every tool call hits `canUseTool` → `PermissionGateway.check()`. Approval cards are appended to
   the in-flight message so they render inline in the thread.
5. Events stream out: `message.delta`, `message.card`, `bot.state`, `approval.pending`,
   `usage.tick`. On `done`, usage is recorded and the session id is stored back on the bot row.

Every `ServerEvent` carries a monotonic `seq` from `EventBus`; the bus keeps a 500-event ring so a
reconnecting client can send `{"type":"resume","seq":N}` and get the gap replayed.

---

## Invariants — do not break these

**Permission ordering.** `PermissionGateway.check()` evaluates in exactly this order and the order
is load-bearing:

1. `evaluateRules()` — an enabled `require` rule beats every `allow` rule, always.
2. Local-execution boundary (`local.ts`) — checked **before** any allow rule takes effect, so a
   broad user `allow` cannot unlock a path outside the workspace. `never` denies, `ask` forces a
   human, `always` falls through.
3. Auto-review (Haiku) — advisory, consulted **only** when no `require` rule matched. It can never
   green-light past a `require`.
4. Fallback is always `askHuman()`. There is no code path where an unrecognized tool defaults to
   allowed. Keep it that way.

Timeout (`LIMITS.APPROVAL_TIMEOUT_MS`, 15 min) resolves to `expired` and is treated as a denial.

**MCP tool names are namespaced.** Tools served over MCP reach the gateway as
`mcp__browser__browser_click`, `mcp__antbot__send_to_bot`. `toolNameAliases()` in `rules.ts` tests
both the namespaced and bare forms. Any new code that matches, summarizes, or routes on a tool name
must go through it — without it the `browser_click`, `browser_type`, `install_skill` and
`remove_skill` require-rules silently become dead.

**Subscription billing.** `buildEnv()` in `agent/session.ts` strips `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` from every subprocess env unless `settings.billingMode === 'api'`. Every
`query()` call site must use it — `session.ts`, `autoreview.ts` and `groups.ts` all do.

**Screencast input is gated on takeover, and that gate is the whole security model.**
`BrowserService.forwardInput()` refuses with `ScreenNotTakenOverError` unless `takeOver()` is
active for that bot. The check runs **twice**: on entry, and again at dispatch — events are
queued to keep them in order, and control can be returned while some are still pending, so a
click sent late must not land after handback into a page the bot has since navigated.
Input is also serialised per screen: the websocket handler dispatches each frame without awaiting
the last, and unordered input inverts mouse down/up and shuffles typing, which presents as "some
keys work" rather than as a bug. Input does not pass the Permission
Gateway on purpose: the gateway governs what *bots* do, and this is the human acting as
themselves. Do not add a path that dispatches input without that check.

**Connector OAuth tokens live in the keychain and nowhere else.** `ConnectorAuthService` stores
one JSON blob per connector under `antbot:oauth:<name>`, namespaced so it cannot collide with a
user secret. `isAuthorized()` answers from names alone and never reads a value. A token that
cannot be refreshed makes `authHeader()` return null — the connector is not mounted, rather than
mounted with a credential known to be dead. The `state` in the OAuth callback is the CSRF guard:
a callback ant-bot did not start is refused, never exchanged.

**Connector secret values exist in exactly one place.** A connector row stores `{{secret:NAME}}`
references; `buildMcpServerConfig()` is the only code that turns one into a value, and its output
goes straight into the turn's `mcpServers` map. Nothing else may return, log, or persist it —
`GET /api/connectors` and `POST /api/connectors/:id/check` both carry references only. A reference
that resolves to nothing skips the connector for that turn rather than mounting the placeholder as
if it were a credential.

**Connector names are validated, and the reason is `toolNameAliases()`.** Names ban underscores
and reserve `antbot`/`browser` (`CONNECTOR_NAME_RE` in the contract). A name containing `__` would
break the `mcp__<name>__<tool>` split, making the connector's tools unmatchable by the rules meant
to gate them; a reserved name would overwrite a built-in server in the turn's map. Do not seed a
wildcard `require mcp__*` builtin rule — it matches the full alias of every existing `antbot`/
`browser` tool, and a matching `require` beats every user `allow`. The two seeded
`mcp__gmail__send_message` / `mcp__gmail__create_draft` rules are the deliberate exception: exact
names of tools ant-bot itself serves, so they can match nothing else.

**ant-bot is the MCP host; mounting is strict.** `session.ts` passes `strictMcpConfig: true` and
plugins with `skipMcpDiscovery: true`, so a turn mounts exactly `req.mcpServers` (the in-process
`antbot`/`browser`) plus `runtime.mountConnectors(req.connectors)` — never `~/.claude.json`, a
plugin's `.mcp.json`, or claude.ai. Every mounted connector is `alwaysLoad: true`, so its tools sit
in the prompt rather than behind `ToolSearch`. Connector config reaches the runtime only as a
`MountedConnector` through `AgentRuntime`; do not hand SDK-shaped objects around the core.

**Built-in connectors are served by the daemon and guarded by a per-boot bearer.** `POST /mcp/:name`
answers only with `BuiltinService.bearer`, which exists in memory and in the mount config the
daemon builds for its own turns. `handle()` fetches the provider token from `ConnectorAuthService`
per call; the token never enters a tool result, a log, or a response. Adding a built-in means a
catalog entry, a tools module, and — for anything that sends or spends — an exact seeded rule.

**Secrets never enter the model's context.** `request_secret` returns a confirmation string only.
`GET /api/secrets` returns names, never values. Do not add anything that puts a value in a
transcript, a tool result, or a system prompt.

**`SettingsPatchSchema` has no defaults, on purpose.** Parsing a one-field PATCH body through the
defaulted `SettingsSchema` would produce a complete object and reset every unmentioned setting —
including `localExecution`, which is a security control. Never swap the two.

**The HTTP/WS contract is frozen.** `docs/API-CONTRACT.md` says so in its title. Adding a route is
a contract change: update that file in the same change, and update `ui/src/api/client.ts`
and `contract` together.

**`store.ts` owns the SQL.** Four `db.prepare()` calls escape it today — a settings-count probe in
`app.ts`, the three crash-recovery updates in `api/server.ts`, and `rule_id` on an approval in
`gateway.ts`. That is the whole list; don't lengthen it. New queries go on `Store`.
`db/migrations.ts` is not an exception to count: it runs before a `Store` exists, and `db/` is
where schema SQL lives by definition.

---

## Conventions the codebase actually follows

- **ESM everywhere**, `.js` extensions on relative imports even from `.ts` sources. Node >= 24, pnpm 11.
- **Pure core, injected edges.** The testable logic is extracted as exported pure functions and the
  I/O wraps it: `detectBlockFromSignals` vs. `detectBlock`, `parseCronExpr`/`nextRunAt` vs.
  `Scheduler`, `computeBackupItems` vs. `createBackup`, `runDoctor(deps)` with every filesystem,
  network and subprocess call injected. Follow this shape for anything new that deserves tests.
- **Tests are colocated** (`src/**/*.test.ts`), Vitest, `describe`/`it`, no mocking framework —
  hand-rolled fakes and `:memory:` SQLite. Web tests use Testing Library + jsdom.
- **Comments explain *why*, never *what*.** Nearly every non-obvious block carries a sentence about
  the failure it prevents (see `buildMatchText`, `toolNameAliases`, `seedBuiltinRules`,
  `SettingsPatchSchema`, the Fastify `onRequest` hook). Match that density: no comment on obvious
  code, a real explanation where a future reader would otherwise "simplify" a bug back in.
- **Errors are typed and named** — `LimitError` with a `LIMIT_ERROR` code, `MultipleSkillsError`,
  `BrowserUnavailableError`, `ScreenBusyError`, `ScreenTakenOverError`, `InvalidUrlError`, `CliError`.
  Route handlers map `LimitError` to 409 (413 for attachments).
- **Web styling** is Tailwind v4 with CSS custom properties (`bg-(--color-bg-elevated)`), light
  theme via a `.light` class on `<html>`. Tokens live in `ui/src/index.css`; use them
  rather than raw hex.
- **The app owns the viewport; `body` has `overflow: hidden`.** The shell is `h-dvh` and every
  screen fits inside it, scrolling in its own pane. Any flex child that is meant to scroll needs
  **`min-h-0`** alongside `flex-1` — without it the child sizes to its content, escapes the
  viewport, and drags the top bar or the composer out of view. `App.tsx` routes screens through
  `ScrollPane` (document-shaped: Rules, Usage, Settings) or `FixedPane` (self-managing full-height
  panes: Workspace, Computer); chrome that must stay put is `shrink-0`.
- **Skill descriptions are long and untrimmable** — published skills pack trigger-phrase lists into
  `description` because that is what the model matches on. Any UI showing one must clamp it
  (`truncate`, with click-to-expand or a `title`), never let it dictate row height.
- Zustand store is a single flat slice; `handleServerEvent` is an exhaustive switch with a
  `never` check. Keep it exhaustive when you add an event type.

---

## Traps, verified against this checkout

- **Schema changes go in `db/migrations.ts`, never in `schema.ts`.** `MIGRATIONS` is an ordered
  list applied transactionally on every open, with `schema_version` as the ledger; `planMigrations`
  is the pure decision and `migrate()` the I/O wrapper. Migration 1 *is* `SCHEMA_SQL`, so editing
  `schema.ts` changes what a fresh database gets and nothing else — an existing
  `~/.ant-bot/antbot.db` never sees it. Append a new numbered migration instead, and never
  renumber a released one. A database that predates the runner is adopted at the baseline
  (`detectBaselineAdoption`) rather than mistaken for empty, and `migrate()` writes a `VACUUM INTO`
  snapshot to `paths.backups` before touching a database that already holds data.
  (The plan doc mentions a `db/migrations/` *directory*; it is a single module.)
- **Rule seeding lives in `seedBuiltinRules(store)` in `rules.ts`**, called once from `app.ts`.
  (A dead `PermissionGateway.seedBuiltins()` static used to shadow it — it called CommonJS
  `require()` from an ESM module and would have thrown if anything had ever invoked it. Deleted.)
- **Optional subsystems fail silently.** `app.ts` loads skills, browser and scheduler through
  `optionalImport()` inside `try/catch`, so a throw during wiring degrades to
  `log.warn('... subsystem unavailable')` and the daemon boots without it. When a feature "does
  nothing", check the daemon log before assuming the code is wrong.
- **The skills directory is a plugin root, not a skills folder.** `paths.skills` holds
  `.claude-plugin/plugin.json` and a `skills/` subdirectory; individual skills are at
  `<home>/skills/skills/<slug>/SKILL.md`. `SkillStore` is constructed with `skillFilesDir(root)`,
  not the root. `migrateLegacyLayout()` moves pre-plugin installs. Loading skills as a plugin is
  what gives bots the SDK's real `Skill` tool.
- **Bundled skills are hash-managed, not copied.** The repo's `skills/` directory ships with
  ant-bot and `syncBundledSkills()` (`skills/bundled.ts`) installs it on every boot, but it writes
  a hash of each skill into `<skills dir>/.managed.json` and consults it first: a copy the user
  edited is never overwritten, one they deleted is never resurrected, and a same-slug skill from
  another source is never claimed. `planSkillSync()` is the pure decision table — change behavior
  there, not in the I/O wrapper. A skill that is byte-identical to what ships but absent from the
  ledger is *adopted*, which is what carries pre-ledger installs (the old `seedExamples`) forward.
  Hashing must stay in step with `copyTree`'s exclusions (`.git`, `node_modules`, symlinks) or
  every adopted skill looks permanently modified.
- **`enabledSkills` passed to the SDK are frontmatter `name`s, not slugs** (`manager.ts`:
  `botSkills.map(s => s.name)`). It is a context filter, not a sandbox — skill files stay readable
  via Read/Bash, so never put a secret in one. The registered *row* name is what is sent, so anything
  that rewrites a SKILL.md a row already points at must call `SkillStore.refreshFromDisk()` — the
  bundled sync does. Without it the row and the file drift and the skill silently stops resolving.
- **Skills are validated against `skills/SPEC.md`, and `name` is the load-bearing field.**
  `skills/spec.ts` has the rules; `validateSkillDir()` runs on every install (violations are
  appended to the manifest, never blocking), `antbot skill lint` runs it on demand with no daemon,
  and `spec.test.ts` asserts every bundled skill is clean. `name` must match its directory because
  of the `enabledSkills` note above. Note that `installFromSource` lands a skill in a directory
  named `slugify(name)`, so a mismatch can only reach disk through authoring, not through install.
- **`execute()` sets `waiting_approval` before *every* `canUseTool` call**, including ones a rule
  auto-allows microseconds later. Bot state flickers; don't read a single `bot.state` sample as
  proof a human was asked.
- **`PATCH /api/routines/:id` does not validate its body** — it is cast to `Record<string, never>`
  and handed to `store.updateRoutine`, which picks fields defensively. Tighten it if you touch it.
- **`config.toml`'s `[settings]` block is a first-run seed only.** The `settings` table is
  authoritative afterwards; UI changes are never written back to the file. Only `[server] port` and
  `[server] host` are re-read each boot.
- **Empty-body POSTs.** A Fastify `onRequest` hook deletes `content-type: application/json` when
  `content-length` is 0 or absent, because Fastify rejects an empty JSON body before any parser
  runs. `stop`, `duplicate`, `read` and `test-run` depend on this.
- **Boot performs crash recovery** in `startServer()`: running/queued bots reset to idle, streaming
  messages closed, pending approvals expired, running routine runs marked interrupted, mailbox
  drained. Anything you add that survives a restart belongs there.
- **Chromium emits screencast frames only on repaint.** A page sitting still — a login form, a
  2FA prompt, precisely what a human takes over to deal with — produces *none*, so the viewer
  would stay blank forever. `startScreencast()` seeds one `page.screenshot()` frame on connect to
  cover that. For the same reason, input coordinates scale against `page.viewportSize()`, never
  against the last frame: frame-derived geometry is absent exactly when it is needed.
- **`browser.test.ts` launches real Chromium** (39 tests, one live). It is not hermetic — a machine
  without `npx playwright install chromium` will behave differently.
- **`daemon/.smoke/*.mjs` are live scripts**, not tests. They need a running daemon and a
  real `claude` login, and they do real work and spend real tokens. Run deliberately.
- `deleteBot` soft-deletes the bot (`deleted_at`) but hard-deletes its routines and its thread.
- Message search uses an FTS5 external-content table kept in sync by triggers, with a `LIKE`
  fallback wrapped in `try/catch`.
- **Asset lookups walk up to the nearest `package.json`** (`util/locate.ts`), and must keep doing
  so. Counting `..` from `import.meta.url` encodes both the repo layout and the compiler's output
  depth; the published build bundles to a different depth, and every one of these lookups fails
  *silently* when it is wrong — no UI served, no skills synced. `serverBridge.ts` keeps its own
  copy of the walk-up on purpose: locating `@antbot/daemon` cannot depend on loading it.
- **`optionalImport()` in `app.ts` takes a thunk around a *literal* `import()`.** It used to
  assemble the specifier at runtime, which a bundler cannot follow — the published daemon booted
  clean with skills, browser and scheduler all silently absent. `app.packaging.test.ts` fails if
  that form comes back.

---

## Known gaps — the actual work queue

`docs/USER-GUIDE.md` §23 is the authoritative, honest list and it is accurate; I re-verified every
claim below by grep. Treat these as unimplemented, not as bugs to work around:

| Gap | Evidence |
|---|---|
| Secrets reach connectors, not a bot's own shell | `SecretsService.resolve()` feeds connector env/headers (stored by `antbot mcp add --env` / `antbot secret set` / Settings); nothing injects a secret into the bot's `Bash` environment, and `envOverlay()` is still uncalled |
| File cards are never emitted | `type: 'file'` is only ever *rendered* (`Cards.tsx`); no server code creates one |
| `request_secret` has no UI | the event lands in `useStore.secretRequests`; no component reads it |
| Daily token budget | `dailyTokenBudget` is read only by `SettingsScreen`; nothing enforces it |
| Desktop notifications | `notificationsEnabled` and per-bot `notifications` are stored and read nowhere |
| Container computer mode | `computerMode` persists; `BrowserService` hardcodes `mode: 'host'` |
| Away-guard | `checkAndApplyAwayGuard()` is tested but never called by the running server |
| Group thread creation | works over `POST /api/threads`; no UI affordance |
| Skill authoring/installing from the UI | CLI, API, or `skills/` dir only; assignment does work in the UI |

| Teach-by-demonstration, webhook triggers, mobile, multi-user | not started |
| No URL routing | screens are in-app state; refresh returns to Chats |

Nothing authenticates the API. It binds to `127.0.0.1` for exactly that reason — do not add a
`0.0.0.0` bind, a reverse-proxy default, or a port-forward convenience without an auth layer.

---

## Releasing

ant-bot publishes as **`@michael-joseph-miller/ant-bot`** — scoped, because npm's name-similarity
guard refuses the unscoped `ant-bot` as too close to `antbot`, a 2022 security holding package that
cannot be claimed. That check normalises punctuation away, runs *only* at publish time, and cannot
be probed: a 404 from the registry means "unpublished", never "publishable". The binary is still
`antbot`; only install and update commands carry the scope.

To cut a release:

```bash
# bump the version in the ROOT package.json and every packages/*/package.json together
#   (version.test.ts fails if they drift; the root is the source of truth)
# write the CHANGELOG entry, then:
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
```

`.github/workflows/release.yml` reruns the full lint/typecheck/test gate, checks the tag against
`package.json`, assembles `dist-npm/`, packs, and publishes with provenance. It never publishes
something that would have failed CI. A `workflow_dispatch` run with `dry-run: true` does everything
except the upload and leaves the tarball as an artifact.

**Provenance needs three things**, and losing any one fails the last step after everything else has
passed: `id-token: write` on the job, a **public** repo (Sigstore issues no attestation for a
private one), and a `repository` field in the *published* manifest matching this repo.
`assertPublishable()` in `scripts/build-package.mjs` fails the build on the last one so it surfaces
locally in a second rather than after tagging.

**Two ways to "install it and check" that do not work:**

- `npm i -g .` from the repo root installs the *workspace*, which npm symlinks into global
  `node_modules`. No binary (the root has no `bin`), and confusing `prepare` script warnings. The
  root is named `ant-bot-workspace` precisely so this cannot shadow a real install.
- `npm i -g ./dist-npm` is worse because it half-works: npm link-installs a local directory and
  fetches **none** of its dependencies, so `antbot` runs and the daemon dies on `better-sqlite3`.

Only a packed tarball reproduces a registry install — `pnpm build:package` prints the exact
`npm pack && npm i -g` line, with the scope flattened the way npm names the file.

Registry replication lags: after a successful publish, `/latest` and `/<version>` answer while the
aggregated packument (what `npm install` fetches) still 404s for a few minutes. That is not a
failed publish.

---

## Documentation duty

The docs in this repo are unusually accurate and specific, and that is the point — they are written
to be trusted. If your change alters behavior they describe, update them in the same change:

| Doc | Update it when you change… |
|---|---|
| `docs/API-CONTRACT.md` | any route, WS frame, or payload shape (**frozen — a change is a decision, not a detail**) |
| `docs/SECURITY.md` | rules, the gateway, secrets, the workspace boundary, billing-env handling |
| `docs/USER-GUIDE.md` | any user-visible behavior — and §23 whenever you close or open a gap |
| `docs/SKILLS.md` / `skills/README.md` | the skill format, install sources, or the plugin layout |
| `README.md` | commands, layout, requirements, the Status section, the `~/.ant-bot` data map |
| `contract/`·`daemon/`·`ui/`·`cli/` `README.md` | that package's role, its layout, or its own gotchas |
| `CHANGELOG.md` | any user-visible change — it is what a release note is assembled from |

`docs/ant-bot-implementation-plan.md` and `docs/grok-bot-system-outline.md` are historical: the plan
is what was commissioned, the outline is the Grok Bot design doctrine it was translated from. Code
comments cite them as "outline §9", "plan §2". **Do not edit them to match new code** — they are the
record of intent, and where the code has diverged (no migrations dir, no `keytar`, no turbo.json),
the code is what ships.

When a doc claims something is missing, verify before implementing on top of it — and when you make
it work, delete the claim.
