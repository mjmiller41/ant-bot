---
name: "Inbox Digest"
description: "Produces a since-last-time digest of what changed across the connected inbox/channels, filtered to what actually needs attention, with a proposed next step for each item."
---

## When to use it

Use this skill for a recurring "what happened since I last looked" summary of an inbox, channel,
or notification stream — a chief-of-staff-style digest. Not for answering a specific one-off
question about a single message; this is for a periodic sweep.

## Required inputs and access

- Read access to the inbox/channel(s) to be swept (email, chat, notifications — whichever are
  connected).
- The "since" boundary: last digest's timestamp, or a stated window (e.g. "since yesterday").
- Optionally, a priorities/watch list to filter against — without one, use broad judgment but say
  so in the output.
- If a connected source cannot be reached, exclude it explicitly rather than silently omitting it.

## Sequence of work

1. Determine the time window: since the last successful digest, or the stated window.
2. Pull new items from every connected source for that window.
3. Filter out routine/low-signal noise; keep anything that plausibly needs a decision, a reply,
   or awareness of a change.
4. For each kept item: note the source, why it matters, and a proposed next step.
5. Group by urgency (needs a decision today / worth a look / FYI) rather than by source.
6. Note any source that was unreachable or partially loaded during this run.

## How to validate the result

- Every item must link back to its source message/thread — no paraphrase-only entries.
- The window covered must be stated explicitly (with time zone) at the top of the digest.
- If a source was unavailable, that must be listed under "Not checked this run" — **never present
  a digest as complete when a source was skipped.**
- Confirm nothing in the digest implies an action was already taken; this skill only observes.

## What to return

A digest with: the time window covered, items grouped by urgency, each item showing source link +
why it matters + proposed next step, and a "Not checked this run" section for any unreachable
source (present even if empty).

## What requires approval

- Replying to, archiving, or otherwise modifying anything in the inbox/channels — this skill only
  reads and reports.
- Sending the digest anywhere outside this conversation.
- Treating a proposed next step as done — every proposed step stays proposed until a human or a
  separate, explicitly-approved action executes it.
