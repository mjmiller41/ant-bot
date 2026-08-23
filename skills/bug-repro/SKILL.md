---
name: bug-repro
description: "Turns a raw bug report into a reliable repro pack: exact steps, expected vs. actual, evidence, and a minimal test case, on a fresh test account in staging."
---

## When to use it

Use this skill when handed a bug report (from a ticket, a message, or a user complaint) that
needs to become something an engineer can act on immediately, without first having to reproduce
it themselves. Not for triaging severity or deciding priority — just for turning "it's broken"
into "here's exactly how, and here's proof."

## Required inputs and access

- The original bug report text, ticket link, or user message.
- Access to a **staging** environment and a **fresh test account** — never a production account
  or real customer data.
- Browser and network-inspection tools for evidence capture.
- If staging is unavailable or the bug depends on production-only data, stop and report that
  instead of attempting the repro against production.

## Sequence of work

1. Read the report and write down what you believe is being claimed: expected vs. actual.
2. Create or reuse a fresh test account in staging — never reuse a production/customer login.
3. Attempt the exact steps described, in order, capturing a screenshot and the browser
   console/network log at each meaningful step.
4. If the first attempt doesn't reproduce it, vary one variable at a time (browser, account
   state, timing) and note what changed.
5. Once reproduced, strip the steps down to the smallest sequence that still triggers it.
6. If it does not reproduce after reasonable attempts, say so plainly — do not force a result.

## How to validate the result

- The repro steps must be re-runnable by someone else from a fresh test account, using only what
  is written down.
- Expected vs. actual must be stated in one sentence each, unambiguously.
- Every step must have supporting evidence (screenshot, console/network excerpt) attached.
- If the bug turns out to be data-dependent on production, that is itself a finding — report it,
  do not attempt to pull real production data to compensate.

## What to return

A repro pack containing: exact numbered steps, expected result, actual result, screenshots per
step, relevant console/network excerpts, browser/OS versions used, the minimal test case, and (if
reproduction failed) a clear statement of what was tried and what is still unknown.

## What requires approval

- Touching any production environment or any real customer account or data — always stay in
  staging with a fresh test account.
- Filing or closing the ticket on the reporter's behalf, unless explicitly asked to.
- Sharing the repro pack anywhere outside the originating ticket/conversation.
