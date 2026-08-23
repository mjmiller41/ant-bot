# `daemon/` — `@antbot/daemon`

**The thing that actually runs.** A local Fastify server that owns the database, runs Bot turns
through the Claude Agent SDK, and gates every tool call through the Permission Gateway.

Started by `antbot start`; serves the API, the websocket, and the built UI on `127.0.0.1:4780`.

## Start reading here

`src/app.ts` is the composition root — it builds `db → store → bus → gateway → manager` and then
wires the optional subsystems. Following that function top to bottom is the fastest way to
understand how the pieces fit.

Then `src/bots/manager.ts`, whose `execute()` is where a queued message becomes a running turn.

## Layout

| Path | Role |
|---|---|
| `src/app.ts` | Composition root |
| `src/api/` | Fastify bootstrap, routes, websocket, static UI |
| `src/bots/` | Turn queue, `execute()`, system-prompt assembly, group routing |
| `src/agent/` | Wrapper over the Agent SDK's `query()` |
| `src/permissions/` | The gateway, rules, workspace boundary, auto-review, secrets |
| `src/db/` | Schema, migrations, and the store — the only place SQL lives |
| `src/skills/` | Skill store, install, plugin layout, bundled sync, spec validation |
| `src/scheduler/` | Cron routines |
| `src/computer/` | Playwright browser service and its `browser_*` tools |
| `src/config/` | Config loading and the `~/.ant-bot` path map |
| `src/util/` | Event bus, logging, asset location |

## Two things worth knowing before you change anything

**The permission gateway's evaluation order is load-bearing.** A `require` rule beats every
`allow` rule, the workspace boundary is checked before any allow rule takes effect, and the
fallback is always to ask a human. See the invariants in `../CLAUDE.md`.

**Schema changes go in `src/db/migrations.ts`, never in `schema.ts`.** Editing the schema blob
only changes what a *fresh* database gets; an existing `~/.ant-bot/antbot.db` never sees it.

Depends on: `@antbot/contract`.
