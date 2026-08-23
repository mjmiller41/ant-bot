# Security model

This describes what ant-bot actually does, verified against the source in this checkout. It is
written to be read before you connect a Bot to anything that matters. Nothing here is aspirational
— where a control does not exist yet, it says so.

## Bots are not a security boundary

All Bots on your account share **one computer**: one workspace directory
(`~/.ant-bot/workspace`), one persistent browser profile (`~/.ant-bot/browser-profile`), one
terminal, and one set of secrets available to be injected into tool environments. This is
deliberate — it's what makes a Bot able to hand work to another Bot and have files, browser
sessions, and installed tools just be there — but it means:

- A file one Bot writes into the workspace is readable by every other Bot.
- A login one Bot establishes in the shared browser profile is available to every other Bot.
- A secret you grant to one Bot's task is available to any Bot whose tool call requests it by
  name (see **Secrets** below).

Do not create a second Bot expecting it to be walled off from the first one's work area, browser
sessions, or secrets. If you need real isolation between two jobs, that isolation has to happen
outside ant-bot (separate `ANTBOT_HOME` data directories run as fully separate daemons with
separate workspaces, browser profiles, and secret stores).

The system prompt every Bot receives says this to the model directly (see
`daemon/src/bots/prompt.ts`):

> You share one computer with every other bot on this account. ... Files, logins and installed
> tools are visible to all bots. Bots are **not** a security boundary. Do not store anything here
> another bot should not see.

## The API is unauthenticated and localhost-bound

There is no login, no API key, and no session cookie on the ant-bot HTTP/WS API. The daemon binds
to `127.0.0.1:4780` by default (`daemon/src/config/config.ts`). Anyone who can reach that
port can create Bots, read every thread, approve or deny every pending action, read and write
files in the workspace, drive the shared browser, and read the names of every stored secret. In
other words: **exposing the port is equivalent to handing over full control of the agent and
everything it can touch.**

Do not port-forward `4780` on a router, do not bind the daemon to `0.0.0.0`, and do not put it
behind a reverse proxy without adding your own authentication layer. For phone or LAN access, use
a private overlay network (e.g. [Tailscale](https://tailscale.com/)) or an SSH tunnel
(`ssh -L 4780:127.0.0.1:4780 your-host`) so the port is only reachable over an already-authenticated
channel — never a raw port forward.

## Approval semantics

Every tool call an Agent SDK turn wants to make — built-in tools (`Bash`, `Read`, `Write`, `Edit`,
`WebFetch`, ...), the custom tools ant-bot adds (`send_to_bot`, `remember`, `request_secret`), and
every `browser_*` action — passes through `canUseTool`, which calls
`PermissionGateway.check()` (`daemon/src/permissions/gateway.ts`). Three things to
understand about what that gate actually does:

1. **An approval gates the proposed action. It never undoes completed work.** By the time you see
   an approval card, the model has already decided what it wants to do; approving lets it proceed,
   denying stops it from happening. If a Bot already ran something before this point (e.g. a step
   that matched an `allow` rule earlier in the same turn), no later approval decision reaches back
   and reverses it.
2. **Precedence: `require` always beats `allow`.** `evaluateRules()` in
   `daemon/src/permissions/rules.ts` checks every enabled `require` rule first; if any
   matches the tool name and input, that rule wins outright and the action goes to a human,
   regardless of any `allow` rule that also matches. Only when no `require` rule matches does an
   `allow` rule get a chance to auto-approve.
3. **Auto-review is advisory and can never green-light past a `require` rule.** If
   `settings.autoReviewEnabled` is on and a `requiredBy` rule did **not** match, the gateway may
   consult a Haiku-based `AutoReviewer` for a verdict (`allow_ok`, `needs_human`, or
   `deny_suggested`). It can turn a would-be human prompt into an auto-allow — but only when no
   `require` rule already claimed the action. There is no code path in which auto-review overrides
   a `require` rule.
4. **Unknown tools fall through to asking a human, never to allow.** If no rule matches at all
   (`decision.kind === 'none'`) and auto-review is off, or the reviewer errors, or the reviewer
   itself says `needs_human`/`deny_suggested`, the gateway always creates a pending `approvals` row
   and blocks the turn — it never defaults an unrecognized action to allowed. (See
   `gateway.check()`: the fallback path is always `askHuman(...)`, never an implicit allow.)

Approval requests time out after **15 minutes** (`LIMITS.APPROVAL_TIMEOUT_MS`,
`contract/src/limits.ts`) and resolve to `expired`, which the gateway treats as a denial —
the turn is told the action was not approved, it is not silently allowed through.

"Always allow" on an approval card persists a new narrow `allow` rule scoped to the tool pattern
(and optionally an input pattern) you specify at decision time — it does not retroactively affect
the action you just approved, and it is still subject to precedence: a future `require` rule you
or the defaults add later will still win over it.

## The shipped default rules

These ship enabled (except one, noted below) from `BUILTIN_RULES` in
`daemon/src/permissions/rules.ts`, seeded once into the `rules` table on first boot
(`PermissionGateway.seedBuiltins`). You can disable, edit, or add to them from the Rules screen in
the UI; this table is what a fresh install actually enforces.

**On tool names.** Tools served over MCP — every `browser_*` tool, plus `send_to_bot`, `remember`
and `request_secret` — reach the gateway fully namespaced as `mcp__<server>__<tool>` (a live turn
records a click as `mcp__browser__browser_click`). Tool patterns are anchored, so `ruleMatches`
tests each pattern against **both** the namespaced and the bare name (`toolNameAliases` in
`daemon/src/permissions/rules.ts`). Without that normalization the three rules below that
name MCP tools could never match, and the consequential-click and credential-typing gates would be
silently dead. Both `require` and `allow` rules are normalized the same way, so this cannot turn a
blocked action into an allowed one — `require` still wins.

| Kind | Tool | What it catches | Why |
|---|---|---|---|
| require | `Bash` | `sudo`, `doas`, `su -` | Privilege escalation |
| require | `Bash` | `rm -r`/`-f`, `shred`, `mkfs`, `dd if=` | Destructive filesystem command |
| require | `Bash` | `curl \| sh`, `wget \| sh` (piped into a shell) | Piping a download into a shell |
| require | `Bash` | `npm/pnpm/yarn/pip/gem/cargo/apt/dnf/brew/go install` (and `add`/`get` variants) | Package install |
| require | `Bash` | `git push`, `git remote add`, `gh pr/release/repo create\|merge` | Publishing to a remote |
| require | `Bash` | `mail`, `sendmail`, `mutt`, `msmtp` | Sending mail |
| require | `Bash` | `curl` with `-X POST/PUT/PATCH/DELETE`, `--data`, or `-d` | Outbound write request |
| require | `WebFetch` | any input (pattern `.`, matches everything) | Fetching an external URL |
| require | `browser_click` | text containing buy/purchase/checkout/pay/order/subscribe/confirm/delete/send/publish | Consequential click |
| require | `browser_type` | text containing password/passwd/secret/token/api key/SSN/credit card | Typing a credential — use takeover instead |
| require | `send_to_bot` | — (**shipped disabled**, `enabled: false`) | Handing work to another bot — present as an opt-in rule, not enforced by default |
| allow | `Read` | any input | Reading files is safe |
| allow | `Glob` | any input | Listing files is safe |
| allow | `Grep` | any input | Searching files is safe |
| allow | `TodoWrite` | any input | Planning scratchpad |
| allow | `Bash` | commands starting with `git status/diff/log/show/branch`, `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `echo`, `date`, `which`, `grep`, `find`, `rg` | Read-only shell inspection |

Everything not covered by an `allow` rule above and not matched by a `require` rule above still
goes to a human by default — the allow-list is intentionally narrow (read-only file and shell
inspection tools), not a general allowance.

Two things worth calling out explicitly:

- **`WebFetch` requires approval for every call**, with no exceptions built in. Any URL fetch a
  Bot proposes, internal or external, produces an approval card unless you add your own `allow`
  rule.
- **The `send_to_bot` require-rule ships present but disabled.** Bot-to-bot handoffs are not
  gated by default; enable this rule from the Rules screen if you want every handoff to require a
  human nod.

## Secrets

`daemon/src/permissions/secrets.ts` implements a keychain-backed secret store:

- On macOS, values go through the system Keychain (`security add-generic-password` /
  `find-generic-password`).
- On Linux, values go through libsecret via `secret-tool`.
- If neither is available, ant-bot falls back to an AES-256-GCM encrypted file
  (`~/.ant-bot/secrets.json` plus a sibling `.key` file, both `0600`). This fallback is explicitly
  labeled weaker in its own `name` field (`"encrypted file (weaker than a system keychain)"`) and
  in the UI: the encryption key is a plain file readable by anything running as your user, so it
  protects against casual disk browsing but not against another process running as you.

Only **names** are ever returned over the API (`GET /api/secrets` → `{ backend, names: string[] }`
— see `docs/API-CONTRACT.md`); values never leave the backend except as an env-var overlay handed
to the tool subprocess that needs them. A Bot asks for a secret with the `request_secret(name,
reason)` tool, which publishes a `secret.request` event for the UI to render as a modal — the tool
result the model sees back is only a confirmation string ("Asked the human for ... you will never
see the value"), never the value itself, so **secret values never enter the transcript or the
model's context.**

Passwords, one-time codes, and CAPTCHAs are explicitly out of scope for the secret-request flow
and for chat generally — the `browser_type` default require-rule (above) exists specifically to
catch a Bot trying to type a credential itself, and the intended path is human takeover of the
browser (see the Computer view's "take over" control), never pasting a password into the
conversation.

## Subscription billing guarantee

The daemon never holds Anthropic API credentials itself. The Agent SDK spawns the `claude` CLI
subprocess for every turn, and that subprocess authenticates using your existing `claude` login
(`~/.claude`) — a Pro/Max subscription, not a metered API key.

`buildEnv()` in `daemon/src/agent/session.ts` enforces this at the subprocess boundary:

```ts
export function buildEnv(settings: Settings, base = process.env) {
  const env = { ...base };
  if (settings.billingMode !== 'api') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}
```

If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is present in your shell's environment, ant-bot
strips both from the environment it hands to every `claude` subprocess unless
`settings.billingMode` is explicitly set to `"api"` — so an ambient API key in your shell cannot
silently switch a Bot's usage from subscription billing to metered billing. `antbot doctor` warns
(non-fatally) if it finds `ANTHROPIC_API_KEY` set in the environment it's run from, for visibility.

## Local execution setting

Settings exposes a `localExecution` field (`ask | always | never`, default `ask`) in the Settings
screen, carried over from the design doctrine this project is translated from (a product where a
Bot's cloud computer and your local machine are two distinct places). ant-bot has only one
physical machine, so that distinction is mapped onto a **path boundary**: the workspace
(`~/.ant-bot/workspace`, or `$ANTBOT_HOME/workspace`) is the Bots' computer, and everything
outside it is your machine.

`PermissionGateway.check()` evaluates this boundary in `src/permissions/local.ts` *before* any
`allow` rule is consulted, so it cannot be unlocked by a broad user rule:

| Setting  | A tool call reaching outside the workspace |
| -------- | ------------------------------------------ |
| `never`  | denied outright, with the setting named in the denial |
| `ask`    | forced to a human approval, even if an `allow` rule would have matched |
| `always` | treated like any other call — falls through to normal rule evaluation |

A call that stays inside the workspace is unaffected by this setting at every level.

Reach is detected from `file_path`/`notebook_path` on the file tools, and from absolute,
`~`/`$HOME`, and dot-relative paths parsed out of `Bash` commands. The Bash parsing is a
**heuristic and deliberately conservative**: it resolves candidate paths against the workspace and
flags anything that escapes, which means an out-of-workspace path mentioned in a quoted string or
a commit message can also trip the gate. It errs toward asking. Equally, it is not a sandbox — a
sufficiently indirect command (a path assembled at runtime, an `eval`, a script that itself
escapes) will not be caught by string inspection. Treat `never` as a strong default rather than a
containment guarantee, and keep the `require` rules in place as the primary control.

## Reporting and hardening

- **Least privilege on connectors and access.** Only grant a Bot's job description access to what
  its job actually needs; prefer read-only tasks and drafts before granting anything that sends,
  publishes, purchases, deletes, or changes production state.
- **Review rules regularly.** Open the Rules screen periodically — check that no overly broad
  `allow` rule has crept in (a rule with an empty `inputPattern` matches every input for that
  tool), and that the `require` rules you rely on are still enabled.
- **Revoke at the source.** Deleting a Bot removes its profile, conversation, and routines, but
  does **not** remove shared-computer files or sign-ins it created — sign out of services and
  revoke tokens/connectors at the source, not just in ant-bot.
- **Remove sensitive files from the workspace** once a task is done; anything left in
  `~/.ant-bot/workspace` is visible to every Bot on the account indefinitely.
- **Keep the API unreachable from anywhere but localhost or an authenticated tunnel** — see above.
- **Treat memory as a hint, not a record.** A Bot's memory directory
  (`~/.ant-bot/workspace/bots/<slug>/memory/*.md`) is durable working preference, not a source of
  truth; correct it directly if it goes stale rather than trusting it for consequential decisions.
