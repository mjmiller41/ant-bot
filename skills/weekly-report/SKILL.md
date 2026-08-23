---
name: weekly-report
description: "Builds a Monday-morning status report from the current account/project data and posts it as a linked, reviewable document."
---

## When to use it

Use this skill when asked for a recurring or one-off status report that summarizes the current
state of a set of accounts, projects, or metrics for a stakeholder audience — e.g. "give me this
week's report" or a Monday-8am routine. Not for ad-hoc one-line answers; this is for a structured,
shareable document.

## Required inputs and access

- The source system(s) that hold the data being reported on (read-only access is enough).
- The list or filter defining scope (e.g. "accounts owned by X", "projects tagged Q3").
- The report destination: this conversation, or a specific `/workspace` folder.
- If any required source is not connected or not reachable, say so explicitly rather than
  guessing at scope.

## Sequence of work

1. Confirm the reporting window (default: since last Monday) and the scope filter.
2. Pull current data from the source system(s) — do not reuse a previous report's numbers.
3. Group findings under clear headings (e.g. Highlights, Risks, Needs a decision, Metrics).
4. For every claim, attach a source link, a screenshot, or a direct quote — no unsourced claims.
5. Draft the report as a markdown file in `/workspace/reports/<date>-weekly-report.md`.
6. Re-read the draft once for internal consistency before returning it.

## How to validate the result

- Every number and claim in the report must trace to a source pulled in this same run.
- If a source system was unreachable or a data pull failed partway through, the report must say
  so explicitly in a "Could not verify" section — **never fill a gap with last week's numbers.**
- Check that the reporting window and scope match what was requested.

## What to return

A single markdown report with: a one-paragraph summary, findings grouped under headings with
source links, a "Could not verify" section (even if empty, say so), and the exact time window
covered. Post the file as a card in the conversation; do not create a second copy on a re-run —
overwrite/version the same report file for that period.

## What requires approval

- Sending the report to anyone outside this conversation (email, Slack, or any other channel).
- Publishing the report anywhere public-facing.
- Any change to the underlying source systems — this skill is read-only and reports; it never
  edits records, tickets, or budgets on your behalf.
