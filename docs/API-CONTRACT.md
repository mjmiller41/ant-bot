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
| POST | `/api/bots/:id/reset` | – | `{ ok: true, messagesDeleted: number }`; 409 while the bot is running |
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
| GET | `/api/connectors` | – | `ApiConnector[]` (`Connector` + `missingSecrets`, `signedIn`; rows carry `kind`, `lastStatus`, `lastError`, `checkedAt`) |
| GET | `/api/connectors/catalog` | – | `ApiCatalogEntry[]` — the built-ins ant-bot ships, with their guided setup steps |
| POST | `/api/connectors` | `CreateConnectorRequest` (`config` **or** `builtin`, optional `botIds`) | `ApiConnector & { check: ConnectorCheck }`; 409 if the name is taken |
| PATCH | `/api/connectors/:id` | `UpdateConnectorRequest` | `Connector` (no rename — see below) |
| DELETE | `/api/connectors/:id` | – | `{ ok: true }`; also drops every bot's assignment |
| POST | `/api/connectors/:id/login` | `{clientId?, clientSecret?, scopes?}` | `{ authorizeUrl }` |
| DELETE | `/api/connectors/:id/login` | – | `{ ok: true }` (forget a stored sign-in) |
| GET | `/api/connectors/oauth/callback` | – | HTML — where the provider returns the human |
| POST | `/api/connectors/:id/check` | – | `ConnectorCheck` `{status: ready \| needs-sign-in \| needs-credential \| unreachable, selfRegistration?, provider?, tools[], detail?, alternative?}` (`alternative` names a built-in when the URL is a provider's own allowlisted endpoint); persisted to the row |
| POST | `/mcp/:name` | JSON-RPC (MCP streamable HTTP) | A built-in connector's MCP endpoint. 401 without the per-boot bearer; 202 for a notification |
| DELETE | `/mcp/:name` | – | 204 (session end; stateless, so a no-op) |
| GET | `/api/bots/:id/connectors` | – | `Connector[]` assigned to this bot |
| PUT | `/api/bots/:id/connectors` | `{ connectorIds: string[] }` | `{ ok: true }` |

## WebSocket

- `GET /api/events` (ws) — server pushes `ServerEvent` JSON frames.
  Client may send `{"type":"resume","seq":N}` once on connect to replay missed events.

  The first frame is always `hello`, carrying `seq` and **`epoch`** — an id generated once per
  daemon process. `seq` restarts at 1 on every boot, so a client that filters on "greater than
  the last seq I saw" must compare the epoch first: a different one means the numbering is new,
  and the client resets its filter and refetches (the replay ring is empty at boot, so anything
  emitted while it was disconnected is not recoverable from the socket). Without this a page
  open across a daemon restart silently discards every event while still reporting Connected.
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
  the daemon substitutes it from the keychain when the server is mounted. Stored rows and every
  response above carry only the reference. `missingSecrets` lists references with nothing behind
  them — such a connector is skipped at turn time rather than failing the turn.
- **Built-ins** (`kind: "builtin"`) are servers the daemon itself serves at `POST /mcp/<name>`,
  listed by `GET /api/connectors/catalog`. Their config is not editable; a row is created with
  `{ builtin: "<catalog name>" }` and the name must equal the catalog name. The endpoint is
  guarded by a bearer that changes every boot and is known only to the daemon's own mount
  config, so a bot's subprocess cannot reach another connector's tools by path.
- **`check` is the verdict; `mcp_status` at turn start writes the same columns.** `lastStatus` on
  a row is whichever came last.
- **Mid-turn sign-in.** When a mounted server asks for a URL sign-in during a turn, the bot's
  streaming message gets a `signin` card `{serverName, url}` via `message.card`. No new event type.

## Static

The built web UI is served from `/` by the daemon (`ui/dist`).
