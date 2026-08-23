# ant-bot user guide

ant-bot is a local system for running persistent AI teammates ("Bots") on your own machine. Each
Bot has a name, a standing job description, its own conversation thread, its own memory, and its
own browser screen. Bots run on your Claude subscription, keep working across turns, and pause for
your approval before doing anything consequential.

This guide covers everything the application does. It is written against the current source; where
a control exists in the UI but is not yet wired to behaviour, that is stated plainly in
[Known limitations](#22-known-limitations) rather than glossed over.

**Related documents**

| Document | What it covers |
| --- | --- |
| `README.md` | Project overview and architecture |
| `docs/SECURITY.md` | The trust model, in depth |
| `docs/SKILLS.md` | Authoring skill files |
| `docs/API-CONTRACT.md` | HTTP/WebSocket API reference |

---

## Contents

1. [Core concepts](#1-core-concepts)
2. [Installation and first run](#2-installation-and-first-run)
3. [The command line](#3-the-command-line)
4. [Touring the interface](#4-touring-the-interface)
5. [Working with Bots](#5-working-with-bots)
6. [Conversations](#6-conversations)
7. [Approvals and the permission system](#7-approvals-and-the-permission-system)
8. [Rules](#8-rules)
9. [Memory](#9-memory)
10. [Skills](#10-skills)
11. [Routines (scheduling)](#11-routines-scheduling)
12. [Bot-to-bot handoffs](#12-bot-to-bot-handoffs)
13. [The Computer (browser)](#13-the-computer-browser)
14. [Secrets](#14-secrets)
15. [The Workspace](#15-the-workspace)
16. [Usage](#16-usage)
17. [Settings reference](#17-settings-reference)
18. [Files, ports, and environment](#18-files-ports-and-environment)
19. [Backup and restore](#19-backup-and-restore)
20. [Limits](#20-limits)
21. [Troubleshooting](#21-troubleshooting)
22. [Known limitations](#22-known-limitations)

---

## 1. Core concepts

**Bot** — a persistent teammate. Has a name, optional title, a description (its standing job
description), an emoji avatar, and a model tier. Every Bot gets one direct-message thread
automatically when created.

**Thread** — a conversation. A `dm` thread belongs to one Bot; a `group` thread has 2–6 Bot
members.

**Turn** — one unit of Bot work: you send a message, the Bot thinks, calls tools, and replies. A
turn resumes the Bot's previous session, so context compounds over time rather than resetting.

**Card** — a structured block attached to a message. Five kinds: `tool` (a tool call and its
result), `file` (a file the Bot created or modified, with a download link), `approval` (an inline
approve/deny prompt), `handoff` (work passed to another Bot), and `error`.

**Approval** — a pause. Before a consequential tool call runs, the Bot stops and asks you. See
[section 7](#7-approvals-and-the-permission-system).

**Rule** — a standing decision about a category of tool call: either *require approval* or
*always allow*. See [section 8](#8-rules).

**Skill** — a reusable written procedure a Bot can follow. See [section 10](#10-skills).

**Routine** — a schedule that fires an instruction at a Bot on a cron expression. See
[section 11](#11-routines-scheduling).

**Memory** — durable markdown notes a Bot carries into every turn. See [section 9](#9-memory).

### The one rule that shapes everything else

> **Bots are not a security boundary.**

Every Bot shares one computer, one workspace directory, one browser profile, and therefore every
login in that profile. A Bot can read another Bot's files and memory. Separate Bots give you
separate *roles and context* — not separate *permissions*. Do not put something in the workspace
that any Bot on the account should not see.

Two corollaries worth internalising before you grant anything:

- **Approval gates the proposal, not the outcome.** Approving a step authorises that step. It does
  not undo anything the Bot already did, and it does not vouch for what happens afterwards.
- **Memory is not authoritative.** A Bot's memory is a working note. It can be stale or wrong, and
  Bots are instructed to re-check the source before any consequential decision.

---

## 2. Installation and first run

### Requirements

| Requirement | Why |
| --- | --- |
| Node.js 24 or later | The server targets Node 24 |
| The `claude` CLI, logged in | Every Bot turn runs through it — this is what bills to your subscription |
| Chromium via Playwright | Only needed for the Computer/browser features |
| pnpm 11 | **Only for the contributor path** — not needed to install and run ant-bot |

### Step-by-step

**1. Log in to Claude Code.** ant-bot never holds Anthropic credentials of its own. It spawns the
`claude` CLI, which uses the login you already have.

```bash
npm i -g @anthropic-ai/claude-code   # if not already installed
claude                               # log in once, then exit
```

**2. Install ant-bot.** It ships as a single npm package containing the daemon, the CLI, the web
UI and the bundled skills.

```bash
npm i -g @michael-joseph-miller/ant-bot
# or: pnpm add -g / yarn global add / bun add -g, same name
```

<details>
<summary>Working on ant-bot itself? Install from a checkout instead.</summary>

```bash
cd /path/to/ant-bot
pnpm install            # installs dependencies and builds every package
```

Then use `./antbot` in place of `antbot` throughout this guide. The two installs are independent;
`ANTBOT_HOME` (see below) is what keeps their data apart if you run both.
</details>

**3. Install the browser** (skip if you do not want the Computer features):

```bash
npx playwright install chromium
```

**4. Check your environment.**

```bash
./antbot doctor
```

This runs eight checks — Node version, the `claude` CLI, Claude authentication,
`ANTHROPIC_API_KEY`, data-directory writability, port availability, `better-sqlite3`, and
Playwright's Chromium. Each prints `✓` (pass), `⚠` (warning), or `✗` (failure) with a fix hint.
Warnings are fine to proceed on; failures are not. The command exits non-zero if anything failed.

**5. Start the daemon and open the interface.**

```bash
antbot open
```

`open` starts the daemon if it isn't already running, waits for it to become healthy, then hands
the URL to your browser. To start without opening a browser, use `./antbot start`; to keep the
daemon attached to your terminal instead of detaching, add `--foreground`. Either way the UI is
at <http://127.0.0.1:4780> if you would rather browse there yourself.

> **Tip — working from a checkout.** `./antbot` is a launcher script in the repo root. It rebuilds
> automatically when sources change, so there is nothing to reinstall after a `git pull`. For a
> plain `antbot` from any directory, symlink it somewhere already on your `PATH`:
> ```bash
> ln -s "$PWD/antbot" ~/.local/bin/antbot
> ```
> The launcher resolves symlinks, so it still finds the repo. From the repo root you can also skip
> the `./` with `pnpm antbot status`.
>
> The rest of this guide writes `antbot` for brevity.

**6. Create your first Bot.** See [section 5](#5-working-with-bots).

### Staying up to date

```bash
antbot update           # upgrade to the latest published version
antbot update --check   # report whether a newer one exists, and change nothing
```

`antbot update` re-runs whichever package manager installed your copy, then tells you to
`antbot restart`. `status` and `doctor` also mention a newer version when one exists — the check
is cached for a day, so it costs no network most of the time.

ant-bot never updates itself in the background, by design: the daemon holds a live database
handle and may be mid-turn spending subscription tokens, and replacing its files underneath that
is a bad trade for a local-first tool. From a git checkout `antbot update` refuses and points you
at `git pull` instead.

Your database is migrated automatically the first time a new version opens it, and a snapshot of
the previous database is written to `~/.ant-bot/backups/` before anything is changed.

### Development mode

To run the server from TypeScript without building, and the UI with hot reload:

```bash
pnpm dev                              # server on :4780, via node --experimental-strip-types
pnpm --filter @antbot/web dev         # Vite dev server, proxies /api to :4780
```

Other repo-level scripts: `pnpm build` (all four packages, in dependency order — `pnpm install`
runs this for you), `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm e2e`, and `pnpm antbot <command>`
(the CLI without the `./` prefix).

---

## 3. The command line

```
antbot <command> [options]
```

Plain `antbot` after `npm i -g @michael-joseph-miller/ant-bot`, or `./antbot` from a checkout (see
[section 2](#2-installation-and-first-run)). Day to day you need two of these: `antbot open` to get to work, and `antbot doctor` when something is wrong.

| Command | What it does |
| --- | --- |
| `antbot start [--port N] [--open] [--foreground]` | Start the daemon. Detached by default; `--foreground` runs it in your terminal, `--open` opens the UI once it is healthy, `--port` overrides the configured port. |
| `antbot stop` | Stop the running daemon. |
| `antbot restart [--port N]` | Stop the daemon and start it again. Bots, threads, and memory survive. |
| `antbot update [--check] [--yes]` | Update to the latest published version, using whichever package manager installed this copy. `--check` reports and changes nothing. Refuses inside a git checkout. |
| `antbot status` | Report whether ant-bot is running, on which port, with how many Bots. |
| `antbot doctor` | Run the eight environment checks described above. |
| `antbot open` | Open the UI in your browser, starting the daemon first if it isn't running. |
| `antbot skill list` | List installed skills. |
| `antbot skill add <source>` | Install a skill from a git repo, a local path, or a `SKILL.md` URL. See [section 10](#10-skills). |
| `antbot skill remove <slug>` | Uninstall a skill. |
| `antbot skill lint [path]` | Check skills against the Agent Skills spec. No daemon needed. See [section 10](#10-skills). |
| `antbot backup [--out PATH]` | Write a `.tar.gz` of your database, config, skills, and Bot memory. |
| `antbot restore <path> [--yes]` | Restore from a backup archive. Prompts for confirmation unless `--yes`. |

Global flags: `-h`/`--help` and `-v`/`--version`. `--help` also works per-command
(`antbot backup --help`) and prints that command's flags and behaviour; `antbot` with no arguments
prints the same overview as `antbot --help`.

Unknown commands and unknown flags exit with code 2 and a usage hint. `antbot status` exits
non-zero when the daemon is not running, so it composes in scripts.

---

## 4. Touring the interface

The window has three parts: a **top bar**, a **sidebar**, and the **main pane**.

### Top bar

Six navigation tabs — **Chats**, **Workspace**, **Computer**, **Rules**, **Usage**, **Settings** —
and on the right:

- **Search…  ⌘K** — opens the command palette.
- **N pending approvals** — an amber badge when Bots are waiting on you. (This is an indicator, not
  a link; the Rules tab also carries a count badge. To act on an approval, open the Bot's thread.)
- **Connection dot** — green `Connected`, amber pulsing `Connecting…`, red `Disconnected`. This is
  the live event WebSocket. If it goes red, the daemon stopped or restarted.

### Sidebar

Your roster, in sections: **Pinned**, **Bots**, **Groups**, and a collapsible **Hidden** group.
Each row shows the Bot's emoji, name, a state dot, its title, and an attention badge. The **New**
button at the top creates a Bot.

Bot states, shown as the coloured dot: `idle` (grey), `queued` and `running` (blue, pulsing),
`waiting_approval` and `waiting_input` (amber), `interrupted` (red).

The attention badge is separate: a blue dot means unread, and an amber **Needs attention** label
means the Bot wants something from you.

### Main pane

Whatever the selected tab shows. On **Chats**, that is the conversation for the selected thread,
with a header carrying the Bot's name and a **Bot settings** link.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + N` | New bot |
| `Ctrl/Cmd + K` | Command palette |
| `Enter` | Send message |
| `Shift + Enter` | Newline in the composer |
| `Escape` | Dismiss the mention/skill autocomplete, or close the palette |

### Command palette

Press `Ctrl/Cmd + K`. Type to filter. It offers:

- **Actions** — New bot, Open settings, Open rules, Open usage, Open workspace.
- **Results** — full-text search across Bots, messages, and routines. Selecting a Bot or message
  result jumps to its thread. **Routine results are not clickable** — they carry no thread, so
  selecting one does nothing; use them to confirm a routine exists, then open it via its Bot's
  settings. Search is debounced by 150 ms and capped at 50 results.

---

## 5. Working with Bots

### Creating a Bot

1. Click **New** in the sidebar, or press `Ctrl/Cmd + N`.
2. Pick an **emoji** from the 16-icon grid.
3. Enter a **Name** (required, up to 60 characters) — for example `Scout`.
4. Optionally add a **Title** (up to 120 characters) — for example `Research assistant`. This is a
   human label shown next to the name.
5. Write a **Description** (up to 8000 characters). This is the most important field — see below.
6. Choose a **Model tier**: `sonnet` (default) or `opus`.
7. Click **Create bot**.

The Bot appears in the sidebar and its thread opens.

#### Writing a good description

The description becomes the Bot's *standing job description* in its system prompt, and it is
explicitly told these rules outrank any single message. This is the durable half of the split:

- **Description** = durable rules. "Always cite sources. Never email anyone without showing me the
  draft first. Prefer official documentation over blog posts."
- **Chat message** = this task, right now. "Research the three options and write me a comparison."

Put standing constraints in the description; put the task in the message.

#### Model tiers

`sonnet` is the default and right for nearly all work. `opus` is for Bots doing genuinely harder
reasoning. There is no per-message model picker by design — routing is fixed per Bot so behaviour
stays predictable. The auto-reviewer and the group-message router always use `haiku` regardless.

### Bot settings

Open a Bot's thread and click **Bot settings** in the header. The panel has five sections.

**Profile** — change the emoji (click the avatar for the full picker), name, title, description,
and model tier. Click **Save profile** to apply. Changes take effect on the Bot's next turn.

**Actions** — a row of buttons:

| Button | Effect |
| --- | --- |
| **Pin** / **Unpin** | Move the Bot into the Pinned section at the top of the sidebar. |
| **Hide** / **Unhide** | Move it into the collapsed Hidden section. It keeps working. |
| **Mute notifications** / **Unmute notifications** | Toggles the Bot's notification flag. ⚠️ The flag is stored but read by no code — muting currently has no effect. |
| **Duplicate** | Create a copy with the same profile, as a fresh Bot with a new thread. |
| **Delete** | Remove the Bot. Requires confirmation. |

**Deleting is not a cleanup.** The confirmation says so: deleting removes the Bot from your roster
and its conversation history, but its workspace files and any browser logins it created survive.
Delete the files yourself if you want them gone.

**Memory** — see [section 9](#9-memory).
**Skills** — see [section 10](#10-skills).
**Routines** — see [section 11](#11-routines-scheduling).

### Stopping a Bot

While a Bot is running, a red **Stop** button appears next to the composer. It aborts the turn,
clears anything queued for that Bot, and denies any approval it was waiting on with "Turn
interrupted".

---

## 6. Conversations

### Sending a message

Type in the composer at the bottom of the thread and press `Enter`. `Shift + Enter` inserts a
newline. Messages are markdown.

### Mentioning a Bot

Type `@` to open the mention autocomplete. It filters your roster by name or slug as you type;
click one or keep typing. Mentions matter most in group threads, where they decide who answers.
`@everyone` addresses every member.

### Invoking a skill

Type `/` **at the very start of the message** to open the skill autocomplete (the `/` trigger is
deliberately restricted to the start of a message, so a slash mid-sentence is just a slash). Pick a
skill to insert its slug.

### Attachments

Three ways to attach a file:

- Click the **+** button and choose files.
- **Drag and drop** onto the composer.
- **Paste an image** from your clipboard.

Attachments appear as removable chips above the composer. Limits: **6 files per message**, **25 MB
each** (200 MB for video). Uploads over the limit are rejected by the server with HTTP 413.

### Reading a reply

Replies stream in token by token. As the Bot works, cards appear inline beneath the text:

- **Tool cards** show the tool name, a one-line summary, a status chip (`running`, `ok`, `error`,
  `denied`), the output, and a collapsible **Raw input** section with the exact JSON.
- **File cards** would show a file the Bot created or modified, with a **Download** button — the
  renderer exists but **the server never emits this card type**, so you will not see one in
  practice. Find files a Bot produced in the Workspace tab instead.
- **Approval cards** are the inline approve/deny prompt.
- **Handoff cards** show work passing from one Bot to another.
- **Error cards** show failures.

The **Raw input** disclosure on tool and approval cards is deliberate: you can always see the exact
arguments a Bot proposed, not just a friendly paraphrase.

### Group threads

A group thread has 2–6 Bot members. When you post to one, ant-bot picks who answers:

1. If you wrote `@everyone`, all members answer.
2. Otherwise, if you `@`-mentioned specific Bots, those Bots answer.
3. Otherwise, a `haiku` router reads the message and the members' descriptions and picks the single
   best owner.
4. If the router fails, the first member answers, so a group is never silent.

Bots in a group are told to answer only when the request is theirs to own or when mentioned, to say
who should take the next step, and to keep replies short.

> **Note:** there is currently no button to create a group thread. Existing groups render in the
> sidebar and work fully, but creating one requires the API — see
> [Known limitations](#22-known-limitations).

---

## 7. Approvals and the permission system

### What happens when a Bot proposes an action

Every tool call a Bot makes passes through the Permission Gateway, which decides in this order:

1. **Local-execution boundary.** Does this call reach outside the shared workspace — that is, touch
   your own machine? If so, the `localExecution` setting applies: `never` denies it outright, `ask`
   forces a human approval even if an allow-rule would have matched, `always` lets it fall through
   to normal evaluation. This is checked *first*, so no broad allow-rule can unlock it.
2. **Rules.** A matching **require** rule always wins over any **allow** rule. A matching allow-rule
   runs the call immediately.
3. **Auto-review** (if enabled and no require-rule matched). A `haiku` pass classifies the call as
   `allow_ok`, `needs_human`, or `deny_suggested`. It is advisory only — it can never green-light
   something a require-rule caught. If it errors, the call falls back to asking you.
4. **You.** Anything left over becomes an approval card.

### Responding to an approval

The card shows an amber **Approval needed** badge, the tool name, a one-line summary, and a
collapsible **Raw input** with the exact arguments. Three buttons:

- **Allow once** — run this one call. Nothing is remembered.
- **Deny** — refuse. The Bot is told you denied it and continues from there.
- **Always allow…** — opens a small form to create a standing allow-rule. Fill in:
  - **Tool pattern** — pre-filled with this tool's name. `*` is the only wildcard.
  - **Input pattern** — an optional regex. Leave blank and the rule matches *every* input for that
    tool, which is usually broader than you want.
  - **Scope note** — why this is safe. Write it; future-you will need it.

  Click **Save rule** to create the rule and approve the pending call in one step.

**Approvals expire after 15 minutes.** An expired approval is denied and the Bot is told the
request expired.

### Where to find pending approvals

Approval cards appear inline in the thread where the work is happening. The top bar shows a count
of pending approvals across all Bots, and the Rules tab carries a matching badge, but to act on one
you must open that Bot's thread.

---

## 8. Rules

Open the **Rules** tab. Rules are standing decisions that apply to every Bot.

### The two kinds

- **Require approval** (red badge) — matching calls always stop and ask you.
- **Always allow** (green badge) — matching calls run without asking.

**Require always beats Always allow.** If both match, the call stops. The screen states this at the
top, and it is enforced in the evaluator, not merely documented.

### Reading a rule

Each row shows the kind badge, a 🔒 if it is built in, the tool pattern, the input pattern, and the
scope note. On the right: an **Enabled** checkbox and a **Delete** button.

Built-in rules can be **disabled** but not **deleted** — the Delete button is greyed out for them.
Disabling a built-in require-rule removes a protection that shipped on for a reason; do it
deliberately.

### Adding a rule

1. Choose **Require approval** or **Always allow**.
2. **Tool pattern** — the tool name. `*` is the only wildcard character, and matching is anchored
   and case-insensitive. Examples: `Bash`, `browser_*`, `*`.

   Tools provided over MCP — every `browser_*` tool, plus `send_to_bot`, `remember` and
   `request_secret` — arrive at the gateway fully namespaced as `mcp__<server>__<tool>`, e.g.
   `mcp__browser__browser_click`. Patterns are matched against **both** the namespaced and the bare
   name, so write whichever you prefer: `browser_click` and `mcp__browser__browser_click` both work.
3. **Input pattern** — an optional regular expression, matched case-insensitively and multiline
   against the tool's arguments. Every string value in the input is placed on its own line, so `^`
   anchors to the start of an actual argument (such as a Bash `command`) rather than to the start of
   a JSON blob. Leave blank to match all inputs for that tool.
4. **Scope note** — why the rule exists.
5. Click **Add rule**.

A rule whose regex fails to compile simply does not match, rather than matching everything. Be
aware of the second-order effect: a broken *require* rule drops out of evaluation, and evaluation
then continues to the allow-rules — so if an allow-rule covers the same call, it runs without
asking. A broken require-rule is not fail-safe on its own; it is only safe when nothing else
allows the action.

### The seeded rules

Sixteen rules are seeded on first run: eleven *require* and five *allow*. Fifteen are marked
built-in (🔒, not deletable) and enabled. The sixteenth — the `send_to_bot` rule — is the exception:
it ships **disabled and deletable**, there for you to switch on if you want handoffs gated.

**Require approval:**

| Tool | Catches |
| --- | --- |
| `Bash` | `sudo`, `doas`, `su -` — privilege escalation |
| `Bash` | `rm -rf`-style deletes, `shred`, `mkfs`, `dd if=` — destructive filesystem commands |
| `Bash` | `curl … \| sh`, `wget … \| bash` — piping a download into a shell |
| `Bash` | `npm/pnpm/yarn/pip/gem/cargo/apt/dnf/brew/go install` — package installs |
| `Bash` | `git push`, `git remote add`, `gh pr/release/repo create|merge` — publishing to a remote |
| `Bash` | `mail`, `sendmail`, `mutt`, `msmtp` — sending mail |
| `Bash` | `curl` with `-X POST/PUT/PATCH/DELETE`, `--data`, or `-d` — outbound write requests |
| `WebFetch` | Every external URL fetch |
| `browser_click` | Clicks matching buy, purchase, checkout, pay, order, subscribe, confirm, delete, send, publish |
| `browser_type` | Typing anything matching password, secret, token, api key, ssn, credit card |
| `send_to_bot` | Handing work to another Bot — **ships disabled and is not marked built-in**, so you can enable it, edit around it, or delete it |

Ten of those eleven ship enabled — the `send_to_bot` row is the disabled one.

**Always allow** (all five built-in and enabled): `Read`, `Glob`, `Grep`, `TodoWrite`, and read-only shell inspection
(`git status|diff|log|show|branch`, `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `echo`, `date`,
`which`, `grep`, `find`, `rg`).

`ls && curl -X POST …` still stops for approval. Note *why*: the read-only allow-rule does match it
(`^` anchors to the start of the command, which really is `ls`), but the outbound-write require-rule
also matches, and **require beats allow**. The anchor is not what saves you here — rule precedence
is.

---

## 9. Memory

Memory is a set of markdown files a Bot carries into every turn. Each file's contents are injected
into the system prompt under a "Your memory" heading, prefaced with a caution that memory is a
working note and the Bot should re-check the source before any consequential decision.

Memory lives on disk at `<workspace>/bots/<slug>/memory/*.md`, so you can also edit it with any
text editor.

### Editing memory in the UI

1. Open **Bot settings** → **Memory**.
2. The left column lists the Bot's memory files. Click one to load it.
3. Edit in the right-hand textarea.
4. Click **Save memory file**.

To **create** a file, type a name (e.g. `preferences.md`) in the box below the file list, write the
content, and save. To **delete** one, click the `×` beside its name.

### Bots writing their own memory

A Bot can save memory itself using its `remember` tool, which takes a short kebab-case title and a
markdown note. Bots are told to use it only for stable facts, never for changing data.

**Good memory:** "Prefers metric units." "The staging database is `db-stage-02`." "Never contact
the vendor directly — go through Priya."

**Bad memory:** "The Q3 total is $48,200." That is data, and it goes stale. The Bot should look it
up each time.

---

## 10. Skills

A skill is a written procedure — the *how* of a task, stored once and reusable. A routine is what
*schedules* it. See `docs/SKILLS.md` for the full authoring guide.

ant-bot uses the **standard Claude skill format**, so any published skill works unmodified: a
directory containing a `SKILL.md` with `name` and `description` frontmatter, plus whatever
supporting files it needs. Skills are loaded into each Bot's session as a local plugin, which
gives the Bot the real `Skill` tool — it discovers and invokes skills itself rather than being
handed a list of file paths.

Five skills ship installed, from the ant-bot project's own `skills/` directory —
**bug-repro**, **deep-research**, **inbox-digest**, **skill-author** and **weekly-report**.

### Installing a skill

```bash
antbot skill add <source>
```

`<source>` can be any of:

| Source | Example |
| --- | --- |
| GitHub shorthand | `antbot skill add anthropics/skills` |
| GitHub URL | `antbot skill add github.com/anthropics/skills` |
| Pinned to a branch or tag | `antbot skill add github.com/acme/skills#v2` |
| One skill inside a monorepo | `antbot skill add github.com/acme/skills/tree/main/pdf` |
| Any git URL | `antbot skill add git@github.com:acme/skills.git` |
| A local directory | `antbot skill add ./skills/my-skill` |
| A single skill file | `antbot skill add https://example.com/SKILL.md` |

A repository containing several skills installs **all** of them — `anthropics/skills` installs 24
in one command. To take just one, use the `/tree/<ref>/<subdir>` form.

Re-installing an existing skill **upgrades it in place** and keeps it assigned to whichever Bots
already had it.

Other commands:

```bash
antbot skill list              # what's installed
antbot skill remove <slug>     # uninstall (Bots lose it immediately)
antbot skill lint              # check installed skills against the spec
```

### Checking a skill against the spec

Skills follow the [Agent Skills specification](https://agentskills.io) — `skills/SPEC.md` in the
project. `antbot skill lint` checks any skill against it and needs no running daemon:

```bash
antbot skill lint                       # every skill installed on this machine
antbot skill lint ./path/to/skills      # a directory of skills
antbot skill lint ./path/to/my-skill    # one skill you are writing
```

It reports errors (exit 1) and warnings (exit 0). The one worth understanding is
**`name-dir-mismatch`**: a skill's frontmatter `name` must match its directory name exactly,
because that name is what ant-bot hands the model as the list of skills a Bot may use. When they
disagree the skill installs, appears in the UI, and can be assigned — but the Bot can never
actually reach it. Nothing errors; it simply never fires.

Installing a skill runs the same check and prints anything it finds in the install output. A
non-conforming skill still installs — plenty of useful third-party skills have sloppy frontmatter
— but you are told what is wrong with it.

To write a new skill or repair an existing one, assign a Bot the **skill-author** skill, or read
`skills/skill-author/SKILL.md` yourself: it carries the authoring rules and a checklist for
rewriting a skill without silently dropping what it used to say.

Or over HTTP, which is all the CLI does:

```bash
curl -X POST http://127.0.0.1:4780/api/skills/install \
  -H 'content-type: application/json' \
  -d '{"source":"anthropics/skills"}'
```

### What an install shows you

A skill can ship scripts, not just instructions. Every install prints a manifest of exactly what
landed on disk and flags anything executable:

```
✓ Installed 'algorithmic-art'

  LICENSE.txt                       11.1 KB
  SKILL.md                          19.3 KB
  templates/generator_template.js    7.6 KB   ⚠ executable
  templates/viewer.html             20.4 KB

⚠ This skill ships 1 script. Scripts run with the same access
  as any bot command. Review before assigning:
  /home/michael/.ant-bot/skills/skills/algorithmic-art
```

Installing does **not** enable anything — a skill is inert until you assign it to a Bot. That is
the moment to review a skill that brought scripts with it.

### Skills that ship with ant-bot

Any skill under the project's `skills/` directory is installed automatically on every start, so a
skill can be version-controlled alongside the code that uses it:

```
ant-bot/
└── skills/
    └── my-skill/
        └── SKILL.md
```

These stay current across upgrades without ever overwriting your work. ant-bot records a hash of
each skill as it installs it, in `~/.ant-bot/skills/skills/.managed.json`, and checks it on the
next start:

| Your copy of a shipped skill | What happens on the next start |
| --- | --- |
| Never installed | It gets installed |
| Untouched since ant-bot wrote it | It is refreshed if the shipped version changed |
| Edited by you | Left alone — your edits survive upgrades |
| Deleted by you | Stays deleted |
| Same name, installed from elsewhere | Left alone — ant-bot never claims a skill it did not write |

So editing your installed copy **forks** it: it will not pick up later ant-bot changes. If you want
both, edit the copy in the project's `skills/` directory instead — restart the daemon and the change
is live, because your installed copy is untouched and therefore refreshed. Skills installed from
other sources are never affected.

### Letting a Bot install its own skills

A Bot has three skill tools: `list_skills` (read-only), `install_skill`, and `remove_skill`.
Installing and removing **always stop for your approval first**, via built-in require-rules that
ship enabled.

The approval card names the *scope*, which is the thing worth reading — installing
`acme/skills` can mean one skill or a hundred, and only the card tells you which:

```
┌───────────────────────────────────────┐    ┌───────────────────────────────────────┐
│ APPROVAL NEEDED   install_skill       │    │ APPROVAL NEEDED   install_skill       │
│ Install "pdf-tools" from              │    │ Install EVERY skill in                │
│ github.com/acme/skills#main           │    │ github.com/acme/skills                │
│                                       │    │ (whole repository)                    │
│  [Allow once] [Deny] [Always allow…]  │    │  [Allow once] [Deny] [Always allow…]  │
└───────────────────────────────────────┘    └───────────────────────────────────────┘
        a scoped source                              a whole-repository source
```

A Bot that names a multi-skill source without asking for all of it is stopped before anything is
installed, and told what the source contains so it can narrow to the one skill you wanted. Your
own `antbot skill add owner/repo` is unaffected — typing the repo *is* asking for the repo.

These gates exist because a skill is instructions that steer future work, and may carry scripts. A
Bot that reads a web page suggesting a skill should not be able to act on that suggestion by
itself. The rules are `install_skill` and `remove_skill` on the Rules screen; a broad `allow` rule
cannot unlock either, because require always beats allow.

Bots remove skills with `remove_skill` rather than deleting directories, so the files and the
registration go away together — a skill deleted by hand leaves the registry pointing at nothing.
The daemon repairs that on the next start: skill rows whose files have moved are corrected, and
rows with nothing left on disk are dropped.

Installing still does not enable: after an approved install the Bot is told to ask you to assign
the skill in Bot settings.

### Assigning skills to a Bot

1. Open **Bot settings** → **Skills**.
2. Tick the skills this Bot should have. Currently-assigned skills are pre-ticked.
3. Click **Save skills**. A green "Saved" confirms.

Only assigned skills are visible to that Bot: the SDK hides unlisted skills from its listing and
the `Skill` tool refuses them.

> This is a **context filter, not a sandbox.** Unassigned skill files remain on disk and a Bot
> could still read one with `Read` or `Bash`. It shapes what a Bot reaches for, not what it can
> physically open — so never put a secret in a skill file.

### Writing a skill

Frontmatter plus a body in six fixed sections:

```markdown
---
name: weekly-report
description: Compile the weekly status report from the project log
---

## When to use it
...
## Required inputs and access
...
## Sequence of work
...
## How to validate the result
...
## What to return
...
## What requires approval
...
```

`description` is what the model matches on when deciding whether to reach for the skill, so write
it as a trigger ("Use this when…"), not a title. Multi-line YAML (`description: >` or `|`) works.

To install what you have written: `antbot skill add ./path/to/my-skill`, or drop it in the
project's `skills/` directory. There is no skill editor in the UI (see
[Known limitations](#22-known-limitations)).

The **What requires approval** section should never be empty. Note that it is a documentation
convention the model follows — the thing that actually *blocks* an action is a require-rule in the
Permission Gateway. The two are complementary, not the same mechanism.

---

## 11. Routines (scheduling)

A routine fires an instruction at one Bot on a cron schedule.

### Creating a routine

1. Open **Bot settings** → **Routines**.
2. In the **New routine** box:
   - **Name** — what it is, e.g. `Morning digest`.
   - **Cron expression** — standard 5-field cron: `minute hour day-of-month month day-of-week`.
     Defaults to `0 9 * * *` (9:00 every day). Supports `*`, lists (`1,15`), ranges (`1-5`), and
     steps (`*/15`). Both `0` and `7` mean Sunday.
   - **Timezone** — pre-filled from your browser. The schedule is evaluated in this zone, so it
     follows daylight saving correctly.
   - **Instructions** — what the Bot should do on each run.
3. Click **Create routine**.

Common expressions:

| Expression | Meaning |
| --- | --- |
| `0 9 * * *` | Every day at 09:00 |
| `0 9 * * 1-5` | Weekdays at 09:00 |
| `*/15 * * * *` | Every 15 minutes |
| `0 17 * * 5` | Fridays at 17:00 |
| `0 0 1 * *` | First of the month, midnight |

### Managing routines

Each routine row shows its name, cron expression, timezone, and next scheduled run.

- **Enabled** checkbox — pause and resume without losing the schedule.
- **Test run** — fire it immediately. This shows an amber warning first: *a test run performs real
  work — it can navigate websites, change files and call connected tools.* Click **Run anyway** to
  proceed. Test runs are marked `test` in the history and do not disturb the next scheduled time.
- **Delete** — remove it, with a confirmation prompt.
- **Show run history** — the last 20 runs, each with a status (`running`, `ok`, `failed`,
  `interrupted`), timestamp, a `test` tag if applicable, and a summary.

### How routine runs behave

Routine turns are queued at **lower priority than interactive turns**, so talking to a Bot never
waits behind its scheduled work.

Every routine prompt carries a standing instruction: *if the source data is unavailable, report the
failure instead of using old data.* A routine that cannot reach its source is expected to tell you
so, not to quietly reuse yesterday's numbers.

Limit: **50 routines per Bot**, **20 runs retained** per routine.

---

## 12. Bot-to-bot handoffs

A Bot can hand work to a teammate with its `send_to_bot` tool. Each Bot's system prompt lists its
teammates by slug, with the instruction to hand off when a job genuinely belongs to that role and to
keep one owner per stage rather than fanning the same task out to several Bots.

When a handoff happens:

1. A **handoff card** appears in the sending Bot's thread showing sender → recipient and a note.
2. The recipient is queued with the message, framed as a handoff and asked to reply — or to say so
   if the work belongs to someone else rather than guessing.
3. The recipient answers in **its own thread**, not the sender's.

**Hop limit: 5.** A chain that reaches it is told to stop and report back to you instead. This
stops two Bots bouncing a task between themselves indefinitely.

Handoffs are **not** gated by approval out of the box — the `send_to_bot` require-rule ships
disabled. Enable it in the Rules tab if you want every handoff to stop and ask you first.

---

## 13. The Computer (browser)

Open the **Computer** tab. Bots share one Chromium browser with a persistent profile, each with its
own page ("screen").

**Because the profile is shared, logins are shared.** If one Bot logs into a site, every Bot is
logged into that site. This is the single most important consequence of "Bots are not a security
boundary".

### What you see

A dropdown of active pages, a live screencast of the selected page, and an amber standing warning:
*Never paste passwords or one-time codes into chat — use takeover.*

If the browser service is not running, the tab explains that Bots can still browse and use tools —
you just will not see a screencast.

### Browser tools available to Bots

`browser_navigate`, `browser_click`, `browser_type`, `browser_read`, `browser_screenshot`,
`browser_press`, `browser_wait_for`, `browser_scroll`, `browser_back`.

Every one of these carries the same doctrine in its description: prefer a real API or connector
over clicking through a site; never type passwords, one-time codes, or other secrets; and if a
login wall, CAPTCHA, or 2FA prompt appears, **stop and report it** — never attempt to solve or
bypass a verification check.

### Takeover

When a Bot hits something only you can do — a password, a 2FA code, a CAPTCHA — it should stop and
ask. Click **Take over** to claim the screen. While you hold it, the Bot's attempts to act on that
page fail with a "screen taken over" error, so it cannot fight you for the mouse. Click **Return
control** to give it back.

> **Important:** ant-bot currently runs the browser headless, and the screencast is **view-only** —
> it streams frames but does not forward your clicks or keystrokes. Takeover reliably *blocks the
> Bot*, but there is no in-app way to complete the blocked step. See
> [Known limitations](#22-known-limitations).

Screenshots a Bot takes are written into the workspace. They do **not** appear as cards in the
thread — find them in the Workspace tab under `bots/<bot-id>/screenshots/`.

---

## 14. Secrets

Secrets are API keys and tokens that Bots need but must never see. Values go straight to your OS
keychain; only *names* are ever returned by the API, and a value is never written to a transcript
or placed in a model's context.

Backends, in order of preference: **libsecret** (`secret-tool`) on Linux, **macOS Keychain**, or an
**encrypted file** fallback (AES-256-GCM). The file fallback is explicitly weaker than a real
keychain — the daemon logs which backend it chose at startup.

A Bot can ask for a secret with its `request_secret` tool, giving a name and a reason.

> ⚠️ **Secrets are stored but never delivered.** The tool publishes a request event and the value
> goes to your keychain, but nothing injects it into the Bot's environment — the code that would
> build that overlay is never called. A Bot cannot currently use a stored secret. Treat this screen
> as a keychain front-end, not a working credential path. See
> [Known limitations](#22-known-limitations).

Secrets are currently managed through the API only:

```bash
# List the names you have stored (never values)
curl -s http://127.0.0.1:4780/api/secrets

# Store one
curl -s -X POST http://127.0.0.1:4780/api/secrets \
  -H 'content-type: application/json' \
  -d '{"name":"STRIPE_API_KEY","value":"sk_live_…"}'

# Remove one
curl -s -X DELETE http://127.0.0.1:4780/api/secrets/STRIPE_API_KEY
```

Names must be valid environment-variable identifiers (letters, digits, underscore; not starting
with a digit).

**Never put a password in chat.** For anything interactive — a login, a 2FA code — the answer is
takeover, not a secret.

---

## 15. The Workspace

Open the **Workspace** tab to browse the shared directory every Bot works in
(`~/.ant-bot/workspace`).

- The left panel is a lazy-loading file tree. Click a folder to expand it, a file to preview it.
- **Hidden files** checkbox — show dotfiles.
- The preview panel renders images inline and text files (`.md`, `.txt`, `.json`, `.yaml`, `.csv`,
  `.log`, and common source extensions) as plain text. Anything else offers a **Download** button.
- **Download** lives in the preview pane header, so open a file first. The tree rows themselves
  have no download control.

Layout inside the workspace:

```
workspace/
├── projects/                 # durable project files
└── bots/
    ├── <bot-slug>/
    │   └── memory/           # the Bot's memory files  (keyed by SLUG)
    └── <bot-uuid>/
        └── screenshots/      # browser screenshots     (keyed by ID)
```

> Note the inconsistency: memory directories are keyed by the Bot's **slug**, screenshots by its
> **UUID**. The same Bot therefore owns two sibling directories under different names.

The tab is read-only — it is for inspecting what Bots produced, not for editing. Paths are
validated server-side so a request cannot escape the workspace directory.

---

## 16. Usage

Open the **Usage** tab.

- **Three totals** across the top: input tokens, output tokens, and cache-read tokens.
- **By bot** — a bar per Bot, so you can see which one is expensive.
- **By day** — a column chart over time.
- **By model** — a bar per model with its percentage share.

Usage is recorded per turn from the SDK's reported token counts.

> Note that on a subscription these numbers are *consumption*, not a bill. They tell you which Bot
> is burning your quota, not what you owe.

---

## 17. Settings reference

Open the **Settings** tab. Changes save immediately — there is no Save button; a "Saving…"
indicator appears briefly. Each setting is saved individually without disturbing the others.

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| **Timezone** | IANA zone name | Your system zone | Default timezone for new routines. Routines each store their own zone; this is the fallback. |
| **Max concurrent sessions** | 1–8 | 2 | How many Bot turns run at once. Everything beyond this queues. Raise it for more parallelism at the cost of CPU and quota; lower it to keep your machine responsive. One Bot never runs two turns at once regardless. |
| **Auto-review** | on / off | on | Whether a `haiku` pass triages tool calls that no rule covers. On, routine low-risk calls proceed without bothering you. Off, **every** uncovered call becomes an approval — safer, far more interruptions. It can never override a require-rule either way. |
| **Theme** | System / Light / Dark | System | Interface appearance. System follows your OS. |
| **Local execution** | Ask / Always / Never | Ask | What happens when a tool call reaches outside the shared workspace — that is, touches your own machine. **Ask**: forces an approval, even past an allow-rule. **Always**: treats it like any other call. **Never**: denies it outright. Checked before rules, so a broad allow-rule cannot unlock it. See `docs/SECURITY.md` for what the Bash detection does and does not catch. |
| **Daily token budget** | integer, 0 = unlimited | 0 | ⚠️ **Not enforced.** Stored and displayed, but no code reads it. See [Known limitations](#22-known-limitations). |
| **Desktop notifications** | on / off | on | ⚠️ **Not enforced.** There is no OS notification integration; in-app toasts appear regardless. |
| **Billing mode** | Subscription / API (metered) | Subscription | **Subscription** strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the environment handed to every `claude` subprocess, so turns bill to your Claude login. **API** leaves them in place, and an ambient key means metered billing. Leave this on Subscription unless you specifically want to pay per token. |
| **Computer mode** | Host / Container | Host | ⚠️ **Not enforced.** The browser always runs on the host. |

---

## 18. Files, ports, and environment

### Data directory

Everything lives under `~/.ant-bot` (override with `ANTBOT_HOME`):

| Path | Contents |
| --- | --- |
| `antbot.db` | SQLite database — Bots, threads, messages, approvals, rules, routines, usage |
| `config.toml` | Server port and host, plus **first-run** setting defaults |
| `workspace/` | The shared workspace Bots work in |
| `skills/` | Skill plugin root: `.claude-plugin/` manifest plus `skills/<slug>/` per skill |
| `attachments/` | Uploaded files |
| `browser-profile/` | The shared Chromium profile — **contains logins** |
| `backups/` | Default destination for `antbot backup` |
| `logs/` | Daemon logs |

### Network

ant-bot binds to **127.0.0.1:4780** by default — localhost only. There is **no authentication**;
anything that can reach the port has full control, including the ability to run commands through a
Bot. Do not bind it to a public interface.

### Environment variables

| Variable | Effect |
| --- | --- |
| `ANTBOT_HOME` | Override the data directory (default `~/.ant-bot`) |
| `ANTBOT_PORT` | Override the listening port |
| `ANTBOT_LOG_LEVEL` | Daemon log verbosity |
| `ANTHROPIC_API_KEY` | Stripped from Bot subprocesses unless billing mode is `api` |

### config.toml

```toml
[server]
port = 4780
host = "127.0.0.1"

[settings]
timezone = "America/New_York"
maxConcurrentSessions = 2
# … every setting from section 17
```

Written on first run only. **The `[settings]` block is a first-run seed, not live configuration** —
it is copied into the database the first time the daemon starts with an empty settings table, and
the database is authoritative from then on. Editing `[settings]` afterwards has no effect, even
after a restart, and settings changed in the UI are never written back to this file. Only
`[server] port` and `[server] host` are re-read on every boot.

---

## 19. Backup and restore

```bash
antbot backup                              # → ~/.ant-bot/backups/antbot-backup-<timestamp>.tar.gz
antbot backup --out ~/Desktop/antbot.tar.gz
```

The archive contains your **database**, **config.toml**, **skills**, and each Bot's **memory**
directory. It deliberately **excludes** the browser profile (it holds live logins) and attachments
(bulky and reproducible).

```bash
antbot restore ~/Desktop/antbot.tar.gz
```

Restore prompts before overwriting; `--yes` skips the prompt. **Stop the daemon first** — restoring
over a running database is asking for trouble.

---

## 20. Limits

| Limit | Value |
| --- | --- |
| Bots and groups | 50 |
| Group members | 2–6 |
| Routines per Bot | 50 |
| Routine runs retained | 20 |
| Attachments per message | 6 |
| Attachment size | 25 MB (200 MB video) |
| Bot-to-bot hops | 5 |
| Approval timeout | 15 minutes |
| Max agent-loop turns per *turn* | 60 |
| Default concurrent sessions | 2 (configurable 1–8) |

Exceeding a limit returns a specific error code — `TOO_MANY_BOTS`, `GROUP_SIZE`,
`TOO_MANY_ROUTINES`, `TOO_MANY_ATTACHMENTS`, `ATTACHMENT_TOO_LARGE`, `HOP_LIMIT` — rather than
failing vaguely.

---

## 21. Troubleshooting

**`antbot status` says not running, but the UI works.** The PID file is stale. Status falls back to
the health endpoint, so trust the UI. `antbot restart` clears it.

**Connection dot is red.** The daemon stopped or restarted. Check `antbot status`, then
`~/.ant-bot/logs/`.

**A Bot is stuck on `waiting_approval`.** It is blocked on an approval. Open its thread and answer
the card. If more than 15 minutes have passed the approval expired and the Bot was told so.

**Every action asks for approval.** Either auto-review is off (Settings → Auto-review), or
`localExecution` is `ask` and the Bot is working outside the workspace. Check the approval's
reason text — it says which.

**A Bot cannot log into a site.** By design. Bots never handle passwords or 2FA codes. Use
takeover on the Computer tab. Note the headless limitation in
[Known limitations](#22-known-limitations).

**`antbot doctor` fails on better-sqlite3.** Run `pnpm rebuild better-sqlite3`.

**`antbot doctor` warns about Playwright Chromium.** Run `npx playwright install chromium`. Only
the Computer features need it.

**`antbot doctor` warns about `ANTHROPIC_API_KEY`.** Harmless — ant-bot strips it so turns bill to
your subscription. It matters only if you set billing mode to API.

**Port 4780 is in use.** `antbot start --port 4781`, or stop whatever holds it. Doctor
distinguishes "another antbot is running" from "an unrelated process holds this port".

**A routine did not fire.** Check it is Enabled, verify the cron expression and timezone, and open
the run history. If the daemon was stopped at the scheduled time, the run is missed, not deferred —
there is no catch-up.

**A Bot reports it could not get data instead of answering.** Working as intended. Routine prompts
instruct Bots to report a failure rather than fall back on stale data.

---

## 22. Known limitations

These are honest gaps in the current build, not things to work around.

### Stored secrets never reach a Bot

You can add a secret and a Bot can request one, but nothing injects it into the Bot's environment —
the overlay function that would do it is never called. A Bot therefore cannot use a stored secret
today. The keychain storage itself works; only delivery is missing.

### File cards are never emitted

`Cards.tsx` can render a file card with a download button, and the card type is part of the
schema, but no server code creates one. Files a Bot writes — including browser screenshots — are
findable only through the Workspace tab.

### Settings that do not do anything yet

Four settings appear in the UI and persist, but **no code reads them**:

- **Per-Bot "Mute notifications"** — the flag is stored on the Bot and read nowhere, so muting a
  Bot changes nothing.

- **Daily token budget** — no enforcement. Setting it to 50,000 does not cap anything. Use the
  Usage tab to watch consumption manually.
- **Desktop notifications** — no OS notification integration exists. In-app toasts appear whether
  this is on or off.
- **Computer mode** — the browser always runs on the host. There is no container mode.

Related: the `[settings]` block in `config.toml` is a first-run seed only. Editing it after the
first boot has no effect, and UI changes are never written back to it.

### Features with no interface

- **Group threads cannot be created from the UI.** They render and work fully once they exist, but
  creating one requires `POST /api/threads` with `kind: "group"` and 2–6 `memberBotIds`.
- **Skills cannot be authored or installed from the UI.** Use `antbot skill add <source>`, the
  `/api/skills/install` endpoint, or the project's `skills/` directory. Assigning existing skills
  to Bots does work in the UI.
- **Secrets have no screen.** Manage them with the API calls in [section 14](#14-secrets).
- **The update check is command-line only.** `antbot status`, `antbot doctor` and `antbot update`
  report a newer version; Settings does not. Surfacing it there needs an API endpoint, and the
  HTTP contract is frozen — see `docs/API-CONTRACT.md`.
- **A Bot's `request_secret` call is invisible.** The request reaches the browser and is stored in
  the client, but nothing renders it — so you will not be prompted. The Bot's message will mention
  it; supply the value with the API. (And per above, the value still will not reach the Bot.)

### Browser takeover is incomplete

The browser runs headless, and the screencast is view-only. Taking over correctly *blocks the Bot*
from acting on that page, but your clicks and keystrokes are not forwarded, so you cannot complete
the blocked step from within ant-bot.

### The away-guard never fires

The logic exists and is tested — pause routines after 14 days of inactivity, prompt between 7 and
14 — but nothing calls it in the running server. Routines keep firing indefinitely regardless of
how long you have been away.

### No URL routing

Screens are in-app state, not routes. You cannot bookmark or deep-link a screen, and a browser
refresh returns you to Chats.

### Single user, no authentication

There are no accounts and no login. Anyone who can reach port 4780 has full control. It binds to
localhost for exactly this reason.

### No mobile client

The web UI is responsive, but there is no native app and no push delivery.
