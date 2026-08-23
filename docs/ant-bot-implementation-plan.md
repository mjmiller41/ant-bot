# ant-bot — Implementation Plan

> A local-first Grok Bot analog: persistent, named Claude agents ("Bots") that run on your own
> machine, do real work in real tools, message each other, and run on schedules — powered by the
> **Claude Agent SDK / Claude Code CLI** so usage draws from an **Anthropic subscription**
> (Pro/Max) instead of metered API keys.
>
> Companion to [grok-bot-system-outline.md](./grok-bot-system-outline.md). Section references like
> *(outline §5)* point there.
>
> **Audience:** an Opus 5 orchestrator that will decompose this plan into work packages and assign
> them to smaller models (Sonnet 5, Haiku 4.5). Every work package below carries its own contract,
> acceptance criteria, and a suggested worker-model tier.

---

## 1. Product definition

### What we are building

**ant-bot** is a locally-running daemon + web UI that hosts a roster of persistent, named Claude
agents. Each Bot has a job description, its own conversation thread, durable memory, enabled
skills, and scheduled routines. All Bots share one "agent computer" — the local machine (optionally
a sandboxed container) with a shared `/workspace`, a persistent browser profile, and a terminal.
You message Bots like teammates from a browser tab at `localhost`; they work in the background,
pass work to each other, and come back when something needs your approval.

### Translation table: Grok Bot → ant-bot

| Grok Bot concept (outline §) | ant-bot equivalent |
|---|---|
| Cloud VM per user (§5) | Local daemon; work area is the host, or an optional Podman/Docker "computer" container with a persistent volume |
| Grok model, fixed routing (§11) | Claude via Agent SDK; fixed per-surface routing: Sonnet for turns, Opus escalation, Haiku for auto-review/summaries |
| Cursor account auth (§2) | Claude Code CLI login (`claude` OAuth / `claude setup-token`) → subscription usage |
| Desktop + iOS apps (§2) | Web UI on `localhost:4780` (usable from phone over Tailscale/LAN); OS notifications |
| Connectors/Plugins = MCP (§5) | MCP servers configured per-account, attachable per-Bot |
| Agent Computer view + takeover (§5) | Live browser screencast (Playwright CDP) + "take over" via noVNC or a headed browser window |
| Auto Review (§9) | Deterministic rules engine + optional Haiku-based reviewer; Require-beats-Allow precedence |
| Skills / Routines (§8) | Markdown skill files (Claude Code skill format) + node-cron scheduler with run history |
| Teach a task (§8) | Playwright trace recording → Claude drafts a skill (late-phase, optional) |
| Secure secret request (§5) | OS keychain via `keytar`/`secret-service`; env-injection into tools; never enters the transcript |

### Non-goals (v1)

- Multi-user / teams administration (outline §11) — single local user only.
- Native mobile apps — responsive web UI instead.
- Voice input, reactions-as-signal, avatar generation.
- Windows support (target Linux + macOS first; Windows later via WSL2).

### Honest boundaries we inherit deliberately (outline §15)

- Bots are **not** a security boundary — they share the computer, workspace, browser profile, and
  credentials. Say so in the UI, as Grok Bot's docs do.
- Approvals gate **proposed** actions, never reverse completed ones.
- Memory is working preference, not a source of truth.
- Persistent environment (filesystem + browser profile + sessions) over persistent prompt.

---

## 2. Key technical decisions (locked)

These are decided now so workers never re-litigate them.

1. **Language/runtime:** TypeScript on Node 24 LTS, ESM, pnpm workspaces monorepo.
2. **Agent runtime:** `@anthropic-ai/claude-agent-sdk`. It spawns the Claude Code CLI under the
   hood, so an existing `claude` subscription login authenticates every session — this is the
   entire "use the Anthropic subscription" mechanism. No raw API key required; if
   `ANTHROPIC_API_KEY` is present it is *ignored on purpose* unless the user opts into API billing
   in settings.
3. **Session persistence:** the SDK's session resume (`resume: sessionId`) is the Bot's live
   context; our own SQLite message log is the durable transcript of record. A Bot's "memory" is a
   markdown directory injected via the system prompt, in the pattern of Claude Code's memory dirs.
4. **Storage:** SQLite via `better-sqlite3` (WAL mode). One DB file at
   `~/.ant-bot/antbot.db`. Attachments and workspace live on disk, not in the DB.
5. **Server:** Fastify + `@fastify/websocket`. REST for CRUD, WebSocket for streaming events
   (message deltas, tool activity, approval requests, screencast frames).
6. **Frontend:** React 19 + Vite + Tailwind. No SSR — it's a local tool. State via Zustand;
   server events over one WS connection.
7. **Scheduler:** `node-cron` inside the daemon; timezone from settings; run records in SQLite.
8. **Browser computer-use:** Playwright with a **persistent browser context** at
   `~/.ant-bot/browser-profile` (shared logins, like Grok Bot's shared browser). Screencast via
   CDP `Page.startScreencast` → JPEG frames over WS. Takeover = launch headed window on the same
   profile (v1) → embedded noVNC (v2).
9. **Sandbox mode (optional):** a Podman/Docker image (`ant-bot-computer`) containing Node,
   Chromium, and common CLIs, with `/workspace` volume-mounted. Config flag
   `computer.mode: "host" | "container"`. Host mode is the default and ships first.
10. **Model routing (fixed per surface, like Grok Bot §11):**
    | Surface | Model |
    |---|---|
    | Bot conversation turns | `sonnet` (per-Bot opt-in `opus` escalation flag) |
    | Auto-review / action classification | `haiku` |
    | Thread titles, summaries, memory distillation | `haiku` |
    | Routine runs | same as Bot turns |
    No user-facing model picker beyond the per-Bot escalation flag.
11. **Concurrency limiter:** subscription rate limits are shared, so the daemon enforces
    `maxConcurrentSessions` (default **2**) with a FIFO queue; routines wait behind interactive
    turns. Usage (tokens per turn, per Bot, per day) is recorded from SDK result messages.
12. **Ports/paths:** daemon on `127.0.0.1:4780`; data root `~/.ant-bot/`; shared workspace
    `~/.ant-bot/workspace/` (symlink-friendly); config `~/.ant-bot/config.toml`.

---

## 3. Architecture

```
┌──────────────────────────────── Web UI (React, localhost:4780) ───────────────────────────────┐
│ Sidebar (Bots, groups, attention states) │ Thread view (messages, tool cards, approval cards) │
│ Agent Computer view (screencast + takeover) │ Settings (rules, plugins/MCP, usage, routines)  │
└───────────────▲───────────────────────────────────────────────▲───────────────────────────────┘
                │ REST (CRUD)                                   │ WebSocket (events, deltas, frames)
┌───────────────┴───────────────────────────────────────────────┴───────────────────────────────┐
│                                     ant-bot daemon (Node)                                     │
│                                                                                               │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────┐  ┌───────────┐  ┌─────────────────────┐  │
│  │ API layer  │  │ Bot Manager  │  │ Permission     │  │ Scheduler │  │ Event Bus (in-proc) │  │
│  │ (Fastify)  │  │ (lifecycle,  │  │ Gateway        │  │ (cron,    │  │ msg deltas, tool    │  │
│  │            │  │  queue, one  │  │ (rules engine, │  │  run      │  │ activity, approvals,│  │
│  │            │  │  session per │  │  Haiku review, │  │  records) │  │ attention states    │  │
│  │            │  │  Bot)        │  │  approval UX)  │  │           │  │                     │  │
│  └────────────┘  └──────┬───────┘  └───────▲───────┘  └─────┬─────┘  └─────────────────────┘  │
│                         │ spawns           │ canUseTool     │ enqueues turns                  │
│                  ┌──────▼──────────────────┴──────────────────────┐   ┌────────────────────┐  │
│                  │ Agent Session (Claude Agent SDK per Bot turn)  │   │ Inter-Bot Mailbox  │  │
│                  │ system prompt = base + profile + memory + rules │  │ (async messages,   │  │
│                  │ tools: fs, bash, MCP servers, browser_* custom │   │ wakes recipient)   │  │
│                  └──────┬─────────────────────────────────────────┘   └────────────────────┘  │
│                         │                                                                     │
│  ┌──────────────────────▼───────────────┐   ┌──────────────────────────────────────────────┐  │
│  │ Computer service                     │   │ Storage: SQLite (bots, threads, messages,    │  │
│  │ Playwright persistent profile,       │   │ approvals, rules, skills, routines, runs,    │  │
│  │ screencast, takeover, per-Bot pages  │   │ usage) + ~/.ant-bot/workspace + attachments  │  │
│  └──────────────────────────────────────┘   └──────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
            │ subscription auth: Claude Code CLI login (~/.claude), spawned by the Agent SDK
```

### The Bot turn lifecycle (state machine, used everywhere)

```
idle ──(user msg | bot msg | routine fire)──▶ queued ──(slot free)──▶ running
running ──(canUseTool needs human)──▶ waiting_approval ──(allow/deny)──▶ running
running ──(agent asks user)──▶ waiting_input ──(user reply)──▶ queued
running ──(turn complete)──▶ idle          running ──("Stop now")──▶ interrupted ──▶ idle
```

Attention states derive from this: `waiting_approval|waiting_input` → **Needs attention**;
turn completed since last read → **Unread activity** (outline §10).

### How a message becomes work

1. UI POSTs message → stored in `messages`, event on bus, Bot turn enqueued.
2. Bot Manager acquires a session slot, builds the prompt (new SDK `query()` with
   `resume` if a session exists), streams events.
3. Every tool call passes the **Permission Gateway**: deterministic rules → (optional) Haiku
   review → else approval card to the UI; `Require Approval` always beats `Always Allow`.
4. Tool activity, file artifacts, and text deltas stream to the thread as cards.
5. On completion: usage recorded, attention state set, OS notification if enabled, memory-update
   hook optionally distills durable facts (Haiku) into the Bot's memory dir.

### Inter-Bot messaging (outline §6)

A custom SDK tool `send_to_bot(bot_slug, message)` writes to the `mailbox` table and enqueues a
turn for the recipient with the message as input, tagged with provenance (`from_bot`). Group chats
are threads with `member_bot_ids`; a group turn runs a cheap Haiku "router" pass that picks the
owning Bot(s) for the message unless the user `@`-mentioned one explicitly. One-owner-per-stage is
enforced socially (prompting), not mechanically — same as Grok Bot.

---

## 4. Data model (SQLite, authoritative)

Workers implement exactly this; migrations in `packages/server/src/db/migrations/`.

```sql
bots(id, slug UNIQUE, name, title, description, avatar_emoji, model_tier DEFAULT 'sonnet',
     pinned INT, hidden INT, notifications INT, session_id, created_at, deleted_at)
threads(id, kind CHECK(kind IN ('dm','group')), title, member_bot_ids JSON, created_at)
messages(id, thread_id, author_kind CHECK(author_kind IN ('user','bot','system')), author_bot_id,
         reply_to_id, content_md, cards JSON, created_at)          -- cards: tool/file/approval refs
attachments(id, message_id, path, mime, bytes, created_at)
approvals(id, bot_id, thread_id, tool_name, input_summary, raw_input JSON,
          status CHECK(status IN ('pending','allowed','denied','expired')),
          decided_by CHECK(decided_by IN ('user','rule','auto_review')), rule_id, created_at, decided_at)
rules(id, kind CHECK(kind IN ('require','allow')), tool_pattern, input_pattern, scope_note,
      enabled INT, created_at)
skills(id, slug UNIQUE, name, path, source CHECK(source IN ('user','taught','imported')), created_at)
bot_skills(bot_id, skill_id, enabled INT, PRIMARY KEY(bot_id, skill_id))
routines(id, bot_id, name, cron_expr, timezone, instruction_md, enabled INT, created_at)
routine_runs(id, routine_id, started_at, finished_at,
             status CHECK(status IN ('ok','failed','interrupted')), summary, thread_id)
mailbox(id, from_bot_id, to_bot_id, content_md, delivered INT, created_at)
usage(id, bot_id, turn_id, model, input_tokens, output_tokens, cache_read_tokens, cost_estimate,
      created_at)
settings(key PRIMARY KEY, value JSON)
```

Limits enforced in the service layer (mirroring outline §13): ≤50 Bots+groups, 2–6 Bots per group,
≤50 routines/Bot, keep 20 most recent `routine_runs` per routine, ≤6 attachments per message,
25 MB/attachment (200 MB video).

---

## 5. API contract (frozen before parallel work starts)

`packages/shared/src/api.ts` defines all types; server and web both import it. Summary:

```
REST  /api/bots                GET/POST         /api/bots/:id          GET/PATCH/DELETE
      /api/bots/:id/duplicate  POST             /api/threads           GET/POST
      /api/threads/:id/messages GET/POST        /api/messages/:id/stop POST
      /api/approvals/:id       POST {decision, alwaysRule?}
      /api/rules               GET/POST/DELETE  /api/skills            GET/POST/DELETE
      /api/bots/:id/skills     PUT              /api/routines          CRUD + /test-run POST
      /api/attachments         POST (multipart) /api/usage             GET
      /api/computer/screencast/:botId  WS       /api/computer/takeover POST/DELETE
      /api/search?q=           GET              /api/settings          GET/PATCH
WS    /api/events   — server→client: message.delta, message.card, bot.state, approval.pending,
                      routine.run, usage.tick, notify
```

Every server→client event carries `{threadId, botId, seq}` so the UI can order and reconcile.

---

## 6. Repository layout

```
ant-bot/
├── docs/                          # this plan + the outline + ADRs
├── packages/
│   ├── shared/                    # types, API contract, zod schemas, constants/limits
│   ├── server/                    # daemon: api/, bots/, permissions/, scheduler/, computer/,
│   │   └── src/                   #   mailbox/, skills/, db/{schema,migrations}, usage/
│   ├── web/                       # React UI
│   └── cli/                       # `antbot` — start/stop daemon, doctor, backup, open UI
├── computer/                      # optional container image (Dockerfile, entrypoint)
├── skills-examples/               # starter skills (weekly-report, bug-repro, inbox-digest)
└── package.json  pnpm-workspace.yaml  turbo.json
```

---

## 7. Orchestration protocol (how the Opus orchestrator should run this plan)

1. **Contracts first.** M0 produces `shared` types, DB schema, and the API contract. Nothing else
   starts until M0 is merged. After that, milestones parallelize along the dependency graph below.
2. **One work package = one worker session.** Give the worker: this file's relevant section, the
   contract files, the acceptance criteria verbatim, and the repo's lint/test commands. Workers do
   not modify `shared` without an orchestrator-approved contract change.
3. **Model assignment discipline.** `haiku` for CRUD, boilerplate, tests-from-spec, UI leaf
   components. `sonnet` for stateful logic, streaming, Playwright, nontrivial React. Orchestrator
   (Opus) itself writes or reviews: the Permission Gateway, the Agent Session wrapper, and every
   integration checkpoint. When a worker stalls twice, escalate the package one tier.
4. **Acceptance = executable.** Every WP lists checks; the orchestrator runs them
   (`pnpm test --filter <pkg>`, plus the listed manual smoke) before marking done.
5. **Integration checkpoints** (orchestrator-run, end of each milestone): boot the daemon, run the
   scripted E2E for that milestone (listed per milestone), fix drift before opening the next one.
6. **Safety review gate.** Before M2 merges, orchestrator red-teams the Permission Gateway:
   attempt to send email/delete files/run curl-pipe-sh through a Bot and verify each is stopped by
   default rules.

### Dependency graph

```
M0 ──▶ M1 ──▶ M2 ──▶ M4 ──▶ M5
        │      └────▶ M3 ─┘ │
        └────────────▶ M6 ──┴─▶ M7 ──▶ M8
(M3 needs M1; M6 needs M2's gateway; M5 needs M2+M4; M7 needs everything prior)
```

---

## 8. Milestones and work packages

Format: **WP-id · name — worker model · size (S/M/L)** — deliverable → acceptance.

### M0 — Foundations (contracts, scaffold) — *sequential, ~1 orchestrator day*

- **WP-0.1 · Monorepo scaffold — haiku · S** — pnpm workspaces, TS config, ESLint/Prettier,
  Vitest, turbo pipeline, CI script. → `pnpm build && pnpm test` green on empty packages.
- **WP-0.2 · Shared contract — sonnet · M** — `packages/shared`: zod schemas + TS types for every
  entity in §4, API request/response types for §5, `LIMITS` constants, event union type.
  → type-checks; zod round-trips sample fixtures.
- **WP-0.3 · DB layer — sonnet · M** — better-sqlite3 wrapper, migration runner, schema from §4,
  repository classes per table with limit enforcement. → unit tests: CRUD each entity; limits
  rejected with typed errors; WAL enabled.
- **WP-0.4 · Config + paths — haiku · S** — `~/.ant-bot/config.toml` loader (zod-validated),
  defaults from §2, data-dir bootstrap. → doctor-style test: fresh home dir → dirs created,
  defaults written.
- **WP-0.5 · CLI skeleton — haiku · S** — `antbot start|stop|status|doctor|open`. `doctor` checks:
  Node ≥24, `claude` CLI on PATH and logged in (`claude auth status` equivalent), Playwright
  browsers installed, ports free. → doctor reports each check with a fix hint.

### M1 — Single-Bot core loop (talk to one Claude Bot in the UI)

- **WP-1.1 · Agent Session wrapper — ORCHESTRATOR (Opus) · L** — the heart. Wraps Agent SDK
  `query()`: builds system prompt (base persona + Bot profile + memory dir + standing rules),
  passes `resume` for continuity, exposes an async event stream (text deltas, tool starts/results,
  completion with usage), supports interrupt ("Stop now"), records `session_id` back to the Bot
  row. Configurable `permissionCallback` slot (M2 plugs in here; M1 uses "ask user for
  everything"). → integration test with a live `claude` login: turn runs, resumes with prior
  context, interrupt works, usage captured.
- **WP-1.2 · Bot Manager + queue — sonnet · M** — lifecycle from §3's state machine, FIFO slot
  queue (`maxConcurrentSessions`), turn provenance (user/bot/routine), attention-state
  computation. → unit tests with a mocked session: queueing, interrupts, state transitions.
- **WP-1.3 · Fastify API + WS event bridge — sonnet · M** — routes from §5 for bots/threads/
  messages/stop; in-proc event bus → WS fanout with `seq` ordering. → supertest suite; WS
  integration test sees deltas for a mocked turn.
- **WP-1.4 · Web shell + thread view — sonnet · L** — sidebar (roster, pinned/hidden, attention
  badges), thread view with streaming markdown, tool-activity cards, composer, stop button,
  keyboard shortcut Cmd/Ctrl+N → new Bot dialog. → manual smoke vs mocked server; Playwright UI
  test: send message, see streamed reply.
- **WP-1.5 · Bot CRUD UI — haiku · M** — create/edit profile (name, title, description, emoji
  avatar), pin/hide/unhide, duplicate (profile+skills+routines, not history — outline §4),
  delete with the "files and logins survive deletion" warning. → UI tests per operation.
- **WP-1.6 · Memory subsystem — sonnet · M** — per-Bot memory dir
  `workspace/bots/<slug>/memory/*.md` injected into the system prompt; post-turn Haiku
  distillation hook ("did anything durable change?") appending/editing memory files; memory
  viewer/editor in Bot settings. → test: correction in chat surfaces in memory file; user can
  edit/delete memory in UI.

**M1 E2E checkpoint:** create Bot "Scout" → ask it to summarize a file in `/workspace` → streamed
answer with a file card → restart daemon → conversation and context survive.

### M2 — Permission Gateway (approvals, rules, auto-review)

- **WP-2.1 · Rules engine — sonnet · M** — deterministic matcher over `(tool_name, input)` with
  glob/regex patterns; precedence: `require` > `allow` > default-ask; ships with **default
  require rules** for: external sends (mail/HTTP POST beyond localhost), deletes/overwrites
  outside `/workspace`, package installs, `sudo`, purchases (heuristic keywords), git push.
  → table-driven unit tests incl. precedence conflicts (Require wins — outline §9).
- **WP-2.2 · Approval flow — sonnet · M** — `canUseTool` implementation: consult rules → if
  auto-review enabled, Haiku classifies (`allow_ok | needs_human | deny_suggested`) — Haiku can
  never green-light past a `require` rule → else create `approvals` row, emit `approval.pending`,
  block the turn (`waiting_approval`), resolve on decision; "Always allow" decision persists a
  narrow rule scoped to tool+pattern. Timeout → `expired` + turn continues as denied.
  → integration: mocked tool triggers card; allow/deny/always paths verified.
- **WP-2.3 · Approval UI — haiku · M** — card shows tool, human-readable summary, exact raw input
  (collapsible), Allow once / Deny / Always allow-with-scope; rules manager screen (list, add,
  disable, delete). → UI tests; a denied action shows denial in-thread.
- **WP-2.4 · Secrets service — sonnet · M** — keychain-backed store (`keytar`; libsecret on
  Linux); "secure secret request" flow: Bot calls `request_secret(name, reason)` tool → UI modal →
  value stored in keychain and injected as env/config for the target tool, **never** into the
  transcript or model context; masked audit entry only. → test: secret round-trips to keychain;
  transcript contains no plaintext; model context assertion.
- **WP-2.5 · Red-team pass — ORCHESTRATOR · S** — scripted adversarial prompts (send external
  email, `rm -rf`, curl-pipe-sh, exfil a secret to a URL) must each hit a require rule or an
  approval card. → all attempts blocked; findings fixed before merge.

### M3 — Files, attachments, artifacts

- **WP-3.1 · Attachment pipeline — sonnet · M** — multipart upload → `~/.ant-bot/attachments/`,
  size/count limits from §4, mime sniffing, paths handed to the session as readable files;
  paste-image support. → limit violations rejected with clear errors; agent can read an uploaded
  CSV.
- **WP-3.2 · Artifact cards + previews — sonnet · M** — files the agent creates/edits in
  `/workspace` during a turn are detected (fs watch scoped to the turn) and rendered as cards:
  preview for md/txt/csv/images/pdf(first page), download, open-in-folder. → turn that writes
  `report.md` yields a card with preview.
- **WP-3.3 · Workspace browser — haiku · M** — read-only tree of `/workspace` in the UI with
  per-Bot folder conventions (`workspace/projects/...`, `workspace/bots/<slug>/`), open/download.
  → renders 1k files without jank; hidden dotfiles toggle.

**M3 checkpoint:** attach expense CSV + policy PDF → Bot returns reconciliation `.md` +
new `.csv` as cards, originals untouched.

### M4 — Multi-Bot: mailbox and group chats

- **WP-4.1 · Inter-Bot mailbox — sonnet · M** — `send_to_bot` SDK tool; recipient turn enqueued
  with provenance; handoff rendered in both threads ("→ handed to @writer"); cycle guard
  (max chained bot-to-bot hops per root task, default 5; then require human).
  → test: bot A message wakes bot B; hop limit stops runaway ping-pong.
- **WP-4.2 · Group chats — sonnet · L** — group thread (2–6 Bots), Haiku router picks
  responder(s) unless `@`-mentioned, `@everyone` fans out sequentially, group transcript
  interleaves all parties, membership editing. Bot→group posts are text+file-path (files go via
  workspace, mirroring Grok Bot's text-only handoff caveat pragmatically). → scripted
  researcher/writer/reviewer relay completes with the user only kicking off.
- **WP-4.3 · Mentions & slash composer — haiku · M** — `@` popover (bots/groups/routines/MCP
  servers), `/` popover (enabled skills), inserted as structured tokens the server resolves.
  → tokens resolve correctly in the dispatched prompt.

### M5 — Skills, routines, scheduler

- **WP-5.1 · Skills store — sonnet · M** — skill = directory with `SKILL.md` (frontmatter: name,
  when-to-use, required access, sequence, validation, return format, approval boundaries — the
  6-part shape from outline §8) under `~/.ant-bot/skills/`; per-Bot enable flags; injected as
  Claude Code skills for the session; "save this process as a skill" flows through a
  `save_skill` tool with user confirmation. → Bot saves a skill from a completed task; another
  Bot with it enabled uses it via `/`.
- **WP-5.2 · Scheduler + routines — sonnet · L** — node-cron per enabled routine (timezone from
  settings), fires a turn on the owning Bot with `instruction_md`, records `routine_runs`
  (keep 20), routine turns queue **behind** interactive turns, failure summarization, pause-all
  switch, "away >7 days → ask whether to keep routines running, pause on no answer" (outline §8).
  → fake-timer tests for fire/record/prune; failed run shows red in history.
- **WP-5.3 · Routines UI + test run — haiku · M** — per-Bot routines panel: create (Bot proposes
  cron from natural language via Haiku), enable/pause, edit, delete, run history, **Test run**
  with the "performs real work" warning. → full CRUD + test-run E2E against a stub routine.
- **WP-5.4 · Event triggers (stretch) — sonnet · M** — generic webhook trigger
  (`POST /api/hooks/:routineKey` with HMAC) + file-watch trigger; narrow-match guidance in UI.
  → webhook with valid signature fires routine; invalid rejected.

**M5 checkpoint:** teach "weekly report" as a skill → schedule Mon 08:00 → test run produces the
report in-thread and a run record.

### M6 — The computer: browser use, screencast, takeover

- **WP-6.1 · Browser service — sonnet · L** — Playwright persistent context on the shared
  profile; per-Bot page ("screen"), one computer-use task per Bot at a time (outline §13);
  exposed to sessions as MCP-style tools (`browser_navigate/click/type/read/screenshot`) that all
  route through the Permission Gateway. → two Bots browse in parallel on separate pages; shared
  login persists across restarts.
- **WP-6.2 · Screencast — sonnet · M** — CDP screencast → JPEG frames over WS
  (`/api/computer/screencast/:botId`), ~4 fps, auto-pause when no viewer. → live view of a Bot
  navigating; bandwidth bounded.
- **WP-6.3 · Takeover — sonnet · M** — "Take over" pauses the Bot's page-driving, opens a headed
  Chromium window on the same profile for the human step (password/2FA/CAPTCHA — outline §5);
  "Return control" resumes with "continue from the current page". UI copy: never paste secrets
  into chat. → human logs into a test site during takeover; Bot continues authenticated.
- **WP-6.4 · Container computer mode (optional) — sonnet · L** — `computer/` image (Chromium,
  Node, common CLIs), `/workspace` volume, daemon drives it via CDP over the container network;
  `Update/Recover/Reset` maintenance actions mapping to rebuild-preserving-volume /
  recreate / restore-snapshot (outline §5 semantics). → toggling `computer.mode=container`
  passes the M6 checkpoint unchanged.

**M6 checkpoint:** "Open Hacker News, find today's top Show HN, save summary + screenshot to
workspace" — watched live, artifact cards produced.

### M7 — Notifications, search, settings, usage

- **WP-7.1 · Notifications — haiku · M** — OS notifications (`node-notifier`) on
  needs-attention/turn-complete per-Bot toggle; suppressed while tab focused; unread badges;
  optional ntfy.sh/webhook push for phones. → matrix test of toggle × focus states.
- **WP-7.2 · Search + command palette — sonnet · M** — SQLite FTS5 over messages/files/routines;
  Cmd/Ctrl+K palette: jump to Bot/thread/message, run actions. → search hits deep-link to the
  right scroll position.
- **WP-7.3 · Usage metering UI — haiku · M** — per-turn token capture already in M1; dashboard:
  tokens/day per Bot, model split, estimated subscription pressure, soft daily budget with
  routine-pausing at threshold. → usage rows accumulate; budget pause fires in test.
- **WP-7.4 · Settings screens — haiku · M** — general (timezone, concurrency, theme), MCP
  servers manager (add/remove/auth-status per server, per-Bot attach), rules, secrets list
  (names only), maintenance actions. → settings persist and take effect without restart where
  feasible.

### M8 — Hardening and release

- **WP-8.1 · Recovery & backups — sonnet · M** — `antbot backup` (DB + memory + skills tarball,
  excludes browser profile), startup integrity check, least-destructive-first recovery doc
  (restart → resume sessions → rebuild browser profile → restore backup — outline §14).
  → kill -9 mid-turn: daemon restarts clean, thread intact, turn marked interrupted.
- **WP-8.2 · E2E suite — sonnet · L** — Playwright suite covering all milestone checkpoints +
  the M2 red-team script, runnable headless in CI (agent mocked) and live (agent real, tagged).
  → green in CI.
- **WP-8.3 · Docs — haiku · M** — README, getting-started (install → `claude` login →
  `antbot start` → first Bot in 5 minutes), security model page (shared-computer boundary,
  approval semantics — honest, per outline §15), skills authoring guide. → a fresh user path
  works as written.
- **WP-8.4 · Teach-a-task (stretch) — sonnet · L** — record a Playwright trace of a human-driven
  session (10-min cap), Claude (sonnet) drafts a `SKILL.md` from the trace, user reviews/edits,
  test-run before enabling. → demo: record a 2-step web workflow → draft skill → successful
  test run.

---

## 9. Subscription usage: mechanics and guardrails

- **Auth:** the daemon never holds Anthropic credentials. The Agent SDK spawns the `claude` CLI,
  which uses the user's existing OAuth login (Pro/Max). `antbot doctor` verifies login and warns
  if `ANTHROPIC_API_KEY` is set (would silently switch billing) — we scrub it from the session
  env unless `billing.mode = "api"`.
- **Rate-limit citizenship:** subscription limits are account-wide and shared with the user's own
  Claude Code use. Hence: `maxConcurrentSessions` default 2; routines yield to interactive turns;
  exponential backoff on 429/overload with the Bot surfacing "waiting for capacity" in-thread;
  soft daily token budget that pauses routines first, then warns.
- **Cost shape:** Sonnet default keeps turns cheap; Haiku handles all high-frequency small calls
  (routing, review, titles, memory distillation); Opus is per-Bot opt-in only.

## 10. Security posture (v1, stated honestly)

- Single-user, localhost-bound by default; no auth on the API in v1 → document that exposing the
  port = full control of the machine's agent. LAN/phone access only via Tailscale or SSH tunnel.
- Bots share the computer, workspace, browser profile, and keychain-mediated secrets — **Bots are
  not a security boundary** (inherited deliberately; the UI says so on Bot creation).
- Default require-rules (WP-2.1) put sending, publishing, purchasing, deleting-outside-workspace,
  installs, sudo, and git-push behind approval out of the box.
- Secrets never transit the model context (WP-2.4). Takeover, not transcription, for passwords,
  2FA, CAPTCHAs.
- Container computer mode (WP-6.4) is the upgrade path for real isolation of tool execution.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agent SDK session-resume behavior changes across CLI versions | Pin CLI + SDK versions; `doctor` checks compatibility; own transcript in SQLite is the fallback context source |
| Subscription rate limits throttle multi-Bot use | Concurrency 2, queueing, backoff, budget pause; document Max plan as recommended |
| Long-lived sessions grow beyond context | Rely on SDK compaction + per-Bot memory distillation; "new thread, same Bot" affordance |
| Playwright detected/blocked by sites | Persistent real profile helps; takeover is the sanctioned fallback (never bypass checks — outline §5) |
| Permission gateway bypass via bash (`curl` inside a script) | Gateway inspects bash commands too (pattern rules on command strings); red-team WP-2.5 is a merge gate |
| Runaway bot-to-bot loops burning usage | Hop cap (WP-4.1), budget pause (WP-7.3) |
| Linux keychain variance | `keytar`→libsecret with encrypted-file fallback (clearly labeled weaker) |

## 12. Suggested build order summary

| Phase | Milestones | Outcome |
|---|---|---|
| 1 | M0 + M1 | Talk to one persistent Bot locally on subscription auth |
| 2 | M2 + M3 | Safe tool use with approvals; real file deliverables |
| 3 | M4 + M5 | Multi-Bot handoffs, group chats, skills, scheduled routines |
| 4 | M6 | Browser computer-use with live view and takeover |
| 5 | M7 + M8 | Notifications, search, usage, hardening, docs, stretch teach-a-task |

Each phase ends usable — phase 1 alone is already "a named Claude teammate with memory that
survives restarts," which is the smallest thing worth dogfooding.
