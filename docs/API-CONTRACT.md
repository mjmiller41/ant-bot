# ant-bot HTTP + WS contract (FROZEN — do not change without orchestrator approval)

Base: `http://127.0.0.1:4780`. All JSON. All types imported from `@antbot/contract`.
Errors: `{ error: string, code?: string }` with 4xx/5xx.

## REST

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | – | `{ ok: true, seq: number }` |
| GET | `/api/bots` | – | `RosterEntry[]` (`{bot, thread, lastMessageAt}`) |
| POST | `/api/bots` | `CreateBotRequest` | `Bot` |
| GET | `/api/bots/:id` | – | `Bot` |
| PATCH | `/api/bots/:id` | `UpdateBotRequest` | `Bot` |
| DELETE | `/api/bots/:id` | – | `{ ok: true }` |
| POST | `/api/bots/:id/duplicate` | – | `Bot` |
| GET | `/api/bots/:id/memory` | – | `{ name, content }[]` |
| PUT | `/api/bots/:id/memory` | `{ name, content }` | `{ ok: true }` |
| DELETE | `/api/bots/:id/memory/:name` | – | `{ ok: true }` |
| GET | `/api/bots/:id/skills` | – | `Skill[]` (enabled for this bot) |
| PUT | `/api/bots/:id/skills` | `{ skillIds: string[] }` | `{ ok: true }` |
| GET | `/api/threads` | – | `Thread[]` |
| POST | `/api/threads` | `CreateThreadRequest` | `Thread` |
| GET | `/api/threads/:id` | – | `ThreadWithMessages` |
| POST | `/api/threads/:id/messages` | `PostMessageRequest` | `Message` (the user's message) |
| POST | `/api/threads/:id/read` | – | `{ ok: true }` |
| DELETE | `/api/threads/:id` | – | `{ ok: true }` |
| POST | `/api/bots/:id/stop` | – | `{ stopped: boolean }` |
| GET | `/api/approvals` | – | `Approval[]` (pending) |
| POST | `/api/approvals/:id` | `ApprovalDecisionRequest` | `Approval` |
| GET | `/api/rules` | – | `Rule[]` |
| POST | `/api/rules` | `CreateRuleRequest` | `Rule` |
| PATCH | `/api/rules/:id` | `{ enabled: boolean }` | `Rule` |
| DELETE | `/api/rules/:id` | – | `{ ok: true }` |
| GET | `/api/skills` | – | `Skill[]` |
| POST | `/api/skills` | `CreateSkillRequest` | `Skill` |
| POST | `/api/skills/install` | `{ source: string }` | `{ installed: Array<{ skill: Skill, executables: string[], manifest: string, replaced: boolean }> }` |
| GET | `/api/skills/:id` | – | `Skill & { bodyMd: string }` |
| DELETE | `/api/skills/:id` | – | `{ ok: true }` |
| GET | `/api/routines?botId=` | – | `Routine[]` |
| POST | `/api/routines` | `CreateRoutineRequest` | `Routine` |
| PATCH | `/api/routines/:id` | partial routine | `Routine` |
| DELETE | `/api/routines/:id` | – | `{ ok: true }` |
| GET | `/api/routines/:id/runs` | – | `RoutineRun[]` |
| POST | `/api/routines/:id/test-run` | – | `{ runId: string }` |
| POST | `/api/attachments` | multipart `file` | `Attachment` |
| GET | `/api/attachments/:id` | – | file bytes |
| GET | `/api/usage` | – | `UsageSummary` |
| GET | `/api/search?q=` | – | `SearchResult[]` |
| GET | `/api/secrets` | – | `{ backend: string, names: string[] }` (names only, never values) |
| POST | `/api/secrets` | `{ name, value }` | `{ ok: true, names: string[] }` |
| DELETE | `/api/secrets/:name` | – | `{ ok: true, names: string[] }` |
| GET | `/api/settings` | – | `Settings` |
| PATCH | `/api/settings` | partial `Settings` | `Settings` |
| GET | `/api/workspace/tree?path=` | – | `{ name, path, dir, bytes }[]` |
| GET | `/api/workspace/file?path=` | – | file bytes |
| GET | `/api/computer/status` | – | `{ available: boolean, mode, pages: {botId,url,title}[] }` |
| POST | `/api/computer/takeover` | `{ botId }` | `{ ok: boolean, message: string }` |
| DELETE | `/api/computer/takeover` | `{ botId }` | `{ ok: true }` |
| GET | `/api/connectors` | – | `ApiConnector[]` (`Connector` + `missingSecrets: string[]`) |
| POST | `/api/connectors` | `CreateConnectorRequest` | `Connector`; 409 if the name is taken |
| PATCH | `/api/connectors/:id` | `UpdateConnectorRequest` | `Connector` (no rename — see below) |
| DELETE | `/api/connectors/:id` | – | `{ ok: true }`; also drops every bot's assignment |
| POST | `/api/connectors/:id/test` | – | `ConnectorProbeResult` `{ok, tools[], error?}` |
| GET | `/api/bots/:id/connectors` | – | `Connector[]` assigned to this bot |
| PUT | `/api/bots/:id/connectors` | `{ connectorIds: string[] }` | `{ ok: true }` |

## WebSocket

- `GET /api/events` (ws) — server pushes `ServerEvent` JSON frames.
  Client may send `{"type":"resume","seq":N}` once on connect to replay missed events.
- `GET /api/computer/screencast/:botId` (ws) — **bidirectional.**

  Server → client:
  - `{"type":"frame","data":"<base64 jpeg>","w":N,"h":N}` — one frame is always sent on connect,
    because Chromium emits screencast frames only on repaint and a static page produces none.
  - `{"type":"error","message":"..."}` — the screencast could not start; the socket then closes.
  - `{"type":"input-error","message":"..."}` — an input frame was rejected. Non-fatal; the
    screencast continues.
  - `{"type":"selection","text":"..."}` — reply to `selection-request`, capped at 100,000 chars.

  Client → server:
  - `{"type":"input","input":{...}}` — human input to dispatch into the page, validated against
    `ScreencastClientFrameSchema` in `@antbot/contract/events.ts`. Coordinates are **normalised**
    (0–1 fractions of the rendered frame), never pixels: neither side knows the other's geometry.
    Malformed frames are ignored rather than closing the socket.
  - `{"type":"selection-request"}` — asks for the page's current text selection, answered with a
    `selection` frame. Copy-out needs a round trip because the two clipboards are different: the
    viewer's own selection is a JPEG, and the page's clipboard belongs to the headless browser.

  **Only dispatched while the screen is taken over** (`POST /api/computer/takeover`). Otherwise the
  daemon replies `input-error` and does nothing. Input is the human acting as themselves and does
  not pass the Permission Gateway, which governs what *bots* do — see `SECURITY.md`.

`ServerEvent` union is defined in `@antbot/contract/events.ts`. Every event carries
`seq`, `threadId` (nullable), `botId` (nullable).

## Connectors

A connector is an MCP server registered once for the account and assigned per bot. Assignment is
the permission: a bot with no assignment never has the server mounted, so its tools do not exist
for that bot. Its tools reach the gateway as `mcp__<name>__<tool>` and are subject to rules like
any other tool.

- **Names** match `^[a-z0-9][a-z0-9-]{0,31}$`, and `antbot` / `browser` are reserved. Underscores
  are rejected because `toolNameAliases()` splits `mcp__<name>__<tool>` on the first `__` pair.
- **No rename.** `PATCH` cannot change a name: the name is part of every tool name a rule may
  already match, so renaming would silently orphan those rules. Delete and re-add.
- **Secrets are references, never values.** An env value or header may contain `{{secret:NAME}}`;
  the daemon substitutes it from the keychain when the server is mounted. Stored rows, every
  response above, and `POST /:id/test` carry only the reference. `missingSecrets` lists references
  with nothing behind them — such a connector is skipped at turn time rather than failing the turn.

## Static

The built web UI is served from `/` by the daemon (`ui/dist`).
