# Authoring skills

> **Installing an existing skill?** You don't need this document. Run
> `antbot skill add <source>` — a GitHub repo (`anthropics/skills`), a git URL, a local path, or a
> link to a `SKILL.md`. ant-bot uses the standard Claude skill format, so published skills work
> unmodified. See §10 of `docs/USER-GUIDE.md`. This document is about *writing* one.

A **skill** is a reusable, written-down way of doing a task — the *how*, not the schedule. A
**routine** is what assigns a skill (or any instruction) to one Bot and a schedule; see the
Scheduler section of `docs/API-CONTRACT.md` / the Routines panel in the UI for that half. This
document is about writing and installing the skill itself.

## The six-section shape

Every skill body follows the same six sections, in this order (`SKILL_TEMPLATE` in
`daemon/src/skills/skills.ts`):

1. **When to use it** — the trigger. What request or situation should make a Bot reach for this
   skill instead of improvising? Specific enough that a Bot with the skill enabled recognizes the
   moment.
2. **Required inputs and access** — what the skill needs before it can run: source systems,
   connectors/MCP servers, files, credentials, or information the user must supply. State what
   happens if something required is missing.
3. **Sequence of work** — the ordered steps. Prefer "gather → draft/reconcile → recommend" over
   "act immediately" — automate preparation before execution.
4. **How to validate the result** — how the Bot should check its own output before returning it:
   what to cross-check, what counts as "current" data, and the stale-data policy. The convention
   used throughout this project: **if the source data is unavailable, report the failure instead
   of using old data** — never silently substitute a stale number.
5. **What to return** — the shape of the deliverable: a document, a spreadsheet, a draft message, a
   linked watch list, or a recommendation with evidence. Where relevant, separate facts found,
   assumptions, actions already taken, actions waiting for approval, and open questions.
6. **What requires approval** — the actions this skill must never take without an explicit human
   go-ahead: sending, publishing, purchasing, deleting, overwriting, or any production change. This
   section should never be empty; every skill has an approval boundary. (Note that naming an action
   here is a documentation convention for the model to follow — the thing that actually blocks the
   action is a `require` rule in the Permission Gateway; see `docs/SECURITY.md`. A skill's "what
   requires approval" section and the rules engine are complementary, not the same mechanism.)

## On-disk format

A skill is a directory containing one file, `SKILL.md`, under the skills directory
(`~/.ant-bot/skills/skills/<slug>/SKILL.md`). The extra level is not a typo: `paths.skills`
(`daemon/src/config/paths.ts`) is the root of a **local plugin** — it holds a generated
`.claude-plugin/plugin.json` and a `skills/` subdirectory of actual skills. Loading skills as a
plugin is what gives Bots the agent SDK's real `Skill` tool rather than a list of paths to read.
A skill can also live in the ant-bot project's own `skills/` directory, which is installed on
every boot; see `skills/README.md`. The file is YAML-ish frontmatter followed by the markdown
body, parsed by `parseFrontmatter()` in `daemon/src/skills/skills.ts`:

```markdown
---
name: "Weekly Report"
description: "Builds a Monday-morning status report from current data and posts it as a linked, reviewable document."
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

Frontmatter is intentionally simple — just `name:` and `description:` as quoted strings between
`---` markers (the parser is a small line-based scanner, not a general YAML parser: don't nest
structures in it). Everything after the closing `---` is the markdown body.

Three ways a skill ends up registered in the database (`skills` table) and pointed at that
directory:

- **Written through the app** — a Bot (or you) calls the skill-writing path, which slugifies the
  name, creates `<skillsDir>/<slug>/`, writes `SKILL.md`, and inserts the `skills` row
  (`SkillStore.writeSkill`). The `source` field records `user | taught | imported`.
- **Dropped in by hand** — create `~/.ant-bot/skills/<your-slug>/SKILL.md` yourself with any text
  editor and restart the daemon (or trigger a rescan). `SkillStore.syncFromDisk()` walks the
  skills directory at boot, and registers any directory containing a `SKILL.md` that isn't already
  known, using the frontmatter `name`/`description` (falling back to the slug if `name` is
  missing). This is the easiest way to hand-author a skill without going through the UI.
- **Bundled with ant-bot** — `syncBundledSkills()` installs everything in the project's `skills/`
  directory on every boot, and refreshes each one when a new ant-bot version changes it. It records
  a hash of what it wrote in `<skills dir>/.managed.json` and compares against it first, so a skill
  you have edited is never overwritten, one you deleted is never resurrected, and a same-named skill
  installed from elsewhere is never claimed. See `skills/README.md` for the full table.

Deleting a skill (`SkillStore.deleteSkill`) removes both the directory and the database row; it
refuses to touch any path that resolves outside the skills directory, so a corrupted or maliciously
crafted `path` value can't be used to delete something else on disk.

## Enabling a skill per bot

Skills are account-wide, but each Bot only gets the skills explicitly enabled for it — enabling a
skill for one Bot does not enable it for others. The enable/disable relationship is the
`bot_skills` join table, set via:

```
GET /api/bots/:id/skills   → Skill[]              (enabled for this bot)
PUT /api/bots/:id/skills   { skillIds: string[] }  → replaces the enabled set
```

In the UI this is the skills section of Bot Settings. Only a Bot's enabled skills are injected
into its system prompt (`buildSystemPrompt()` in `daemon/src/bots/prompt.ts`, driven by
`store.listBotSkills(bot.id)`):

```
## Your skills
- **Weekly Report** (weekly-report): Builds a Monday-morning status report...
Read the skill file before following it.
```

A Bot is only told the skill's *name and description* up front, not the full body — the prompt
tells it to read the skill file before following it, so the six-section body is available to it as
a file, not pre-loaded into every turn's context.

## Referencing a skill with `/`

Typing `/` at the start of a message in the composer opens a picker over the current skill list
(matched by slug or name), and selecting one inserts `/<slug> ` into the message
(`ui/src/components/Composer.tsx`). This is purely a convenience for naming the skill
you want used in your instruction to the Bot — it is client-side text insertion, not a structured
token the server resolves specially. The picker lists every skill known to the account, not only
the ones enabled for the Bot you're messaging; if you reference a skill the Bot doesn't have
enabled, it won't appear in that Bot's "Your skills" list and the Bot has no particular reason to
know it exists. **Enable a skill on the Bot first** (Bot Settings), then reference it with `/` in
the message.

## The graduated-automation doctrine

Skills exist to capture something that's already been proven to work, not to shortcut getting
there. The intended progression, in order:

1. **One-time task** — ask the Bot directly, watch what it does, correct it.
2. **Reliable** — run it again with a different real input until the result needs no correction.
3. **Skill** — write down the six sections above from what actually worked, including the failure
   handling and approval boundary you discovered along the way.
4. **Tested** — run it once more against a fresh input using the skill file, specifically checking
   whether it selected current data, matched the expected output shape, and stopped at the
   approval boundary you wrote.
5. **Routine** — only now attach it to a schedule (or a manual routine you fire on demand). A
   routine's test run performs real work — treat it like a live run.

Do not skip from step 1 straight to a routine. A skill that has never been tested on a second
input, and a routine built on top of it, will fail in whatever way the first input happened not to
exercise.

## Worked example

Say you keep manually pulling the same weekly numbers into a status update. Here's what graduating
that into a skill looks like end to end.

**1–2. One-time task, made reliable.** You ask a Bot: *"Pull this week's signups and churn from
the dashboard and write me a two-paragraph summary."* You correct it twice — once because it used
last week's cached numbers, once because it didn't say where the numbers came from — until it
reliably produces something you'd actually send.

**3. Save as a skill.** Drop this at `~/.ant-bot/skills/weekly-numbers/SKILL.md` (or have the Bot
write it and review it):

```markdown
---
name: "Weekly Numbers Summary"
description: "Pulls this week's signup and churn numbers and writes a two-paragraph summary with sources."
---

## When to use it

Use when asked for this week's signup/churn numbers or a short status update built from them —
not for a full report (see the Weekly Report skill for that), just the two-paragraph version.

## Required inputs and access

- Read access to the analytics dashboard for signups and churn.
- The reporting window (default: current week to date).
- If the dashboard is unreachable, say so — do not estimate from memory.

## Sequence of work

1. Confirm the window (default: Monday to now, current week).
2. Pull signups and churn directly from the dashboard for that window — never reuse a cached or
   previous week's number.
3. Write two paragraphs: one on signups, one on churn, each citing the dashboard view/link used.

## How to validate the result

- Every number must have been pulled in this run, not recalled from a prior turn or memory file.
- If the dashboard did not load or a metric was missing, say exactly which one and why, instead of
  omitting it silently or estimating.

## What to return

Two short paragraphs, plain text, each ending with a source link or dashboard view name. No
headers needed for something this short.

## What requires approval

- Sending this summary anywhere outside this conversation.
- Nothing else — this skill only reads and reports.
```

**4. Test.** Enable it on the Bot (Bot Settings → skills), then reference it explicitly:
*"/weekly-numbers"*, run it once more, and check that it actually re-pulled fresh numbers rather
than reusing the ones from your correction runs, and that it cited a source for each.

**5. Automate.** Once satisfied, create a routine on that Bot: *"Every Monday at 8am, run the
Weekly Numbers Summary skill and post it here."* The routine's cron field maps to `0 8 * * 1` in
your Bot's timezone; run its **Test run** once (this performs real work) before trusting the
schedule.

## The real examples in this repo

`skills/` ships five complete, non-toy skills, installed into every ant-bot. Three follow this
exact shape:

- **`skills/weekly-report/SKILL.md`** — builds a Monday-morning status report from
  current account/project data, with a mandatory "Could not verify" section and a rule against
  ever filling a data gap with a previous report's numbers.
- **`skills/bug-repro/SKILL.md`** — turns a raw bug report into a reliable repro pack on a
  fresh staging test account: numbered steps, expected vs. actual, screenshots, a minimal test
  case — with production data explicitly off-limits.
- **`skills/inbox-digest/SKILL.md`** — see the file directly for its exact shape; it
  follows the same six sections as the others.

Read those three before writing your first skill — they're the calibration for how specific each
section should be.

**`skills/deep-research/SKILL.md`** also ships, and deliberately does *not* follow the six-section
shape: it is a published-style skill built around a lead agent delegating to subagents, with a
citation registry, source-type governance and a mandatory counter-review pass. Read it as the
example of what an installed third-party skill looks like, not as the house style.

**`skills/skill-author/SKILL.md`** is the skill for working on skills — writing a new one, or
bringing an existing one up to the spec without losing what it already said. Reach for it (or read
it yourself) before hand-editing any SKILL.md.

## Conforming to the Agent Skills spec

`skills/SPEC.md` is the Agent Skills specification, and everything ant-bot ships conforms to it.
The parts that bite in practice:

| Rule | Why it matters here |
| --- | --- |
| `name` is lowercase letters, digits and hyphens, 1–64 chars, no leading/trailing/doubled hyphen | Anything else is rejected by conforming tooling |
| `name` matches the skill's directory name exactly | **Load-bearing.** `manager.ts` passes frontmatter names to the SDK as `enabledSkills`; a mismatch makes the skill silently unavailable to every bot that has it enabled |
| `description` is non-empty, ≤ 1024 characters, and says both what and when | It is all the model sees when deciding whether to reach for the skill |
| Every referenced `references/`, `scripts/` or `assets/` path actually ships | A dangling reference tells the model to read something that is not there — it loads fine and fails silently |
| `SKILL.md` stays under 500 lines | The whole file enters context on activation; detail belongs in `references/` |

Optional fields are `license`, `compatibility`, `metadata` (a string→string map) and the
experimental `allowed-tools`. Anything else in the frontmatter belongs under `metadata`.

Check any skill against all of it — no daemon required:

```bash
antbot skill lint                       # every skill installed on this machine
antbot skill lint ./skills              # a directory of skills
antbot skill lint ./skills/my-skill     # one skill you are still writing
```

Errors exit 1; warnings exit 0 and are printed. Installing a skill runs the same check and prints
any violations in the install manifest — a non-conforming skill still installs, because a
third-party skill with a sloppy frontmatter usually still works, but you are told.

Two enforcement points keep this from rotting: `spec.test.ts` validates every skill in `skills/`
as part of `pnpm test`, and `validateSkillDir()` runs on every install.
