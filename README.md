# ant-bot

ant-bot is a locally-running daemon and web UI that hosts a roster of persistent, named Claude
teammates ("Bots"). Each Bot has a job description, its own conversation thread, durable memory,
enabled skills, and scheduled routines, and all Bots share one "agent computer": the local
machine, with a shared workspace directory, a persistent browser profile, and a terminal. It is
built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), which spawns
the `claude` CLI under the hood — so a Bot's usage draws on your existing Claude Pro/Max
subscription login rather than a metered `ANTHROPIC_API_KEY`.

## What it does

- **Bots** — persistent, named agents with a title, a standing job description, their own thread,
  and a memory directory that survives daemon restarts.
- **A shared computer** — one workspace directory, one persistent browser profile, one terminal;
  every Bot can reach what every other Bot can reach.
- **Approvals** — every tool call a Bot proposes passes a Permission Gateway: deterministic rules,
  optional Haiku auto-review, or a human approval card in the thread.
- **Skills** — standard Claude skills (`SKILL.md`), installed with `antbot skill add <source>` from
  a GitHub repo, git URL, local path, or direct link. Loaded into each Bot's session as a local
  plugin, so Bots get the SDK's native `Skill` tool. Skills can also live in this repo's `skills/`
  directory and are installed on every start. A Bot can install and remove skills itself, behind an
  approval that spells out whether the source is one skill or a whole repository.
- **Routines** — cron-scheduled recurring turns per Bot, with run history and a real-work test run.
- **Multi-bot handoff** — Bots can hand a task to another Bot (`send_to_bot`) and talk in group
  chats; a hop limit stops runaway ping-pong.
- **Browser use** — Playwright drives a persistent, shared browser profile per Bot, with a live
  screencast and a "take over" flow for logins, 2FA, and CAPTCHAs.

## Documentation

| Document | What it covers |
| --- | --- |
| **[`docs/USER-GUIDE.md`](docs/USER-GUIDE.md)** | **Complete user manual** — every screen, setting, and workflow, with step-by-step instructions |
| [`docs/SECURITY.md`](docs/SECURITY.md) | The trust model and what the permission system does and does not guarantee |
| [`docs/SKILLS.md`](docs/SKILLS.md) | Authoring skill files |
| [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) | HTTP and WebSocket API reference |

## Requirements

- Node.js **>= 24**
- [pnpm](https://pnpm.io/) (this repo pins `pnpm@11.17.0` via `packageManager`)
- The `claude` CLI installed and logged in to a Claude Pro/Max subscription
  (`npm i -g @anthropic-ai/claude-code`, then run `claude` once to log in)
- Optional: Chromium for browser use (`npx playwright install chromium`) — the daemon still runs
  without it, just without browser-use tools

Run `./antbot doctor` (see [Quickstart](#quickstart)) to check all of the above at once.

## Quickstart

Two ways in. Install the package if you want to *use* ant-bot; clone the repo if you want to
change it.

### Install it (npm)

```bash
npm i -g ant-bot      # or: pnpm add -g ant-bot
antbot doctor         # check Node, the claude CLI + login, data dir, port, native deps
antbot open           # start the daemon and open the UI
```

One package: the daemon, the CLI, the built web UI and the bundled skills. It needs Node 24+ and
a logged-in `claude` CLI, and nothing else — no pnpm, no TypeScript toolchain, no build step.
`antbot update` upgrades it later; `antbot status` and `antbot doctor` mention a new version when
one exists, but nothing ever updates itself in the background.

### Work on it (clone)

```bash
git clone <this repo> && cd ant-bot
pnpm install          # installs dependencies and builds every package
./antbot doctor
./antbot open
```

`./antbot` is a launcher in the repo root — it rebuilds when sources change, so there's nothing
to reinstall after a `git pull`. `pnpm build:package` assembles the publishable package into
`dist-npm/` if you want to see what ships.

Either way the UI is at **http://127.0.0.1:4780**, served by the daemon itself from the built
web assets. There's no separate frontend server to run.

### The commands you'll actually use

| Command | What it does |
| --- | --- |
| `antbot open` | Open the web UI, starting the daemon first if it isn't running |
| `antbot start` | Start the daemon in the background (`--open` to open the UI too) |
| `antbot stop` | Stop the daemon |
| `antbot restart` | Stop and start again |
| `antbot status` | Whether it's running, on what port, with how many bots |
| `antbot doctor` | Diagnose the environment; every failure prints its fix |
| `antbot update` | Update to the latest published version (`--check` to look without installing) |

Run `antbot --help` for the full list, or `antbot <command> --help` for one command.

### Putting `antbot` on your PATH

`./antbot` works from the repo root without any install step. To type plain `antbot` from
anywhere, symlink it into a directory already on your `PATH`:

```bash
ln -s "$PWD/antbot" ~/.local/bin/antbot   # or /usr/local/bin, or anywhere on your PATH
```

The launcher resolves symlinks, so it still finds the repo and rebuilds when sources change.
From the repo root you can also skip the `./` with `pnpm antbot status`.

### Data directory

Data lives under `~/.ant-bot` by default (database, workspace, skills, attachments, browser
profile, logs, backups). Set **`ANTBOT_HOME`** to point the daemon and CLI at a different data
directory, e.g. for a second profile or a test instance:

```bash
ANTBOT_HOME=/path/to/alt-home ./antbot start --port 4791
```

## First bot in 5 minutes

1. Open http://127.0.0.1:4780 and create a new Bot (sidebar → New). Give it a **name**, a
   **title**, and a real **job description** — not "General Helper." The description is durable:
   it becomes standing rules the Bot follows on every turn (e.g. "Never send external messages
   without approval. Always cite sources.").
2. Drop a file into the shared workspace so the Bot has something real to read:
   ```bash
   echo "Q3 numbers: revenue up 12%, churn down 2pts." > ~/.ant-bot/workspace/notes.txt
   ```
3. Message the Bot in its thread: *"Read `notes.txt` in the workspace and summarize it in two
   sentences."* You'll see the reply stream in as text, with a tool-activity card showing the
   `Read` call.
4. Ask it to do something that needs approval, e.g. *"Run `git log` in the workspace"* (allowed by
   default) vs. *"Install a package"* or *"curl an external API with POST data"* — those trip a
   built-in `require` rule and produce an **approval card** inline in the thread: tool name,
   human-readable summary, the exact raw input (collapsible), and Allow once / Deny / Always
   allow buttons. Nothing runs until you decide.
5. Restart the daemon (`antbot stop && antbot start`, or just `kill` and `start` again) — the
   conversation, the Bot's session, and its memory survive.

## Architecture

```
┌──────────────────────────────── Web UI (React, localhost:4780) ───────────────────────────────┐
│ Sidebar (roster, attention states) │ Thread view (messages, tool/approval cards, composer)     │
│ Computer view (screencast + takeover) │ Settings, Rules, Routines, Skills, Usage, Workspace     │
└───────────────▲───────────────────────────────────────────────▲───────────────────────────────┘
                │ REST (CRUD)                                   │ WebSocket (/api/events, deltas,
                │                                                │  approvals, screencast frames)
┌───────────────┴───────────────────────────────────────────────┴───────────────────────────────┐
│                              ant-bot daemon (Node, Fastify)                                    │
│                                                                                                 │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────┐  ┌───────────┐  ┌────────────────────┐  │
│  │ API layer  │  │ Bot Manager  │  │ Permission     │  │ Scheduler │  │ Event Bus (in-proc) │  │
│  │ (Fastify   │  │ (FIFO queue, │  │ Gateway        │  │ (node-cron│  │ → WS fanout, seq-   │  │
│  │  routes)   │  │  one turn    │  │ (rules.ts →    │  │  per      │  │  ordered            │  │
│  │            │  │  per bot at  │  │  optional Haiku│  │  routine, │  │                     │  │
│  │            │  │  a time)     │  │  review →      │  │  run      │  │                     │  │
│  │            │  │              │  │  approval card)│  │  history) │  │                     │  │
│  └────────────┘  └──────┬───────┘  └───────▲────────┘  └─────┬─────┘  └─────────────────────┘  │
│                         │ spawns          │ canUseTool       │ enqueues routine turns           │
│                  ┌──────▼─────────────────┴──────────────────────┐                              │
│                  │ Agent Session (Claude Agent SDK per turn)      │                              │
│                  │ system prompt = persona + job description +   │                              │
│                  │ memory + skills + roster; tools: fs/bash,      │                              │
│                  │ send_to_bot, remember, request_secret,         │                              │
│                  │ browser_* (via computer service)               │                              │
│                  └──────┬──────────────────────────────────────────┘                             │
│                         │                                                                         │
│  ┌──────────────────────▼───────────────┐   ┌──────────────────────────────────────────────┐    │
│  │ Computer service (packages/server/    │   │ Storage: SQLite (better-sqlite3, WAL) —      │    │
│  │  src/computer): Playwright persistent │   │ bots, threads, messages, approvals, rules,    │    │
│  │  profile, per-bot screen lock,        │   │ skills, routines, mailbox, usage, settings +  │    │
│  │  screencast, takeover                 │   │ ~/.ant-bot/workspace + attachments on disk    │    │
│  └────────────────────────────────────────┘   └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
            │ subscription auth: Claude Code CLI login (~/.claude), spawned per turn by the Agent SDK
```

Every tool call inside an Agent SDK turn is routed through `canUseTool`, which calls into the
Permission Gateway before the tool is allowed to run — this is true for the built-in tools
(`Bash`, `Read`, `Write`, `Edit`, `WebFetch`, ...), the custom `send_to_bot` / `remember` /
`request_secret` tools, and the `browser_*` tools alike.

## CLI commands

All commands are implemented in `packages/cli`. Run them as `./antbot <command>` from the repo
root, or as plain `antbot <command>` once it is [on your `PATH`](#putting-antbot-on-your-path).

| Command | Description |
|---|---|
| `start [--port N] [--open] [--foreground]` | Start the daemon (detached by default; `--open` opens the UI once healthy; `--foreground` keeps it attached to the current terminal) |
| `stop` | Stop the running daemon (only if it was started by the CLI and has a pidfile) |
| `restart [--port N]` | Stop the daemon and start it again |
| `status` | Show whether the daemon is running, its URL, version, data dir, and bot count |
| `doctor` | Diagnose the local environment: Node version, `claude` CLI + login, `ANTHROPIC_API_KEY`, data-dir permissions, port availability, `better-sqlite3` native module, Playwright Chromium |
| `open` | Open the UI in the default browser, starting the daemon first if it isn't running |
| `skill <add\|list\|remove>` | Manage the skills your bots can use |
| `backup [--out PATH]` | Write a `.tar.gz` of the database, `config.toml`, skills, and every bot's memory directory (excludes the browser profile and attachments) |
| `restore <path> [--yes]` | Restore a backup archive over `~/.ant-bot` (prompts for confirmation unless `--yes`) |
| `-h, --help` / `-v, --version` | Global help / CLI version |

Every command takes `--help`, e.g. `antbot start --help`.

## Project layout

| Path | What it is |
|---|---|
| `packages/shared` | Zod schemas + TypeScript types for every entity and API request/response, `LIMITS` constants, the WS event union — imported by both server and web |
| `packages/server` | The daemon: Fastify API + WS (`src/api`), Bot lifecycle and queue (`src/bots`), Agent SDK wrapper (`src/agent`), Permission Gateway + rules + secrets (`src/permissions`), scheduler/cron (`src/scheduler`), skills store (`src/skills`), browser/computer service (`src/computer`), SQLite layer (`src/db`), config + paths (`src/config`) |
| `packages/web` | React 19 + Vite UI: sidebar, thread view, approval cards, rules/settings/routines/usage screens, workspace browser, command palette |
| `packages/cli` | The `antbot` CLI: start/stop/restart/status/doctor/open/skill/backup/restore |
| `skills/` | The skills that ship with ant-bot — `bug-repro`, `deep-research`, `inbox-digest`, `skill-author`, `weekly-report` — plus `SPEC.md`, the Agent Skills spec they all conform to. Installed into `~/.ant-bot/skills` on every start and refreshed on upgrade unless you have edited or deleted your copy |
| `computer/` | Placeholder for an optional containerized "computer" image — **not implemented** (see Status below) |
| `docs/` | This plan, the design-doctrine outline it's translated from, and the frozen API contract |

## Testing

Each package uses Vitest. Run all of them from the repo root with `pnpm test`, or per package:

```bash
pnpm --filter @antbot/shared test
pnpm --filter @antbot/server test
pnpm --filter @antbot/web test
pnpm --filter @antbot/cli test
```

Current totals, as run against this checkout:

| Package | Test files | Tests |
|---|---|---|
| `@antbot/shared` | 1 | 19 |
| `@antbot/server` | 19 | 450 |
| `@antbot/web` | 7 | 49 |
| `@antbot/cli` | 7 | 114 |
| **Total** | **34** | **632** |

## Status / not built

Honestly, as of this checkout:

- **Container computer mode** — `computer.mode` is a valid `"host" | "container"` setting in the
  schema and shows up in Settings, but only `host` mode has an implementation; the `computer/`
  directory in the repo is an empty placeholder. There is no container image, and selecting
  `container` does not change daemon behavior.
- **Teach-by-demonstration** — not implemented. There is no trace recording, no draft-skill-from-
  recording flow, and no "Teach a task" UI affordance anywhere in the codebase.
- **Event-trigger webhooks** — not implemented. Routines only fire on a cron schedule
  (`node-cron`, timezone-aware) or via a manual test run; there is no `/api/hooks/:routineKey`
  route, no HMAC verification, and no file-watch trigger in the server source.
- **OS notification wiring** — the `Settings.notificationsEnabled` flag and a per-bot
  `notifications` toggle exist and are persisted, and the scheduler publishes a `notify` event
  over the bus (e.g. the away-guard "still away?" prompt) for the UI to render, but there is no
  OS-level notification integration (no `node-notifier` or platform notification call anywhere in
  the server source) — attention state is currently in-app only.
- **Mobile / iOS** — no native app; the web UI is responsive but there is no dedicated mobile
  client or push delivery path.
- **Multi-user / teams** — single local user only; there is no authentication, no accounts, and no
  team administration. See `docs/SECURITY.md` for what that implies.

The `Settings.localExecution` field (`ask | always | never`) maps the Grok Bot "cloud computer vs.
your machine" split onto a path boundary, since ant-bot has only one physical machine: the
workspace is the Bots' computer, and a tool call reaching outside it is denied (`never`), forced
to a human approval (`ask`, the default), or left to normal rule evaluation (`always`). The check
runs ahead of `allow` rules, so a broad rule can't unlock it. Bash reach detection is a
conservative heuristic, not a sandbox — see `docs/SECURITY.md` for what it does and does not
catch.
