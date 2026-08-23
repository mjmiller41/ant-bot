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
pnpm --filter @antbot/server test    # one package
pnpm dev                # daemon only, via `node --experimental-strip-types src/main.ts`
pnpm e2e                # Playwright, needs a live daemon on :4780
./antbot doctor|start|stop|status|open|skill|backup|restore
```

**`pnpm lint` is broken** — the root script invokes ESLint 9 but there is no `eslint.config.js`
anywhere. It exits 2 every time. There is also no Prettier config and no CI workflow. Your gate is
`pnpm typecheck && pnpm test`; run both before claiming done.

Baseline as of this checkout: **build clean, typecheck clean, 27 test files / 475 tests passing**
(shared 19, server 349, web 49, cli 58). The table in `README.md` says 437/26 and is stale — if you
touch it, recompute rather than copy.

`./antbot` is a launcher that rebuilds whenever any `.ts`/`.tsx`/`.css` under `packages/` is newer
than `packages/cli/dist/index.js`. So `./antbot status` after an edit silently triggers a full
build first. Set **`ANTBOT_HOME`** to run a throwaway instance against a scratch data dir:

```bash
ANTBOT_HOME=/tmp/antbot-scratch ./antbot start --port 4791 --foreground
```

---

## Layout and dependency direction

```
packages/shared  →  zod schemas + types for every entity, API request/response,
                    LIMITS constants, the ServerEvent union. No runtime deps but zod.
packages/server  →  the daemon. Depends on shared.
packages/cli     →  the `antbot` binary. Depends on server (lazily) and shared.
packages/web     →  React 19 + Vite + Tailwind v4 UI. Depends on shared.
```

`shared` is the contract. **Server and web must both import from it — never redeclare a type on
one side.** Nothing in `shared` may import from server or web.

Server internals:

| Path | Role |
|---|---|
| `src/app.ts` | Composition root. Builds db → store → bus → gateway → manager, then wires optional subsystems. |
| `src/api/server.ts` | Fastify bootstrap, `/api/events` + screencast WS, static UI, crash recovery on boot. |
| `src/api/routes-core.ts` | bots, memory, bot-skills, threads, messages. |
| `src/api/routes-ops.ts` | approvals, rules, skills, secrets, routines, attachments, usage, search, settings, workspace, computer. |
| `src/bots/manager.ts` | Turn queue + `execute()`: the heart. Builds the `antbot` MCP tool server, runs the turn, streams cards. |
| `src/bots/prompt.ts` | System prompt assembly (persona + job description + memory + skills + roster). |
| `src/agent/session.ts` | Thin wrapper over the SDK's `query()`; normalizes SDK messages into `TurnEvent`s. |
| `src/permissions/` | `gateway.ts` (decision flow) · `rules.ts` (matcher + `BUILTIN_RULES`) · `local.ts` (workspace boundary) · `autoreview.ts` (Haiku) · `secrets.ts` (keychain). |
| `src/skills/` | `skills.ts` (store, frontmatter, seeding) · `install.ts` (source parsing, git/url staging) · `plugin.ts` (local-plugin layout). |
| `src/scheduler/scheduler.ts` | node-cron per routine, own `nextRunAt` cron evaluator, away-guard logic. |
| `src/computer/` | `browser.ts` (Playwright persistent context, screencast, takeover) · `tools.ts` (`browser_*` MCP server). |
| `src/db/` | `schema.ts` (raw SQL) · `store.ts` (the only place SQL lives). |

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

**Secrets never enter the model's context.** `request_secret` returns a confirmation string only.
`GET /api/secrets` returns names, never values. Do not add anything that puts a value in a
transcript, a tool result, or a system prompt.

**`SettingsPatchSchema` has no defaults, on purpose.** Parsing a one-field PATCH body through the
defaulted `SettingsSchema` would produce a complete object and reset every unmentioned setting —
including `localExecution`, which is a security control. Never swap the two.

**The HTTP/WS contract is frozen.** `docs/API-CONTRACT.md` says so in its title. Adding a route is
a contract change: update that file in the same change, and update `packages/web/src/api/client.ts`
and `packages/shared` together.

**`store.ts` owns the SQL.** Four `db.prepare()` calls escape it today — a settings-count probe in
`app.ts`, the three crash-recovery updates in `api/server.ts`, and `rule_id` on an approval in
`gateway.ts`. That is the whole list; don't lengthen it. New queries go on `Store`.

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
  theme via a `.light` class on `<html>`. Tokens live in `packages/web/src/index.css`; use them
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

- **There is no migration runner.** `db/schema.ts` is one `CREATE TABLE IF NOT EXISTS` blob, run on
  every open. Adding or changing a column will *not* apply to an existing `~/.ant-bot/antbot.db`.
  Any schema change needs an explicit migration path written alongside it. (The plan doc mentions
  `db/migrations/`; it does not exist.)
- **`PermissionGateway.seedBuiltins()` (the static method) is dead and would throw** — it calls
  CommonJS `require()` inside an ESM module. The live path is `seedBuiltinRules(store)` from
  `rules.ts`, called by `app.ts`. Don't call the static; consider deleting it.
- **Optional subsystems fail silently.** `app.ts` loads skills, browser and scheduler through
  `optionalImport()` inside `try/catch`, so a throw during wiring degrades to
  `log.warn('... subsystem unavailable')` and the daemon boots without it. When a feature "does
  nothing", check the daemon log before assuming the code is wrong.
- **The skills directory is a plugin root, not a skills folder.** `paths.skills` holds
  `.claude-plugin/plugin.json` and a `skills/` subdirectory; individual skills are at
  `<home>/skills/skills/<slug>/SKILL.md`. `SkillStore` is constructed with `skillFilesDir(root)`,
  not the root. `migrateLegacyLayout()` moves pre-plugin installs. Loading skills as a plugin is
  what gives bots the SDK's real `Skill` tool.
- **`enabledSkills` passed to the SDK are frontmatter `name`s, not slugs** (`manager.ts`:
  `botSkills.map(s => s.name)`). It is a context filter, not a sandbox — skill files stay readable
  via Read/Bash, so never put a secret in one.
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
- **`browser.test.ts` launches real Chromium** (39 tests, one live). It is not hermetic — a machine
  without `npx playwright install chromium` will behave differently.
- **`packages/server/.smoke/*.mjs` are live scripts**, not tests. They need a running daemon and a
  real `claude` login, and they do real work and spend real tokens. Run deliberately.
- `deleteBot` soft-deletes the bot (`deleted_at`) but hard-deletes its routines and its thread.
- Message search uses an FTS5 external-content table kept in sync by triggers, with a `LIKE`
  fallback wrapped in `try/catch`.
- The repo currently has **zero commits** and sits on `master`; the intended PR base is `main`.

---

## Known gaps — the actual work queue

`docs/USER-GUIDE.md` §22 is the authoritative, honest list and it is accurate; I re-verified every
claim below by grep. Treat these as unimplemented, not as bugs to work around:

| Gap | Evidence |
|---|---|
| Stored secrets never reach a bot | `SecretsService.envOverlay()` is defined and never called |
| File cards are never emitted | `type: 'file'` is only ever *rendered* (`Cards.tsx`); no server code creates one |
| `request_secret` has no UI | the event lands in `useStore.secretRequests`; no component reads it |
| Daily token budget | `dailyTokenBudget` is read only by `SettingsScreen`; nothing enforces it |
| Desktop notifications | `notificationsEnabled` and per-bot `notifications` are stored and read nowhere |
| Container computer mode | `computerMode` persists; `BrowserService` hardcodes `mode: 'host'` |
| Away-guard | `checkAndApplyAwayGuard()` is tested but never called by the running server |
| Group thread creation | works over `POST /api/threads`; no UI affordance |
| Skill authoring/installing from the UI | CLI, API, or `skills/` dir only; assignment does work in the UI |
| Browser takeover | correctly blocks the bot, but headless + view-only screencast means input is not forwarded |
| Teach-by-demonstration, webhook triggers, mobile, multi-user | not started |
| No URL routing | screens are in-app state; refresh returns to Chats |

Nothing authenticates the API. It binds to `127.0.0.1` for exactly that reason — do not add a
`0.0.0.0` bind, a reverse-proxy default, or a port-forward convenience without an auth layer.

---

## Documentation duty

The docs in this repo are unusually accurate and specific, and that is the point — they are written
to be trusted. If your change alters behavior they describe, update them in the same change:

| Doc | Update it when you change… |
|---|---|
| `docs/API-CONTRACT.md` | any route, WS frame, or payload shape (**frozen — a change is a decision, not a detail**) |
| `docs/SECURITY.md` | rules, the gateway, secrets, the workspace boundary, billing-env handling |
| `docs/USER-GUIDE.md` | any user-visible behavior — and §22 whenever you close or open a gap |
| `docs/SKILLS.md` / `skills/README.md` | the skill format, install sources, or the plugin layout |
| `README.md` | commands, layout, requirements, the Status section |

`docs/ant-bot-implementation-plan.md` and `docs/grok-bot-system-outline.md` are historical: the plan
is what was commissioned, the outline is the Grok Bot design doctrine it was translated from. Code
comments cite them as "outline §9", "plan §2". **Do not edit them to match new code** — they are the
record of intent, and where the code has diverged (no migrations dir, no `keytar`, no turbo.json),
the code is what ships.

When a doc claims something is missing, verify before implementing on top of it — and when you make
it work, delete the claim.
