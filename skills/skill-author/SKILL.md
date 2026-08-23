---
name: skill-author
description: "Writes a new skill, or brings an existing one up to the Agent Skills spec, without losing any of what it already told the model to do. Use when asked to add, author, fix, lint, or rewrite a SKILL.md, when `antbot skill lint` reports violations, or when an installed skill is malformed."
---

## When to use it

Use this skill for any work on a skill file itself — writing a new one, repairing one the linter
rejects, or rewriting one that was installed from somewhere else and does not fit the spec. Not for
*using* a skill, and not for deciding which bot should have one; this is about the file.

The spec is `skills/SPEC.md` in the ant-bot repo. The linter is `antbot skill lint`. Between them
they decide whether the work is done — not your judgment about whether the file looks fine.

## Required inputs and access

- The skill directory to write or repair, and write access to it.
- `antbot skill lint <path>`, which needs no running daemon.
- For a rewrite: the **current** contents of the file, read in full before any edit. A rewrite
  driven by a summary of the file loses whatever the summary left out.
- If the skill references files it does not ship (`references/…`, `scripts/…`, `assets/…`), the
  source it was copied from. If that source cannot be found, say so — do not invent the missing
  files or quietly delete the references to them.

## Sequence of work

**Always, before editing anything: take the behavioral inventory.** Read the whole file and list
every item it contains under these headings. This list is the contract the rewrite has to honor.

1. Every instruction that changes what the model does.
2. Every prohibition — the "never", "do not", "stop and report instead" clauses.
3. Every approval boundary.
4. Every stated output requirement or format.
5. Every referenced file, command, tool, or external system.
6. Every failure-mode rule (what to do when a source is unreachable, a step fails, data is stale).

**Then, for a new skill:**

1. Pick a directory name that is lowercase letters, digits and hyphens only — no leading, trailing
   or doubled hyphens, 64 characters or fewer.
2. Write frontmatter whose `name` is *exactly* that directory name. This is not cosmetic: ant-bot
   passes frontmatter names to the SDK as the enabled-skills filter, so a mismatch makes the skill
   silently unavailable rather than failing loudly.
3. Write a `description` that says both what the skill does and when to reach for it, in under
   1024 characters, front-loading the words a model would match on. "Helps with PDFs" is a
   non-answer; name the triggers.
4. Write the body in the six sections below.
5. Put anything long or occasionally-needed in `references/`, scripts in `scripts/`, templates in
   `assets/`. Keep SKILL.md itself under 500 lines — the whole file enters context the moment the
   skill activates, while those directories are read only when needed.
6. Ship every file you reference. A dangling reference is worse than no reference: the model is
   told to go read something that is not there.

**Or, for a rewrite:** make the smallest change that clears the violation.

1. Run `antbot skill lint <path>` first and fix what it names, one violation at a time.
2. A frontmatter fix is a frontmatter fix — do not "improve" the body while you are in there.
3. If the body genuinely must change (it is over length, or it instructs the model to use tooling
   this environment does not have), move content rather than deleting it: into `references/`, or
   into a rephrasing that keeps the same instruction. Deleting a section is a decision to report,
   not a cleanup.
4. If a skill names commands or agents from another product, replace them with what this
   environment can actually do, keeping the step's purpose intact. Do not leave a dead command
   name in place, and do not drop the step.

## How to validate the result

- `antbot skill lint <path>` exits 0. Warnings are allowed but must be deliberate; errors are not.
- Walk the behavioral inventory item by item against the new file. Every item is either still
  present, or listed in what you return as a deliberate removal with a reason. There is no third
  category — an item you cannot find is a regression, not an oversight.
- Every referenced file exists at the path given.
- `name` matches the directory name character for character.
- The description would make *you* pick this skill out of a list of thirty, knowing only the
  descriptions.

## What to return

The path to the skill, the linter output, and a short list of what changed. For a rewrite, include
the behavioral inventory check: what was preserved, what moved where, and anything deliberately
dropped with the reason. If a referenced file could not be recovered, say that plainly rather than
reporting success.

## What requires approval

- Deleting any instruction, prohibition, approval boundary, or output requirement from an existing
  skill — even one that looks redundant. Propose it, do not do it.
- Removing a skill, or renaming its directory. A rename changes the slug bots are assigned by.
- Vendoring reference files from a third-party source into this repository — that is a licensing
  decision, not a technical one.
- Editing a skill that is installed in the user's data directory rather than in the project's
  `skills/` directory. Those are the user's own copies; ant-bot deliberately never overwrites them.
