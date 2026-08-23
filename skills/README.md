# Bundled skills

Every directory here containing a `SKILL.md` ships with ant-bot and is installed into your skills
directory (`~/.ant-bot/skills/skills/`) on every start, ready to assign to a Bot. Five skills ship
today — `bug-repro`, `deep-research`, `inbox-digest`, `skill-author` and `weekly-report` — and they
double as the worked examples in `docs/SKILLS.md`.

`SPEC.md` here is the Agent Skills specification. Every skill in this directory conforms to it, and
a test enforces that (`packages/server/src/skills/spec.test.ts`), so a non-conforming skill cannot
land. Check your own with:

```bash
antbot skill lint ./skills/my-skill   # one skill
antbot skill lint ./skills            # this directory
antbot skill lint                     # everything installed on this machine
```

The `skill-author` skill is the workflow for writing a new skill or repairing one — including the
behavioral inventory that keeps a rewrite from quietly dropping instructions.

Add one here when a skill belongs with the code it operates on: it gets reviewed, versioned and
branched alongside everything else in the repo, and it reaches every install on the next upgrade.

```
skills/
└── my-skill/
    └── SKILL.md
```

`SKILL.md` is the standard Claude skill format: frontmatter with `name` and `description`, followed
by the body. See `docs/SKILLS.md` for the six-section shape ant-bot's own skills follow, and read
`bug-repro`, `inbox-digest` and `weekly-report` before writing your first one — they are the
calibration for how specific each section should be. `name` must be lowercase letters, digits and
hyphens, and must match the directory name exactly; ant-bot hands frontmatter names to the SDK as
its enabled-skills filter, so a mismatch makes the skill silently unavailable rather than failing. (`deep-research` is a published-style skill
that deliberately does not follow that shape; `docs/SKILLS.md` says why.)

```markdown
---
name: my-skill
description: Use this when … (write it as a trigger, not a title — the model matches on it)
---

## When to use it
...
```

Supporting files — reference docs, templates, scripts — can sit alongside `SKILL.md` and are copied
with it. Anything executable is flagged when the skill is installed.

## Your copy versus ours

A bundled skill has two owners, so the sync is not a plain copy. ant-bot records a hash of what it
wrote in `~/.ant-bot/skills/skills/.managed.json` and compares against it on the next boot:

| Your copy | What happens on the next start |
|---|---|
| Never installed | It gets installed |
| Untouched since ant-bot wrote it | It is refreshed when the shipped version changes |
| Edited by you | Left alone — your edits survive upgrades |
| Deleted by you | Stays deleted |
| Same slug, installed from elsewhere | Left alone; ant-bot never claims a skill it did not write |

Two consequences worth knowing. Editing your installed copy of a bundled skill *forks* it — it will
never pick up upstream changes again; edit the file in this directory instead if you want both. And
a contributor's loop still works exactly as before: change a file here, restart the daemon, and the
change is live, because the installed copy is untouched and therefore refreshed.

Skills installed from other sources (`antbot skill add …`) are never affected by any of this.
