# Project skills

Any directory here containing a `SKILL.md` is installed into ant-bot automatically on every
start, and appears in the Skills list ready to assign to a Bot.

Use this when a skill belongs with the code it operates on — it gets reviewed, versioned and
branched alongside everything else in the repo.

```
skills/
└── my-skill/
    └── SKILL.md
```

`SKILL.md` is the standard Claude skill format: frontmatter with `name` and `description`,
followed by the body. See `docs/SKILLS.md` for the six-section shape ant-bot's own skills follow,
and `skills-examples/` for complete examples.

```markdown
---
name: my-skill
description: Use this when … (write it as a trigger, not a title — the model matches on it)
---

## When to use it
...
```

This directory is the source of truth for what it contains: edit a file, restart the daemon, and
the change is live. Skills installed from other sources (`antbot skill add …`) are untouched.

Supporting files — reference docs, templates, scripts — can sit alongside `SKILL.md` and are
copied with it. Anything executable is flagged when the skill is installed.
